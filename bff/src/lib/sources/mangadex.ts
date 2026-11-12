// MangaDex built-in source — official public API (no key, no scraping, no Cloudflare). The most defensible
// source, so it's bundled in the core and always on. Docs: https://api.mangadex.org/docs/
//
// v0.52.0 (#123): one adapter per language. `mangadex` is English, always on, and asks exactly what it always
// asked, its fallback chain included. Every other language an admin turns on in Admin → Providers is an adapter
// of its own, `mangadex-es-419` / "MangaDex (ES-419)", which asks MangaDex for that one language and nothing else
// (sources/mangadexLangs.ts registers them). All of them share the one rate limit below.
import { SourceAdapter, SourceSeries, SourceChapter } from './types';
import { directionFromLanguage } from '../directionSignals';
import { canonLang, langLabel, mdLang } from '../lang';
import { deadlineRemaining } from './flaresolverr';

/**
 * Where MangaDex's API is: MANGADEX_API_URL moves it (v0.56.0), a test knob like ANILIST_API_URL -- the browser walk points it
 * at a fake, so Discover's name lookups never ask the real MangaDex about a walk's made-up titles. Unset, MangaDex's own.
 */
const API = (process.env.MANGADEX_API_URL || 'https://api.mangadex.org').replace(/\/+$/, '');
const HEADERS = { 'user-agent': 'hbook/1.0 (self-hosted personal reader)' };
const RATINGS = ['safe', 'suggestive', 'erotica'].map((r) => `contentRating[]=${r}`).join('&');

/** The search's own query string: the word, the ratings, what to bring back, and the order. */
const searchQuery = (query: string): string =>
  `title=${encodeURIComponent(query)}&limit=12&${RATINGS}&includes[]=cover_art&includes[]=author&order[relevance]=desc`;

// Language adapters share one name lookup, including its in-flight request. A global search may ask
// every enabled language at once; resolving the same person separately would spend the API's rate limit.
const creators = new Map<string, { until: number; ids: Promise<string[]> }>();
function creatorIds(name: string): Promise<string[]> {
  const key = name.trim().toLowerCase();
  const hit = creators.get(key);
  if (hit && hit.until > Date.now()) return hit.ids;
  if (creators.size >= 50) creators.delete(creators.keys().next().value!);
  const ids = mdGet(`${API}/author?name=${encodeURIComponent(name.trim())}&limit=100`).then((people) =>
    [...new Set<string>((people.data || []).map((p: any) => p.id).filter((id: unknown): id is string => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)))],
  );
  const cell = { until: Date.now() + 300_000, ids };
  creators.set(key, cell);
  ids.catch(() => { if (creators.get(key) === cell) creators.delete(key); });
  return ids;
}

/** The rate group every MangaDex adapter declares (types.ts `rateGroup`): one API, one limit, however many languages. */
export const MANGADEX_GROUP = 'mangadex';

// ---- One rate limit for every MangaDex source ------------------------------------------------------------------
//
// MangaDex limits by address: about five API requests a second, and forty /at-home/server lookups a minute. Until
// v0.52.0 one adapter asked, nothing spaced its requests, and a 429 was a thrown "mangadex 429" with the headers
// that said how long to wait thrown away. With an adapter per language, a sweep, Discover's Newest and a search in
// five languages are five times the requests from one address, so every request of every language comes here:
//
//   - starts are spaced per kind, the slot reserved before the wait: two adapters may overlap, never burst;
//   - a 429 pauses EVERY language until the moment MangaDex named (X-RateLimit-Retry-After, epoch seconds, else
//     Retry-After), and a 200 that says nothing is left in the window (X-RateLimit-Remaining: 0) pauses ahead of
//     time instead of spending a request on the 429;
//   - a request that would wait longer than `maxWaitMs` is refused at once, without being sent, tagged
//     `selfTimeout`: the listing paths then record "slow" rather than a cooldown (routes/sources.ts), so a pause
//     another language earned never costs this one fifteen minutes, and abandoned requests never queue up to
//     burst the moment the pause ends. Its message says "rate limit", which the downloader reads as rate_limited.
//
// Cooldowns (source_health) stay per adapter on purpose; this pause is what holds every language back.

type Kind = 'api' | 'atHome';
interface Pacing { apiGapMs: number; atHomeGapMs: number; maxWaitMs: number }
/** About four requests a second (the limit is about five), /at-home/server about 37 a minute (of 40), ten seconds of patience. */
const PACING: Pacing = { apiGapMs: 250, atHomeGapMs: 1600, maxWaitMs: 10_000 };
/** A pause lasts at least a second and at most ten minutes, whatever the header says: past that, the next request re-tests. */
const PAUSE_MIN_MS = 1000;
const PAUSE_MAX_MS = 10 * 60_000;

let pacing: Pacing = { ...PACING };
const nextAt: Record<Kind, number> = { api: 0, atHome: 0 };
let pausedUntil = 0;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * When MangaDex said to come back, held between a second and ten minutes from now. X-RateLimit-Retry-After is a
 * moment in epoch seconds; a small number there is read as seconds from now rather than as a moment in 1970.
 * Retry-After is seconds, or an HTTP date.
 */
function pauseEnd(h: Headers, now: number): number {
  const x = Number(h.get('x-ratelimit-retry-after'));
  const ra = h.get('retry-after');
  const secs = Number(ra);
  const at = x > 1e9 ? x * 1000
    : x > 0 ? now + x * 1000
    : ra && Number.isFinite(secs) ? now + secs * 1000
    : ra ? Date.parse(ra)
    : NaN;
  return Math.min(now + PAUSE_MAX_MS, Math.max(now + PAUSE_MIN_MS, Number.isFinite(at) ? at : 0));
}

/** Wait for this request's turn: its slot in the spacing for its kind, and the end of any pause. */
async function turn(kind: Kind): Promise<void> {
  for (;;) {
    const now = Date.now();
    const start = Math.max(now, nextAt[kind], pausedUntil);
    if (start - now > pacing.maxWaitMs) {
      const ms = start - now;
      throw Object.assign(new Error(`mangadex: rate limit, paused ~${Math.ceil(ms / 1000)}s`), { selfTimeout: true, ms });
    }
    nextAt[kind] = start + (kind === 'atHome' ? pacing.atHomeGapMs : pacing.apiGapMs);
    if (start > now) await sleep(start - now);
    // A pause that began while this request waited its turn -- another language's 429 -- holds it as well.
    if (pausedUntil <= Date.now()) return;
  }
}

/**
 * Is this the network rather than MangaDex?
 *
 * A socket that is reset while the TLS handshake is still going up is a network that had a bad
 * moment: the request never reached the site, so it says nothing about the site's answer. On a
 * filtered or a busy network these are common -- measured here, one request in three came back as
 * ECONNRESET or UND_ERR_SOCKET while the same URL answered fine a second later.
 */
function transient(err: any): boolean {
  const code = String(err?.cause?.code ?? err?.code ?? '');
  return ['ECONNRESET', 'UND_ERR_SOCKET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'EAI_AGAIN']
    .includes(code);
}

/**
 * GET one MangaDex API URL as JSON, through the shared limit. `atHome` for /at-home/server, which MangaDex limits on
 * its own. Throws "mangadex <status>" for any other answer than OK, with `status` on the error.
 *
 * A request whose socket is reset is asked again -- twice, with a pause -- because a source that
 * failed on a reset socket has not been asked at all, and a shelf of nothing because the network
 * blinked is the worst answer there is.
 */
export async function mdGet(url: string, kind: Kind = 'api'): Promise<any> {
  let r: Response | null = null;
  for (let attempt = 0; ; attempt++) {
    await turn(kind);
    try {
      // The request is given the caller's budget when there is one: a fan-out that is waiting nine
      // seconds for this source must not be held for fifteen by a socket that is not answering.
      const budget = Math.min(15_000, deadlineRemaining());
      r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(budget) });
      break;
    } catch (err) {
      if (attempt >= 2 || !transient(err)) throw err;
      await sleep(400 * (attempt + 1));
    }
  }
  if (r.status === 429) {
    pausedUntil = Math.max(pausedUntil, pauseEnd(r.headers, Date.now()));
    throw Object.assign(new Error('mangadex 429'), { status: 429 });
  }
  if (!r.ok) throw Object.assign(new Error(`mangadex ${r.status}`), { status: r.status });
  if (r.headers.get('x-ratelimit-remaining') === '0') pausedUntil = Math.max(pausedUntil, pauseEnd(r.headers, Date.now()));
  return r.json();
}

/** Tests only: the spacing and the patience, field by field; `null` puts back the real ones. */
export function _setMangadexPacing(p: Partial<Pacing> | null): void {
  pacing = p ? { ...pacing, ...p } : { ...PACING };
}
/** Tests only: forget every reserved slot and any pause, so one test's 429 does not hold up the next. */
export function _resetMangadexLimiter(): void {
  nextAt.api = 0;
  nextAt.atHome = 0;
  pausedUntil = 0;
}

// ---- the adapters --------------------------------------------------------------------------------------------

function firstLang(obj: any): string {
  if (!obj) return '';
  return obj.en || obj['ja-ro'] || (Object.values(obj)[0] as string) || '';
}

/**
 * The languages a title's name is looked for in, most wanted first.
 *
 * MangaDex keeps the ORIGINAL title in `attributes.title` (always the Japanese romanisation for a
 * Japanese work, the English title for an English one) and every TRANSLATED title in
 * `attributes.altTitles`, as one single-language map per alternative. So the Chinese name of a series
 * -- 烙印勇士, 劍風傳奇 -- is in `altTitles` and nowhere else, and a reader asking MangaDex for
 * Chinese chapters was served the English name for them.
 *
 * The two Chinese variants are each other's fallback: a work translated into traditional Chinese is
 * still Chinese, and the reader can read it; a work with only a simplified name is still Chinese for
 * a traditional reader. Anything else falls back to English, then to the romanisation, then to
 * whatever is there.
 */
function titleLangs(md: string): string[] {
  const list = [md];
  if (md === 'zh') list.push('zh-hk');
  if (md === 'zh-hk') list.push('zh');
  for (const l of ['en', 'ja-ro']) if (!list.includes(l)) list.push(l);
  return list;
}

/**
 * The title in the language the adapter is for.
 *
 * `altTitles` first (that is where the translations are), then `title` (the original), then English,
 * then the romanisation. A title with no name at all in any of them falls back to the first thing
 * there is, so a row is never nameless.
 */
function titleOf(a: any, md: string): string {
  const alt = Array.isArray(a.altTitles) ? a.altTitles : [];
  for (const lang of titleLangs(md)) {
    for (const entry of alt) {
      if (entry && typeof entry[lang] === 'string' && entry[lang]) return entry[lang];
    }
    if (a.title && typeof a.title[lang] === 'string' && a.title[lang]) return a.title[lang];
  }
  return firstLang(a.title) || alt.map((t: any) => firstLang(t)).find(Boolean) || '';
}

/** The description in the language the adapter is for, the same way the title is found. */
function summaryOf(a: any, md: string): string {
  const d = a.description;
  if (!d) return '';
  for (const lang of titleLangs(md)) {
    if (typeof d[lang] === 'string' && d[lang]) return d[lang];
  }
  return firstLang(d);
}

/** The content ratings MangaDex gives a title. */
const CONTENT_RATINGS = new Set(['safe', 'suggestive', 'erotica', 'pornographic']);

function toSeries(m: any, source: string, md = 'en'): SourceSeries {
  const a = m.attributes || {};
  const cover = (m.relationships || []).find((r: any) => r.type === 'cover_art');
  const author = (m.relationships || []).find((r: any) => r.type === 'author' || r.type === 'artist');
  const genres = (a.tags || [])
    .filter((t: any) => ['genre', 'theme'].includes(t.attributes?.group))
    .map((t: any) => firstLang(t.attributes?.name))
    .filter(Boolean);
  return {
    sourceId: m.id,
    // The adapter's own id: a hit from MangaDex (ES-419) is added from MangaDex (ES-419), not from English.
    source,
    title: titleOf(a, md) || 'Untitled',
    summary: summaryOf(a, md),
    status: a.status ? String(a.status).toUpperCase() : undefined,
    genres,
    author: author?.attributes?.name,
    coverUrl: cover?.attributes?.fileName ? `https://uploads.mangadex.org/covers/${m.id}/${cover.attributes.fileName}` : undefined,
    url: `https://mangadex.org/title/${m.id}`,
    updatedAt: a.updatedAt || a.createdAt || undefined,
    // Japanese reads right to left, Korean and Chinese as a long strip (lib/readingDirection.ts, #102).
    readingDirection: directionFromLanguage(a.originalLanguage) ?? undefined,
    // And what kind of comic it is (lib/seriesType.ts), from the same field.
    originalLanguage: typeof a.originalLanguage === 'string' && a.originalLanguage ? a.originalLanguage : undefined,
    // MangaDex rates every title (v0.55.4, #158): the one source whose search results say whether they are 18+, which
    // Discover's search filter reads (lib/searchAll.ts ratingOf). Search asks for erotica as well as safe and suggestive.
    ...(CONTENT_RATINGS.has(a.contentRating) ? { contentRating: a.contentRating } : {}),
  };
}


/**
 * The original language of many titles at once, for the repair's reading-direction backfill
 * (lib/readingDirection.ts detectDirections). `ids[]` takes up to 100 per request, so a whole library of
 * MangaDex series is a handful of calls. Every content rating is asked for: this is a lookup by id of titles
 * already in the library, and the default filter would silently answer nothing for an adult one.
 */
export async function mangadexOriginalLanguages(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const qs = chunk.map((id) => `ids[]=${encodeURIComponent(id)}`).join('&');
    const j = await mdGet(`${API}/manga?${qs}&limit=100&${RATINGS}&contentRating[]=pornographic`);
    for (const m of j.data || []) {
      const lang = m?.attributes?.originalLanguage;
      if (typeof m?.id === 'string' && typeof lang === 'string' && lang) out.set(m.id, lang);
    }
  }
  return out;
}

/** A MangaDex entry as Discover's identity lookup needs it (lib/discoverIdentity.ts): every name, and its AniList link. */
export interface MangaDexWork { id: string; names: string[]; al: string | null }

/**
 * The entries a name may be, by MangaDex's title search (which also searches alternative titles): up to five, each with
 * every name it goes by and the AniList id it links to, for the caller to keep only one that IS the name. Through the
 * shared limiter like every MangaDex request; a failure throws, so the caller asks again later rather than storing a miss.
 */
export async function searchMangaDexWorks(title: string): Promise<MangaDexWork[]> {
  const s = title.trim();
  if (!s) return [];
  const j = await mdGet(`${API}/manga?title=${encodeURIComponent(s)}&limit=5&${RATINGS}&contentRating[]=pornographic`);
  const out: MangaDexWork[] = [];
  for (const m of j?.data || []) {
    if (typeof m?.id !== 'string') continue;
    const a = m.attributes || {};
    const names = [...Object.values(a.title || {}), ...((a.altTitles || []) as any[]).flatMap((t) => Object.values(t || {}))]
      .filter((n): n is string => typeof n === 'string' && !!n.trim());
    const al = a.links && /^\d+$/.test(String(a.links.al ?? '')) ? String(a.links.al) : null;
    out.push({ id: m.id.toLowerCase(), names, al });
  }
  return out;
}

/**
 * Every name of many titles at once -- each language's title and every alternative title -- for the recheck of a
 * cover the art backfill took from a MangaDex search before the title check existed (v0.55.7, lib/matchCheck.ts).
 * Batched and rated like mangadexOriginalLanguages, through the same limiter; a title MangaDex does not answer for
 * is absent, and a failure throws.
 */
export async function mangadexTitles(ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const qs = chunk.map((id) => `ids[]=${encodeURIComponent(id)}`).join('&');
    const j = await mdGet(`${API}/manga?${qs}&limit=100&${RATINGS}&contentRating[]=pornographic`);
    for (const m of j.data || []) {
      if (typeof m?.id !== 'string') continue;
      const a = m.attributes || {};
      const names = [...Object.values(a.title || {}), ...((a.altTitles || []) as any[]).flatMap((t) => Object.values(t || {}))]
        .filter((n): n is string => typeof n === 'string' && !!n.trim());
      out.set(m.id.toLowerCase(), names);
    }
  }
  return out;
}


/** The groups credited on one feed row, in the order MangaDex lists them. Empty when none is attached. */
function groupsOn(c: any): string[] {
  return ((c.relationships || []) as any[])
    .filter((r) => r?.type === 'scanlation_group')
    .map((r) => (typeof r.attributes?.name === 'string' ? r.attributes.name.trim() : ''))
    .filter(Boolean);
}

/**
 * Every chapter MangaDex lists for one series in one language (MangaDex's own code), paged out, ascending by
 * number. A number with several releases comes back as several rows.
 *
 * `includes[]=scanlation_group` expands each row's group relationships from bare `{id,type}` to carry the
 * group's attributes; without it the name is a second request per group. `groups` keeps the names apart
 * because MangaDex is the one source that lists them structurally, and `scanlator` joins them the way
 * Mihon shows a joint release, so the ComicInfo Translator tag reads the same from either app.
 */
async function feedFor(seriesId: string, lang: string): Promise<SourceChapter[]> {
  const all: SourceChapter[] = [];
  let offset = 0;
  let total = Infinity;
  while (offset < total) {
    // `includeExternalUrl=0` keeps the chapters MangaDex actually hosts. A chapter with an external
    // URL is a LINK to another site -- it has no pages here, so it cannot be downloaded and cannot be
    // read, and listing it in a chapter list is a promise the app cannot keep. A series whose every
    // chapter is external (some titles are only ever announced here) then lists nothing, which is the
    // truth.
    const j = await mdGet(`${API}/manga/${seriesId}/feed?translatedLanguage[]=${encodeURIComponent(lang)}&order[chapter]=asc&order[volume]=asc&limit=500&offset=${offset}&includeExternalUrl=0&${RATINGS}&includes[]=scanlation_group`);
    total = j.total ?? 0;
    for (const c of j.data || []) {
      const num = parseFloat(c.attributes?.chapter);
      if (Number.isNaN(num)) continue;
      const groups = groupsOn(c);
      all.push({
        sourceId: c.id,
        number: num,
        title: c.attributes?.title || undefined,
        // The app's code, not MangaDex's: "es-la" is "es-419" here, as on the source's name (MangaDex (ES-419))
        // and on every other source, so the Versions sheet and the language guard read one spelling.
        lang: canonLang(c.attributes?.translatedLanguage) ?? undefined,
        pages: c.attributes?.pages,
        publishedAt: c.attributes?.publishAt || c.attributes?.readableAt || undefined,
        scanlator: groups.length ? groups.join(' & ') : undefined,
        groups: groups.length ? groups : undefined,
      });
    }
    offset += 500;
    if (!j.data?.length) break;
  }
  // No collapse to one row per number here any more. This used to keep a hosted copy (pages>0) over an
  // external one (pages=0) and otherwise the first seen; hosted-beats-external is now a tie-break in the
  // chooser in lib/releases.ts, which needs `pages`, already on the row, and which is the only place that
  // knows which group the reader wanted.
  return all.sort((a, b) => a.number - b.number);
}

/** How many series one Newest page shows, and how many chapter rows are read to find them (MangaDex's maximum). */
const NEWEST_SERIES = 24;
const NEWEST_FEED = 100;
/** The chapter list answers nothing past offset + limit = 10,000. */
const FEED_WINDOW = 10_000;

/** The adapter id of MangaDex in one language: `mangadex` for English, `mangadex-es-419`, `mangadex-pt-br`, … */
export function mangadexId(code: string): string {
  const app = canonLang(code) ?? code;
  return app === 'en' ? 'mangadex' : `mangadex-${app.toLowerCase()}`;
}

/**
 * MangaDex in one language, an app code from lib/lang.ts MANGADEX_LANGS ("es-419", "pt-BR", "zh-Hant").
 *
 * Every adapter is its language only, English included (v0.62.0): search and Popular find titles with chapters in
 * it, Newest is its newest chapters, and the chapter list is its chapters with no fallback. English used to fall
 * back through Spanish, Portuguese and the rest when a title had no English chapters, which was how a server set to
 * English only downloaded a Spanish series; since v0.52.0 that title belongs to MangaDex (ES-419), an adapter of its
 * own. Throws for a code MangaDex is not offered in.
 */
export function makeMangadex(code: string): SourceAdapter {
  const app = canonLang(code);
  const md = mdLang(app);
  if (!app || !md) throw new Error(`MangaDex is not offered in "${code}"`);
  const english = app === 'en';
  const adapterId = mangadexId(app);
  // The adapter carries its language into the mapping, so a Chinese adapter names its titles in
  // Chinese and a Japanese one in Japanese.
  const series = (m: any) => toSeries(m, adapterId, md);
  return {
    id: adapterId,
    name: english ? 'MangaDex' : `MangaDex (${langLabel(app)})`,
    // MangaDex hosts every language, but each adapter asks for exactly one. Reporting no language meant English
    // MangaDex joined every language group, so picking Japanese filled a third of the wall with English MangaDex
    // rows -- the "says Japanese, serves English" the owner reported, seen from the reader's side.
    lang: app,
    rateGroup: MANGADEX_GROUP,
    imageReferer: 'https://mangadex.org/', // CDN rejects image fetches without the mangadex referer
    // The image CDN runs a bot challenge, and it answers 403 -- "Bot challenge not passed, refresh this
    // page." -- to anything that CLAIMS to be a browser. A Chrome user-agent with no browser behind it
    // is the shape of a scraper, and the challenge is built to tell them apart: the same request with a
    // plain, honest user-agent is served. (Measured 2026-11-11: every "Mozilla/..." user-agent was
    // refused on uploads.mangadex.org, and every other one was served -- pages included.)
    //
    // So this is not a UA spoof to get past a check; it is the UA that gets served. The same shape as
    // lib/titleLogoLibrary.ts's USER_AGENT.
    imageHeaders: { 'user-agent': 'hbook-manga/1 (+https://github.com/YUnauuu/hbook)' },
    preferredOrder: 10,

    async search(query) {
      // Only titles with chapters in this language, English included (v0.62.0): a hit it cannot serve is a dead end,
      // and English no longer falls back to another language to fill one.
      const j = await mdGet(`${API}/manga?${searchQuery(query)}&availableTranslatedLanguage[]=${md}`);
      return (j.data || []).map(series);
    },

    /**
     * The same search without the language filter.
     *
     * For a reader, not for the downloader. "Only titles with chapters in this language" is right when
     * the answer is going to be downloaded -- a title without a chapter is a dead end -- and wrong
     * when the answer is going to be read: a Chinese reader who types 我独自升级 wants to see that
     * the book is there, and MangaDex holds that name as an alternative title of a series whose
     * chapters are in other languages.
     */
    async searchAnyLanguage(query) {
      const j = await mdGet(`${API}/manga?${searchQuery(query)}`);
      return (j.data || []).map(series);
    },

    async searchCreator(name, kind, page = 1) {
      // The author catalogue holds both writers and artists. Resolve the name there, then ask the
      // requested relationship field; using title= here would silently search for a different thing.
      if (!name.trim()) return [];
      const ids = await creatorIds(name);
      if (!ids.length) return [];
      const field = kind === 'artist' ? 'artists[]' : 'authors[]';
      const offset = (Math.max(1, Math.floor(page)) - 1) * 100;
      if (offset >= 10_000) return [];
      const creator = ids.map((id) => `${field}=${encodeURIComponent(id)}`).join('&');
      const j = await mdGet(`${API}/manga?${creator}&limit=100&offset=${offset}&${RATINGS}&includes[]=cover_art&includes[]=author&includes[]=artist&availableTranslatedLanguage[]=${md}`);
      return (j.data || []).map(series);
    },

    /**
     * Discover's Newest: the newest chapters IN THIS LANGUAGE, and the series they belong to, in that order -- two
     * requests a page. It ordered /manga by `latestUploadedChapter`, which counts a chapter in any language, so a
     * title whose last English chapter was a year old headed English Newest the day it came out in Indonesian.
     */
    async latest(page = 1) {
      const offset = (Math.max(1, page) - 1) * NEWEST_FEED;
      if (offset + NEWEST_FEED > FEED_WINDOW) return [];
      const feed = await mdGet(`${API}/chapter?translatedLanguage[]=${md}&order[readableAt]=desc&limit=${NEWEST_FEED}&offset=${offset}&includeExternalUrl=0&includeFuturePublishAt=0&includeEmptyPages=0&${RATINGS}`);
      // Feed order, each series once, at its newest chapter: that chapter's time is when the series was updated.
      const when = new Map<string, string | undefined>();
      for (const c of feed.data || []) {
        const m = ((c.relationships || []) as any[]).find((r) => r?.type === 'manga');
        if (typeof m?.id !== 'string' || when.has(m.id)) continue;
        when.set(m.id, c.attributes?.readableAt || undefined);
        if (when.size >= NEWEST_SERIES) break;
      }
      if (!when.size) return [];
      const ids = [...when.keys()];
      const j = await mdGet(`${API}/manga?${ids.map((i) => `ids[]=${encodeURIComponent(i)}`).join('&')}&limit=${ids.length}&${RATINGS}&includes[]=cover_art&includes[]=author`);
      const byId = new Map<string, any>(((j.data || []) as any[]).map((m) => [m?.id, m]));
      return ids.flatMap((i) => {
        const m = byId.get(i);
        if (!m) return [];
        const s = series(m);
        return [{ ...s, updatedAt: when.get(i) ?? s.updatedAt }];
      });
    },

    // The same endpoint and the same filters as search, ordered by how many people follow the series, among
    // titles with chapters in this language. `toSeries` does not care how the list was sorted.
    async popular(page = 1) {
      const offset = (Math.max(1, page) - 1) * 24;
      const j = await mdGet(`${API}/manga?order[followedCount]=desc&limit=24&offset=${offset}&hasAvailableChapters=true&availableTranslatedLanguage[]=${md}&${RATINGS}&includes[]=cover_art&includes[]=author`);
      return (j.data || []).map(series);
    },

    async getSeries(id) {
      const j = await mdGet(`${API}/manga/${id}?includes[]=cover_art&includes[]=author`);
      return j.data ? series(j.data) : null;
    },

    async listChapters(seriesId) {
      // This language's chapters and nothing else, English included (v0.62.0). English used to fall back one
      // language at a time when a title had none, so a server set to English only downloaded Spanish or Portuguese
      // chapters with nothing on screen to say why. Since v0.52.0 each language is an adapter of its own, so a title
      // that exists only in Spanish is added from MangaDex (ES-419) instead.
      return feedFor(seriesId, md);
    },

    async getPageUrls(chapterId) {
      const j = await mdGet(`${API}/at-home/server/${chapterId}`, 'atHome');
      const base = j.baseUrl;
      const hash = j.chapter?.hash;
      const files: string[] = j.chapter?.data || [];
      return files.map((f) => `${base}/data/${hash}/${f}`);
    },
  };
}

export const mangadex: SourceAdapter = makeMangadex('en');
