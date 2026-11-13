// The 禁漫天堂 (JMComic) family: the pages of 18comic.vip, jmcomic.me and the mirrors they rotate through.
//
// The fixtures below are the live pages' own markup, trimmed to the parts the engine reads (the family is
// server-rendered, so there is nothing else in them worth keeping). They are the engine's test data, not a
// copy of the site: what is tested here is the parsing, and the sites themselves are probed separately.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeJmcomic, parseCards, parseChapters, parsePageUrls, parseSeries } from '../src/lib/sources/engines/jmcomic';
import { engineOf } from '../src/lib/sources/detect';

const BASE = 'https://18comic.vip';
const cfg = { id: 'test-jm', name: 'Test JM', base: BASE };

/** A result card: the anchor wraps the image, and the image carries the picture and the name. */
const card = (id: number, title: string, cover: string) => `<div class="col-xs-6 col-sm-6 col-md-4 col-lg-3 list-col">
  <div class="well p-b-15 p-l-5 p-r-5">
    <div class="thumb-overlay">
      <a href="/album/${id}/%E5%B0%91%E5%A5%B3%E6%BC%AB%E7%94%BB">
        <img src="https://cdn-msp2.18comic.vip/media/albums/blank.jpg"
             data-original="${cover}?v=1794464931"
             title="${title}" alt="${title}" class="lazy_img img-responsive img-rounded "/>
      </a>
      <div class="label-category" style="">同人</div>
    </div>
  </div>
</div>`;

/** The header's own links to albums: an icon, a link with no name. Not a result. */
const navLink = `<li class="navbar-right-block">
  <a href="/album/193790" style="padding: 5px;width: 35px;height: 35px;">
    <img src="/templates/frontend/airav/img/phicon/paper_box.svg">
  </a>
</li>`;

const resultPage = `<html><head><title>PHOTOS - Search Results For '原神' - 禁漫天堂</title></head><body>
${navLink}
${card(1490347, '[廉价汉化组][ttp]雷电将军系列[中国翻訳]', 'https://cdn-msp2.18comic.vip/media/albums/1490347_3x4.jpg')}
${card(1485022, '勇者求職中', 'https://cdn-msp2.18comic.vip/media/albums/1485022_3x4.jpg')}
</body></html>`;

/** The series page: the name, the summary, the author, the tags, and the chapter list. */
const albumPage = `<html><head><title>勇者求職中 第1話-勇者求職中 Comics - 禁漫天堂</title>
<meta property="og:title" content="勇者求職中 第1話-勇者求職中 Comics - 禁漫天堂"></head><body>
<div class="container">
  <h1 class="book-name mb-0" id="book-name">勇者求職中</h1>
  <h2 class="p-t-5 p-b-5" style="color:#777;"> 敘述：為了找到一份工作養活自己 </h2>
  <div class="p-t-5 p-b-5"><h2 class="h2_info">作者：</h2>
    <span itemprop="author" data-type="author">
      <a name="vote_" href="/search/photos?search_query=Mokson" class="btn phone-author-tag">Mokson</a>
      <a name="vote_" href="/search/photos?search_query=goofy" class="btn phone-author-tag">goofy</a>
    </span>
  </div>
  <div class="p-t-5 p-b-5"><h2 class="h2_info">分類標籤：</h2>
    <span itemprop="genre" data-type="tags">
      <a name="vote_" href="/search/photos?search_query=韓漫" class="btn phone-tags-tag">韓漫</a>
      <a name="vote_" href="/search/photos?search_query=連載中" class="btn phone-tags-tag">連載中</a>
    </span>
  </div>
  <h2 style="display:inline-block;font-size:14px;">章節列表</h2>
  <div class="row">
    <a href="/photo/1485022" data-album="1485022" data-index="0">
      <li class="current_series"><h3 class="h2_series"> 第1話 勇者求職中 第1話 </h3></li>
    </a>
    <a href="/photo/1485028" data-album="1485028" data-index="1">
      <li class=""><h3 class="h2_series"> 第2話 勇者求職中 第2話 </h3></li>
    </a>
    <a href="https://jmcomic-zzz.one/photo/1485029" data-album="1485029" data-index="2">
      <li class=""><h3 class="h2_series"> 第3話 勇者求職中 第3話 </h3></li>
    </a>
  </div>
</div></body></html>`;

/** The reader: one <img> per page, plus the site's own advertisements. */
const readerPage = `<html><body>
<div class="photo_center_div"><p><a href="https://afengy.com?ref_id=x"><img alt="" src="https://cdn-msp.18comic.vip/static/resources/images/ad.gif" /></a></p></div>
<div class="row thumb-overlay-albums">
  <div id="page_0" data-page="0">1 / 2</div>
  <div class="center scramble-page spnotice_chk" id="00001.webp" style="width:720px;">
    <img src="https://cdn-msp.18comic.vip/media/albums/blank.jpg"
         data-original="https://cdn-msp.18comic.vip/media/photos/1485022/00001.webp"
         id="album_photo_00001.webp" class="lazy_img img-responsive-mw" data-page="0"/>
  </div>
  <div id="page_1" data-page="1">2 / 2</div>
  <div class="center scramble-page spnotice_chk" id="00002.webp" style="width:720px;">
    <img src="https://cdn-msp.18comic.vip/media/albums/blank.jpg"
         data-original="https://cdn-msp.18comic.vip/media/photos/1485022/00002.webp"
         id="album_photo_00002.webp" class="lazy_img img-responsive-mw" data-page="1"/>
  </div>
</div></body></html>`;

/** Stubs the FlareSolverr HTTP boundary, which is the only place these adapters touch the network. */
function stubSolver(body: string) {
  globalThis.fetch = (async (_u: any, init: any) => {
    const { url } = JSON.parse(init.body);
    return new Response(JSON.stringify({ status: 'ok', solution: { url, status: 200, response: body, cookies: [], userAgent: 'test' } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
}

/** The address the engine asked the solver for. */
let asked: string[] = [];
function stubSolverRecording(body: string) {
  asked = [];
  globalThis.fetch = (async (_u: any, init: any) => {
    const { url } = JSON.parse(init.body);
    asked.push(url);
    return new Response(JSON.stringify({ status: 'ok', solution: { url, status: 200, response: body, cookies: [], userAgent: 'test' } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
}

test('a result page: the albums, with their covers', () => {
  const out = parseCards(resultPage, 'test-jm', BASE);
  assert.equal(out.length, 2, 'the navigation link to an album is not a result');
  assert.equal(out[0].title, '[廉价汉化组][ttp]雷电将军系列[中国翻訳]');
  assert.equal(out[0].coverUrl, 'https://cdn-msp2.18comic.vip/media/albums/1490347_3x4.jpg?v=1794464931');
  assert.equal(out[0].url, `${BASE}/album/1490347/%E5%B0%91%E5%A5%B3%E6%BC%AB%E7%94%BB`);
  assert.equal(out[1].title, '勇者求職中');
});

test('a card with no name of its own takes the one its address carries', () => {
  // The site's own images are lazy-loaded: the picture sits in `data-original` and `src` holds a placeholder.
  // A card whose image carries no title and no alt still has to be named, and the address is what names it.
  const page = `<a href="/album/1490347/%E5%8B%87%E8%80%85%E6%B1%82%E8%81%8C%E4%B8%AD">
    <img src="https://cdn-msp2.18comic.vip/media/albums/blank.jpg" data-original="https://cdn-msp2.18comic.vip/media/albums/x.jpg"/>
  </a>`;
  const out = parseCards(page, 'test-jm', BASE);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, '勇者求职中'); // the slug of /album/1490347/%E5%8B%87%E8%80%85%E6%B1%82%E8%81%8C%E4%B8%AD
});

test('the chapter list: the numbers the site says, in order', () => {
  const out = parseChapters(albumPage, BASE);
  assert.deepEqual(out.map((c) => c.number), [1, 2, 3]);
  assert.equal(out[0].title, '第1話 勇者求職中 第1話');
  assert.equal(out[0].sourceId, `${BASE}/photo/1485022`);
});

test('a chapter link on another host comes back to the configured one', () => {
  // The site names its own mirror in its links, and the mirror rotates. Following the page's own host would
  // take every later request off the host the operator configured -- to one they never chose, or to one that
  // has since expired. The pictures are left alone: they are on a CDN of their own.
  const out = parseChapters(albumPage, BASE);
  assert.equal(out[2].sourceId, `${BASE}/photo/1485029`);
  const pages = parsePageUrls(readerPage);
  assert.ok(pages.every((u) => u.startsWith('https://cdn-msp.18comic.vip/')), 'the picture was moved onto the site host');
});

test('the site\'s own "start reading" button does not name the first chapter', () => {
  // The album page carries a button that links to the first chapter and says "開始閱讀" -- it is not a chapter
  // entry, and it does not say which chapter it is. `Number('')` is 0, so an anchor with no `data-index` read
  // as index 0 took the name of chapter 1, and the real entry was dropped as a duplicate of its url.
  const page = `<div class="read-block">
    <a class="btn btn-primary reading" href="/photo/1485022"> 開始閱讀 </a>
  </div>
  <div class="row">
    <a href="/photo/1485022" data-album="1485022" data-index="0"><li><h3 class="h2_series"> 第1話 勇者求職中 </h3></li></a>
  </div>`;
  const out = parseChapters(page, BASE);
  assert.equal(out.length, 1);
  assert.equal(out[0].number, 1);
  assert.equal(out[0].title, '第1話 勇者求職中');
});

test('the pages of a chapter, and only the pages', () => {
  const out = parsePageUrls(readerPage);
  assert.deepEqual(out, [
    'https://cdn-msp.18comic.vip/media/photos/1485022/00001.webp',
    'https://cdn-msp.18comic.vip/media/photos/1485022/00002.webp',
  ]);
});

test('what the series page says about the series', () => {
  const info = parseSeries(albumPage);
  assert.equal(info.title, '勇者求職中');
  assert.equal(info.summary, '為了找到一份工作養活自己');
  assert.equal(info.author, 'Mokson goofy');
  assert.deepEqual(info.genres, ['韓漫', '連載中']);
});

test('the engine is found from the page itself', () => {
  assert.equal(engineOf(albumPage), 'jmcomic');
  assert.equal(engineOf(resultPage), 'jmcomic');
  assert.equal(engineOf('<html><body><div class="wp-manga">x</div></body></html>'), 'madara');
});

test('the listings ask the site for its own sort', async () => {
  stubSolverRecording(resultPage);
  const a = makeJmcomic(cfg);
  await a.latest(2);
  await a.popular(1);
  assert.ok(asked.some((u) => u.includes('/albums?o=mr&page=2')), `the newest listing asked for: ${asked.join(' ')}`);
  assert.ok(asked.some((u) => u.includes('/albums?o=mv&page=1')), `the popular listing asked for: ${asked.join(' ')}`);
});

test('the search and the series are read through the solver', async () => {
  stubSolver(resultPage);
  const out = await makeJmcomic(cfg).search('原神');
  assert.equal(out.length, 2);
  assert.equal(out[0].source, 'test-jm');
});
