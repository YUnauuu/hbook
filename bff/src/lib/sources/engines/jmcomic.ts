// A site of the 禁漫天堂 (JMComic) family: 18comic.vip, jmcomic.me, jmcomic1.me, and the mirrors the family
// rotates through. Every page of this family is server-rendered, which is the whole reason this engine exists.
//
// WHY A FOURTH FAMILY. The three that were here before (Madara, Manganato, MangaThemesia) are all WordPress
// themes, and the Chinese comic sites that outlived the last few years mostly stopped being WordPress. Measured
// from a server on 2026-11-13: of the 36 Chinese sites hbook shipped, 24 no longer resolved at all, and of the
// ones that answered, none ran any of those three themes. The survivors are hand-built sites -- and this one
// puts the whole of it in the HTML: the result page, the series page with its chapter list, and the reader with
// one <img> per page. Nothing here is fetched by script, so nothing here needs a browser to be read.
//
// The family's routes:
//
//   search    /search/photos?search_query=<q>[&page=N]    a result page, 80 albums a page
//   listing   /albums?o=mr (newest) | o=mv (most viewed)[&page=N]
//   album     /album/<id>[/<slug>]                         the series page; the chapter list is in the HTML
//   chapter   /photo/<id>                                  the reader; one <img> per page
//
// ⚠️ THE SITE NAMES ITS OWN MIRROR. A page fetched from 18comic.vip carries absolute links to jmcomic-zzz.one
// (the domain it considers canonical at the time), and the domain rotates every few months. Left alone, the
// engine would follow the page's links off the host the operator configured and every later request would go
// to a domain they never chose -- or to one that has since expired. So every PAGE url is put back on the
// configured base (rebase), while IMAGE urls are left alone: the pictures live on a CDN of their own
// (cdn-msp*.18comic.vip) and rewriting those would point them at the wrong host.
import type { SourceAdapter, SourceSeries, SourceChapter } from '../types';
import { cfGet } from '../flaresolverr';
import { plainText } from '../../htmlText';
import { pickImgUrl } from '../imgAttr';
import { throwIfOffline } from '../offline';
import { rebase } from '../slug';

const strip = plainText;
const norm = (u: string) => u.replace(/^\/\//, 'https://').replace(/&amp;/g, '&').trim();

/**
 * The family's own markup (lib/sources/offline.ts wants to tell a working page from a maintenance notice).
 * A card carries `thumb-overlay` and `label-category`; a series page carries `book-name`; a chapter list
 * carries `h2_series`; the reader carries `/media/photos/`.
 */
export const JMCOMIC_MARKUP = /book-name|h2_series|thumb-overlay|label-category|lazy_img|\/media\/photos\/|\/photo\/\d+|\/album\/\d+/i;

/** The attribute of an <img> tag, either quote style. */
function attrOf(tag: string, name: string): string {
  const m = tag.match(new RegExp(`\\s${name}=(?:"([^"]*)"|'([^']*)')`, 'i'));
  return (m?.[1] ?? m?.[2] ?? '').trim();
}

/** A page url on the configured host: relative made absolute, and a mirror named by the page sent back. */
function onBase(url: string, base: string): string {
  const abs = url.startsWith('http') ? url : `${base}${url.startsWith('/') ? '' : '/'}${url}`;
  return rebase(abs, base);
}

/** The title a url carries when the card's own image has none: the slug after the album id, decoded. */
function slugTitle(url: string): string {
  const m = /\/album\/\d+(?:\/([^/?#]+))?/.exec(url);
  const slug = m?.[1] ?? '';
  if (!slug) return ''; // `/album/<id>` and nothing else: the address names nothing, and the id is not a title
  try { return decodeURIComponent(slug).trim(); } catch { return slug.trim(); }
}

/**
 * The albums on a result or listing page, as the cards the family writes them.
 *
 * A card is an anchor to `/album/<id>` wrapping one <img>: the picture is in `data-original` (the site
 * lazy-loads it and puts a placeholder in `src`), and the title is in the image's `title`/`alt` attribute.
 *
 * ⚠️ THE NAVIGATION LINKS ARE ALBUMS TOO. The header carries `/album/<id>` links to icons, and the footer
 * carries the same. They are read here too, and they are told apart by their image: an icon has no title and
 * no alt, so it has no name to show, and a card with no name is not a result. Without that, every listing
 * would open with a row of the site's own chrome, named after whatever the icon file was called.
 */
export function parseCards(h: string, sourceId: string, base: string): SourceSeries[] {
  const out: SourceSeries[] = [];
  const seen = new Set<string>();
  for (const m of h.matchAll(/<a[^>]+href="([^"]*\/album\/\d+[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = onBase(m[1], base);
    const key = url.replace(/\/+$/, '');
    if (seen.has(key)) continue;
    const img = /<img\b[^>]*>/i.exec(m[2])?.[0] ?? '';
    const title = strip(attrOf(img, 'title') || attrOf(img, 'alt')) || slugTitle(m[1]);
    if (!title) continue;
    const cover = img ? pickImgUrl(img) : null;
    seen.add(key);
    out.push({ sourceId: key, source: sourceId, title, url, coverUrl: cover ? norm(cover) : undefined });
  }
  return out;
}

/**
 * The chapter list on a series page.
 *
 * The family writes it as a list of anchors to `/photo/<id>`, each wrapping an <h3 class="h2_series"> whose
 * text is the chapter's own name ("第1話 …"). The number is read out of that text; the `data-index` the anchor
 * carries is the fallback for a chapter whose name does not say which one it is.
 */
export function parseChapters(h: string, base: string): SourceChapter[] {
  const byUrl = new Map<string, SourceChapter>();
  for (const m of h.matchAll(/<a([^>]+href="([^"]*\/photo\/\d+)"[^>]*)>([\s\S]*?)<\/a>/gi)) {
    const url = onBase(m[2], base);
    const label = strip(/<h3[^>]*>([\s\S]*?)<\/h3>/i.exec(m[3])?.[1] ?? m[3]);
    const said = label.match(/第\s*(\d+(?:\.\d+)?)\s*[話话]/);
    // ⚠️ `Number('')` is 0, not NaN: an anchor with no `data-index` would otherwise be read as index 0 and
    // become chapter 1. That is the site's own "start reading" button -- it links to the first chapter and
    // says nothing about which chapter it is -- and it would take the name of the first real chapter.
    const indexAttr = attrOf(m[1], 'data-index');
    const index = indexAttr ? Number(indexAttr) : NaN;
    const number = said ? Number(said[1]) : Number.isFinite(index) ? index + 1 : NaN;
    if (Number.isNaN(number)) continue;
    const seen = byUrl.get(url);
    if (seen && !said) continue; // the entry that names the chapter wins over one that only links to it
    byUrl.set(url, { sourceId: url, number, title: label || `第${number}話` });
  }
  const out = [...byUrl.values()];
  const numbers = new Set<number>();
  return out
    .filter((c) => (numbers.has(c.number) ? false : (numbers.add(c.number), true)))
    .sort((a, b) => a.number - b.number);
}

/**
 * The pages of one chapter, as the reader writes them: one <img> per page, the picture in `data-original`.
 *
 * ⚠️ The reader also carries the site's advertisements and its own placeholder (`media/albums/blank.jpg`).
 * Only the photos of THIS chapter are read -- the ones under `/media/photos/` -- so the wall is the chapter
 * and not the page around it.
 */
export function parsePageUrls(h: string): string[] {
  const urls: string[] = [];
  for (const m of h.matchAll(/<img\b[^>]*>/gi)) {
    const u = pickImgUrl(m[0]);
    if (u && /\/media\/photos\//i.test(u)) urls.push(norm(u));
  }
  return urls;
}

/** What a series page says about the series: its name, its summary, its author and its tags. */
export function parseSeries(h: string): { title: string; summary?: string; author?: string; genres: string[] } {
  const title = strip((h.match(/<h1[^>]*id="book-name"[^>]*>([\s\S]*?)<\/h1>/i) || h.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '')
    || strip((h.match(/<meta[^>]+property="og:title"[^>]+content="([^"]*)"/i) || [])[1] || '').replace(/\s*[-–|].*$/, '').trim();
  const summary = strip(/敘述[：:]\s*([\s\S]*?)<\/h2>/i.exec(h)?.[1] || '');
  const author = strip(/itemprop="author"[^>]*>([\s\S]*?)<\/span>/i.exec(h)?.[1] || '');
  const genreBlock = /itemprop="genre"[^>]*>([\s\S]*?)<\/span>/i.exec(h)?.[1] || '';
  const genres = [...genreBlock.matchAll(/>([^<>]+)</g)].map((x) => strip(x[1])).filter(Boolean);
  return {
    title,
    ...(summary ? { summary } : {}),
    ...(author ? { author } : {}),
    genres,
  };
}

export function makeJmcomic(cfg: { id: string; name: string; base: string; order?: number; lang?: string }): SourceAdapter {
  const base = cfg.base.replace(/\/$/, '');
  /** The listing, read and checked: a page that parses to nothing is the site being down, not an empty answer. */
  const listing = (h: string): SourceSeries[] => {
    const out = parseCards(h, cfg.id, base);
    if (!out.length) throwIfOffline(h, JMCOMIC_MARKUP);
    return out;
  };

  return {
    id: cfg.id,
    name: cfg.name,
    ...(cfg.lang ? { lang: cfg.lang } : {}),
    base,
    imageReferer: `${base}/`, // the pictures are on a CDN that wants the site's own origin as Referer
    requiresCloudflare: true, // the family sits behind Cloudflare; the solver's cookies are what get past it
    preferredOrder: cfg.order,

    async search(query) {
      return listing(await cfGet(`${base}/search/photos?search_query=${encodeURIComponent(query)}`));
    },

    /** The family's search pages: 80 albums a page, and a title can be on page 12 of them. */
    async searchPage(query, page) {
      const p = Math.max(1, page);
      return listing(await cfGet(`${base}/search/photos?search_query=${encodeURIComponent(query)}&page=${p}`));
    },

    /** The site's own newest albums (`o=mr`), and its own most-viewed ones (`o=mv`) -- not a ranking of ours. */
    async latest(page = 1) {
      const p = Math.max(1, page);
      return listing(await cfGet(`${base}/albums?o=mr&page=${p}`));
    },

    async popular(page = 1) {
      const p = Math.max(1, page);
      return listing(await cfGet(`${base}/albums?o=mv&page=${p}`));
    },

    async getSeries(id) {
      const url = id.startsWith('http') ? rebase(id, base) : `${base}/album/${id}`;
      const h = await cfGet(url);
      const info = parseSeries(h);
      if (!info.title) throwIfOffline(h, JMCOMIC_MARKUP);
      return { sourceId: url, source: cfg.id, title: info.title, summary: info.summary, author: info.author, genres: info.genres, url };
    },

    async listChapters(seriesId) {
      const url = seriesId.startsWith('http') ? rebase(seriesId, base) : `${base}/album/${seriesId}`;
      const h = await cfGet(url);
      const out = parseChapters(h, base);
      if (!out.length) throwIfOffline(h, JMCOMIC_MARKUP);
      return out;
    },

    async getPageUrls(chapterId) {
      const url = chapterId.startsWith('http') ? rebase(chapterId, base) : `${base}/photo/${chapterId}`;
      const h = await cfGet(url);
      const urls = parsePageUrls(h);
      if (!urls.length) throwIfOffline(h, JMCOMIC_MARKUP);
      return urls;
    },
  };
}
