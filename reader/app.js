/* hbook — the reader app.
 *
 * Six things, and nothing else:
 *   漫画库 · 书库 · 最新更新 · 热门排行 · 搜索 · 历史记录
 *
 * No account, no login. The history is the browser's own storage, and the 18+ switch is a checkbox
 * the reader flips for themselves.
 */

'use strict';

const $ = (sel) => document.querySelector(sel);
const view = $('#view');

const state = {
  kind: 'manga',
  // On unless the reader turns it off. This is a personal server whose owner asked for the adult
  // material to be reachable, and the switch is right there in the header to turn it off.
  adult: localStorage.getItem('reader.adult') !== '0',
  // Which language the manga shelves are in. Chinese, because the reader asked for Chinese: the
  // sites publish every language side by side, so without saying which one, the biggest wins --
  // and the biggest is English.
  lang: localStorage.getItem('reader.lang') || 'zh',
  history: JSON.parse(localStorage.getItem('reader.history') || '[]'),
};

/* ------------------------------------------------------------------ helpers */

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 2600);
}

/** Every call carries the 18+ switch, so the server is asked for the same thing the screen shows.
 *
 * It is always sent, explicitly. The server treats a MISSING `adult` as "yes", so a reader who turned
 * the switch OFF would still be served the adult sources -- the request that means "no" has to be said
 * out loud, not left out. */
async function api(path, params = {}) {
  const url = new URL(path, location.origin);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  url.searchParams.set('adult', state.adult ? '1' : '0');
  url.searchParams.set('lang', state.lang);
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).error || detail; } catch { /* not JSON */ }
    throw new Error(detail);
  }
  return res.json();
}

/** A cover, fetched through the server (the source's own servers refuse hot links).
 *
 * The source is part of the request: MangaDex's CDN answers 403 unless the request names it as the
 * referer, and the referer is a property of the source, not of the picture. Without it, every cover
 * was a blank box. */
function coverUrl(url, source) {
  if (!url) return '';
  const q = `u=${encodeURIComponent(url)}`;
  return source ? `/api/reader/img?${q}&source=${encodeURIComponent(source)}` : `/api/reader/img?${q}`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function remember(entry) {
  const key = `${entry.kind}:${entry.source}:${entry.id}`;
  state.history = [entry, ...state.history.filter((h) => `${h.kind}:${h.source}:${h.id}` !== key)]
    .slice(0, 60);
  localStorage.setItem('reader.history', JSON.stringify(state.history));
}

/* ------------------------------------------------------------------ rendering */

function card(hit) {
  const cover = hit.coverUrl
    ? `<img loading="lazy" src="${esc(coverUrl(hit.coverUrl, hit.source))}" alt="" onerror="this.remove()">`
    : `<span class="ph">${esc((hit.title || '').slice(0, 14))}</span>`;
  const badge = hit.isNsfw ? '<span class="badge">18+</span>' : '';
  const meta = hit.kind === 'manga'
    ? (hit.author || hit.sourceName || '')
    : [hit.author, hit.sourceName].filter(Boolean).join(' · ');
  return `<div class="card" data-kind="${hit.kind}" data-source="${esc(hit.source)}" data-id="${esc(hit.id)}"
               data-url="${esc(hit.url || '')}" data-title="${esc(hit.title)}">
    <div class="thumb">${cover}${badge}<span class="badge src">${esc(hit.sourceName || '')}</span></div>
    <div class="t">${esc(hit.title)}</div>
    <div class="m">${esc(meta)}</div>
  </div>`;
}

function grid(hits) {
  if (!hits.length) return '<div class="empty">没有结果</div>';
  return `<div class="grid">${hits.map(card).join('')}</div>`;
}

function rows(hits) {
  if (!hits.length) return '<div class="empty">还没有记录</div>';
  return hits.map((h) => `<div class="row" data-kind="${h.kind}" data-source="${esc(h.source)}"
      data-id="${esc(h.id)}" data-url="${esc(h.url || '')}" data-title="${esc(h.title)}">
    <div class="cover">${h.coverUrl ? `<img loading="lazy" src="${esc(coverUrl(h.coverUrl, h.source))}" alt="" onerror="this.remove()">` : ''}</div>
    <div class="info">
      <div class="t">${esc(h.title)}</div>
      <div class="m">${esc([h.author, h.sourceName].filter(Boolean).join(' · '))}</div>
    </div>
  </div>`).join('');
}

/* ------------------------------------------------------------------ views */

/**
 * Keep asking while the server says there is more to come.
 *
 * A shelf is collected, not answered: the server asks every source in the background and the page
 * shows what has come in so far. Asking again a few seconds later shows the rest, and stops when
 * the server says the pass is done.
 *
 * `redraw` puts the new books on the page -- the home page has two shelves and a shelf page has
 * one, and each knows how to draw itself.
 */
let shelfTimer = null;

function keepShelfFresh(shelves, redraw) {
  clearTimeout(shelfTimer);
  const pending = shelves.filter((s) => s && s.pending);
  if (!pending.length) return;
  // Not more than a few times: the server's own pass is what is slow, and asking it again and
  // again does not make it faster. Twenty times over a minute is enough for a pass that collects
  // a few hundred books.
  let tries = 0;
  const again = async () => {
    if (tries++ >= 40) return;
    await new Promise((go) => setTimeout(go, 3000));
    const fresh = await Promise.all(
      pending.map((s) => api('/api/reader/manga/browse', { sort: s.sort }).catch(() => null)),
    );
    const alive = fresh.filter(Boolean);
    if (!alive.length) return;
    redraw(alive);
    keepShelfFresh(alive, redraw);
  };
  shelfTimer = setTimeout(again, 3000);
}

async function showHome() {
  view.innerHTML = '<div class="loading">载入中…</div>';
  const [latest, popular, shelves] = await Promise.all([
    api('/api/reader/manga/browse', { sort: 'latest' }).catch(() => ({ hits: [] })),
    api('/api/reader/manga/browse', { sort: 'popular' }).catch(() => ({ hits: [] })),
    api('/api/reader/novel/explore').catch(() => ({ shelves: [] })),
  ]);
  view.innerHTML = `
    <h2 class="section">最新更新${count(latest)}</h2>
    ${grid(latest.hits.slice(0, 24))}
    <h2 class="section">热门排行${count(popular)}</h2>
    ${grid(popular.hits.slice(0, 24))}
    <h2 class="section">书库</h2>
    ${shelves.shelves.length ? shelves.shelves.slice(0, 4).map((s) => `
      <div class="shelf">
        <h3>${esc(s.sourceName)}</h3>
        <div class="chips">${s.categories.slice(0, 10).map((c) =>
          `<span class="chip" data-source="${esc(s.source)}" data-url="${esc(c.url)}">${esc(c.title)}</span>`).join('')}</div>
      </div>`).join('') : '<div class="empty">还没有书库分类</div>'}
  `;
  // The shelves are still being filled: the server asks every source in the background, and the
  // page asks again a moment later to show what has come in since.
  keepShelfFresh([latest, popular], ([l, p]) => {
    view.innerHTML = `
      <h2 class="section">最新更新${count(l)}</h2>
      ${grid((l?.hits || []).slice(0, 24))}
      <h2 class="section">热门排行${count(p)}</h2>
      ${grid((p?.hits || []).slice(0, 24))}
      <h2 class="section">书库</h2>
      ${shelves.shelves.length ? shelves.shelves.slice(0, 4).map((s) => `
        <div class="shelf">
          <h3>${esc(s.sourceName)}</h3>
          <div class="chips">${s.categories.slice(0, 10).map((c) =>
            `<span class="chip" data-source="${esc(s.source)}" data-url="${esc(c.url)}">${esc(c.title)}</span>`).join('')}</div>
        </div>`).join('') : '<div class="empty">还没有书库分类</div>'}
    `;
  });
}

/** How many books a shelf holds, and whether more are still coming. */
function count(shelf) {
  const n = (shelf && shelf.hits && shelf.hits.length) || 0;
  if (!n) return '';
  return ` <span class="count">${n} 部${shelf.pending ? '，还在增加…' : ''}</span>`;
}

async function showManga() {
  view.innerHTML = '<div class="loading">载入中…</div>';
  const data = await api('/api/reader/manga/browse', { sort: 'latest' });
  view.innerHTML = `<h2 class="section">漫画库 · 最新更新${count(data)}</h2>${grid(data.hits)}`;
  keepShelfFresh([data], ([d]) => {
    view.innerHTML = `<h2 class="section">漫画库 · 最新更新${count(d)}</h2>${grid(d?.hits || [])}`;
  });
}

async function showNovels() {
  view.innerHTML = '<div class="loading">载入中…</div>';
  const data = await api('/api/reader/novel/explore');
  if (!data.shelves.length) {
    view.innerHTML = '<div class="empty">书库还没有分类。用搜索找一本书吧。</div>';
    return;
  }
  view.innerHTML = data.shelves.map((s) => `
    <div class="shelf">
      <h3>${esc(s.sourceName)}</h3>
      <div class="chips">${s.categories.map((c) =>
        `<span class="chip" data-source="${esc(s.source)}" data-url="${esc(c.url)}">${esc(c.title)}</span>`).join('')}</div>
    </div>`).join('');
}

async function showBrowse(sort) {
  view.innerHTML = '<div class="loading">载入中…</div>';
  const data = await api('/api/reader/manga/browse', { sort });
  const title = sort === 'latest' ? '最新更新' : '热门排行';
  view.innerHTML = `<h2 class="section">${title}${count(data)}</h2>${grid(data.hits)}`;
  keepShelfFresh([data], ([d]) => {
    view.innerHTML = `<h2 class="section">${title}${count(d)}</h2>${grid(d?.hits || [])}`;
  });
}

async function showSearch(query, kind) {
  view.innerHTML = '<div class="loading">搜索中…</div>';
  const data = await api('/api/reader/search', { q: query, kind, limit: 60 });
  // The server reads the query for a title and, maybe, an author ("帝尊 作者：宅猪"), and says what
  // it read. Showing that back is the difference between "the app understood me" and "why did it
  // ignore what I typed".
  const parsed = data.query || {};
  const bits = [];
  if (parsed.title) bits.push(`“${parsed.title}”`);
  if (parsed.author) bits.push(`作者：${parsed.author}`);
  const notes = [];
  if (data.partial) notes.push('只搜了一部分来源');
  if (data.errors && data.errors.length) notes.push(`${data.errors.length} 个来源出错`);
  const note = notes.length
    ? `<div class="empty" style="padding:12px 0">${esc(notes.join(' · '))}</div>` : '';
  view.innerHTML = `<h2 class="section">${esc(bits.join(' · '))} · ${kind === 'manga' ? '漫画' : '小说'} (${data.hits.length})</h2>${note}${grid(data.hits)}`;
}

function showHistory() {
  const list = state.history;
  view.innerHTML = `<h2 class="section">历史记录 (${list.length})</h2>` + (
    list.length
      ? rows(list) + '<div style="margin-top:14px"><button class="ghost" id="clear-history">清空历史</button></div>'
      : '<div class="empty">还没有读过什么</div>'
  );
  const clear = $('#clear-history');
  if (clear) clear.onclick = () => {
    state.history = [];
    localStorage.removeItem('reader.history');
    showHistory();
  };
}

/* ------------------------------------------------------------------ a book, and reading it */

async function openBook(kind, source, id) {
  view.innerHTML = '<div class="loading">载入中…</div>';
  try {
    if (kind === 'manga') {
      const book = await api('/api/reader/manga/book', { source, id });
      remember({ kind, source, id, title: book.title, author: book.author, sourceName: book.sourceName, coverUrl: book.coverUrl });
      view.innerHTML = `
        <h2 class="section">${esc(book.title)}</h2>
        <div class="row" style="cursor:default">
          <div class="cover">${book.coverUrl ? `<img src="${esc(coverUrl(book.coverUrl, source))}" alt="">` : ''}</div>
          <div class="info">
            <div class="t">${esc(book.title)}</div>
            <div class="m">${esc([book.author, book.sourceName].filter(Boolean).join(' · '))}</div>
            ${book.intro ? `<div class="m">${esc(String(book.intro).slice(0, 300))}</div>` : ''}
          </div>
        </div>
        <h2 class="section">章节 (${book.chapters.length})</h2>
        <div class="chapters" data-kind="manga" data-source="${esc(source)}">${book.chapters.map((c) =>
          `<a data-source="${esc(source)}" data-id="${esc(c.id)}" data-title="${esc(c.title)}">${esc(c.title)}</a>`).join('')}</div>`;
      return;
    }

    const book = await api('/api/reader/novel/book', { source, id });
    remember({ kind, source, id, title: book.title, author: book.author, sourceName: book.sourceName, coverUrl: book.coverUrl });
    view.innerHTML = `
      <h2 class="section">${esc(book.title)}</h2>
      <div class="row" style="cursor:default">
        <div class="cover">${book.coverUrl ? `<img src="${esc(coverUrl(book.coverUrl, source))}" alt="">` : ''}</div>
        <div class="info">
          <div class="t">${esc(book.title)}</div>
          <div class="m">${esc([book.author, book.sourceName].filter(Boolean).join(' · '))}</div>
          ${book.intro ? `<div class="m">${esc(String(book.intro).slice(0, 400))}</div>` : ''}
        </div>
      </div>
      <h2 class="section">目录 (${book.chapters.length})</h2>
      <div class="chapters" data-kind="novel" data-source="${esc(source)}">${book.chapters.map((c) =>
        `<a data-source="${esc(source)}" data-id="${esc(c.id)}" data-title="${esc(c.title)}">${esc(c.title)}</a>`).join('')}</div>`;
  } catch (err) {
    view.innerHTML = `<div class="empty">打不开：${esc(err.message)}</div>`;
  }
}

/* ------------------------------------------------------------------ the reader */

const reader = {
  kind: null, source: null, chapters: [], index: 0, size: 19,
};

async function openChapter(kind, source, id, title) {
  $('#reader').hidden = false;
  $('#r-title').textContent = title || '';
  $('#r-body').innerHTML = '<div class="loading">载入中…</div>';
  reader.kind = kind;
  reader.source = source;
  try {
    if (kind === 'manga') {
      const data = await api('/api/reader/manga/pages', { source, id });
      $('#r-body').innerHTML = data.urls.length
        ? `<div class="pages">${data.urls.map((u) =>
            `<img loading="lazy" src="${esc(coverUrl(u, reader.source))}" alt="" onerror="this.remove()">`).join('')}</div>`
        : '<div class="empty">这一章没有图片</div>';
    } else {
      const data = await api('/api/reader/novel/chapter', { source, id });
      const paragraphs = String(data.text || '').split(/\n+/).map((p) => p.trim()).filter(Boolean);
      $('#r-body').innerHTML = paragraphs.length
        ? `<div class="prose" style="font-size:${reader.size}px">${paragraphs.map((p) => `<p>${esc(p)}</p>`).join('')}</div>`
        : '<div class="empty">这一章没有内容</div>';
    }
    $('#r-body').scrollTop = 0;
  } catch (err) {
    $('#r-body').innerHTML = `<div class="empty">载入失败：${esc(err.message)}</div>`;
  }
}

/** Chapter navigation, from the list the book page built. */
let chapterList = [];

function indexChapterList(kind, source) {
  const items = [...document.querySelectorAll('.chapters a')]
    .filter((a) => a.dataset.source === source)
    .map((a) => ({ id: a.dataset.id, title: a.dataset.title }));
  chapterList = items;
  reader.kind = kind;
  reader.source = source;
}

async function gotoChapter(delta) {
  const next = reader.index + delta;
  if (next < 0 || next >= chapterList.length) return;
  reader.index = next;
  const c = chapterList[next];
  $('#r-pos').textContent = `${next + 1}/${chapterList.length}`;
  await openChapter(reader.kind, reader.source, c.id, c.title);
}

/* ------------------------------------------------------------------ routing */

const routes = {
  home: showHome,
  manga: showManga,
  novels: showNovels,
  latest: () => showBrowse('latest'),
  popular: () => showBrowse('popular'),
  history: showHistory,
};

async function route() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const parts = hash.split('/').filter(Boolean);

  // A search is its own route: #/search/<kind>/<term>
  if (parts[0] === 'search') {
    const kind = parts[1] === 'novel' ? 'novel' : 'manga';
    await showSearch(decodeURIComponent(parts[2] || ''), kind);
    return;
  }

  // A book: #/book/<kind>/<source>/<id>
  if (parts[0] === 'book') {
    await openBook(parts[1] === 'novel' ? 'novel' : 'manga', parts[2], decodeURIComponent(parts[3] || ''));
    return;
  }

  const name = parts[0] || 'home';
  const fn = routes[name] || showHome;
  for (const a of document.querySelectorAll('#tabs a')) {
    a.classList.toggle('on', a.dataset.view === name);
  }
  try {
    await fn();
  } catch (err) {
    view.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

/* ------------------------------------------------------------------ wiring */

document.addEventListener('click', async (ev) => {
  const cardEl = ev.target.closest('.card, .row');
  if (cardEl && cardEl.dataset.kind) {
    const { kind, source, id } = cardEl.dataset;
    location.hash = `#/book/${kind}/${encodeURIComponent(source)}/${encodeURIComponent(id)}`;
    return;
  }

  const chip = ev.target.closest('.chip');
  if (chip) {
    view.innerHTML = '<div class="loading">载入中…</div>';
    try {
      const data = await api('/api/reader/novel/shelf', { source: chip.dataset.source, url: chip.dataset.url });
      view.innerHTML = `<h2 class="section">${esc(chip.textContent)}</h2>${grid(data.hits)}`;
    } catch (err) {
      view.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    }
    return;
  }

  const chapterLink = ev.target.closest('.chapters a');
  if (chapterLink) {
    const a = chapterLink;
    // The kind comes off the chapter list itself, not off `reader.kind`: the list knows what it is
    // (a manga's chapters or a novel's), and `reader.kind` is still whatever the last read left there.
    const box = a.closest('.chapters');
    const kind = box.dataset.kind === 'novel' ? 'novel' : 'manga';
    indexChapterList(kind, box.dataset.source);
    reader.index = chapterList.findIndex((c) => c.id === a.dataset.id);
    $('#r-pos').textContent = `${reader.index + 1}/${chapterList.length}`;
    await openChapter(kind, box.dataset.source, a.dataset.id, a.dataset.title);
    return;
  }
});

$('#search').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const q = $('#q').value.trim();
  if (!q) return;
  location.hash = `#/search/${state.kind}/${encodeURIComponent(q)}`;
});

for (const b of document.querySelectorAll('.kind button')) {
  b.addEventListener('click', () => {
    state.kind = b.dataset.kind;
    for (const x of document.querySelectorAll('.kind button')) x.classList.toggle('on', x === b);
  });
}

$('#adult').checked = state.adult;
$('#adult').addEventListener('change', (ev) => {
  state.adult = ev.target.checked;
  localStorage.setItem('reader.adult', state.adult ? '1' : '0');
  ev.target.closest('.adult').classList.toggle('on', state.adult);
  route();
});
$('#adult').closest('.adult').classList.toggle('on', state.adult);

// The language picker. Changing it redraws whatever is on screen: the shelves are in that
// language now, and a book already open keeps its language -- the reader opened it on purpose.
$('#lang').value = state.lang;
$('#lang').addEventListener('change', (ev) => {
  state.lang = ev.target.value;
  localStorage.setItem('reader.lang', state.lang);
  route();
});

$('#r-back').addEventListener('click', () => {
  $('#reader').hidden = true;
  if (location.hash.startsWith('#/book/')) route();
});
$('#r-prev').addEventListener('click', () => gotoChapter(-1));
$('#r-next').addEventListener('click', () => gotoChapter(1));
$('#r-size').addEventListener('click', () => {
  reader.size = reader.size >= 26 ? 15 : reader.size + 2;
  const prose = document.querySelector('.prose');
  if (prose) prose.style.fontSize = `${reader.size}px`;
  toast(`字号 ${reader.size}`);
});

window.addEventListener('hashchange', route);
route();
