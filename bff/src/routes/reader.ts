// The reader's API: no accounts, no login, no library to manage.
//
// Everything the app in `reader/` needs, for anyone who can reach the server. The two sides are the
// engines this server already has -- the manga source adapters (lib/sources/) and the book sources
// (lib/novel/) -- and this file is the thin layer that puts them behind one small, honest API.
//
// WHY IT EXISTS ALONGSIDE THE REST: the app this server grew into is a household's library with
// accounts, collections, comments, trackers and an admin. That is a lot of machinery for one person
// who wants to read. This API drops all of it: no user, no session, no permission. Reading history
// lives in the browser's own storage, so there is nothing here to log in to.
//
// WHAT "NO LOGIN" COSTS, STATED PLAINLY: with no account there is no age cap, no per-household
// access list and no server-side history. An adult source is therefore filtered by the REQUEST --
// `adult=1` asks for it, without it the adult sources are not asked at all -- and the history is the
// browser's own, which means it does not follow a reader to another device.
//
// THE 18+ SWITCH IS ON BY DEFAULT HERE. This is a single-reader server: the person running it asked
// for adult material to be reachable, and the switch is right there in the interface to turn it off.
// A server with accounts on it uses the upstream's rules instead, which are stricter by design.
import type { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import type { SourceAdapter, SourceChapter, SourceSeries } from '../lib/sources/types';
import { sourceCoverInput } from './images';
import { listSources as registeredSources } from '../lib/sources/loader';
import { FILE as CUSTOM_SITES_FILE } from '../lib/sources/customSites';
import {
  getNovelSource, listNovelSources, loadNovelSources, novelSourceCount,
  searchNovelSources, workingNovelSourceIds,
} from '../lib/novel/sources';
import { LegadoSource } from '../lib/novel/legado/source';
import { authorMatches, cleanAuthor, parseQuery, rankByTitle } from '../lib/readerQuery';
import { withSolverDeadline, withStopSignal } from '../lib/sources/flaresolverr';

/** How long one fan-out waits before the slow sources are left out. */
const FANOUT_MS = 12_000;

/**
 * The searches that are running right now.
 *
 * The background shelf pass and a search share the sources' rate limits, and the search is the one
 * the reader is waiting for. So the pass keeps quiet while this is above zero.
 */
let searchesInFlight = 0;

/**
 * How long one source may take inside a fan-out.
 *
 * Twenty seconds. A page of MangaDex is two requests (the feed, then the titles), and on a slow
 * line each of them can take five seconds -- so a page needs ten, not nine. It is still shorter
 * than the fan-out's own wait, and the fan-out's wait is what the reader is counting.
 */
const SOURCE_BUDGET_MS = 20_000;

/**
 * The sources that failed just now, and when they may be asked again.
 *
 * A source that is down cannot answer, and asking it a second time does not make it answer -- it
 * only costs a connection and a slot. Thirty-seven unreachable Chinese sites asked in turn hold
 * thirty-seven connections open for the length of their timeout, and the site that WOULD have
 * answered is left waiting for a connection that never comes. That is the whole story of a shelf
 * that comes back empty right after a fan-out: the live source's own request fails with "fetch
 * failed" while the dead ones sit on the pool.
 *
 * So a source that failed is left alone for a while. The failures are kept in memory and nowhere
 * else: they are a fact about this moment, not about the source forever, and a restart is the
 * honest way to forget them.
 */
const failedUntil = new Map<string, number>();
/**
 * How long a source that just failed is not asked again.
 *
 * A minute and a half. Long enough that a shelf pass does not keep asking the same dead site over
 * and over, and short enough that a network which was having a bad minute gets another chance
 * before the reader has finished reading the last chapter.
 */
const FAIL_COOLDOWN_MS = 90_000;

/**
 * The sources that have answered at least once.
 *
 * They are asked FIRST. A source that has answered is worth asking before one that never has, and
 * the difference is not small: the live source's answer arrives while the dead ones are still
 * holding their connections.
 */
const answeredBefore = new Set<string>();

/**
 * The sources that could not be reached, remembered across restarts.
 *
 * A source that is not there stays not there: the same network asks it again tomorrow and gets the
 * same nothing. Remembering it means the next search does not spend its time on it -- and the
 * search does not have to learn the lesson again after every restart, which is what made the first
 * search of every session slow.
 *
 * The list is a file beside the operator's own site list, and a server that cannot write it simply
 * forgets: that is no worse than before. The operator can delete the file to make the server try
 * those sites again.
 */
const knownDead = new Set<string>();
/** How long a source stays in that list. */
const DEAD_TTL_MS = 24 * 60 * 60 * 1000;
/** How many times a source has to fail before it is called unreachable. */
const DEAD_AFTER = 2;
/** The failures each source has had, this process. */
const failCounts = new Map<string, number>();

const deadFile = (): string => path.join(path.dirname(CUSTOM_SITES_FILE), 'manga-dead.json');

function loadDead(): void {
  try {
    const j = JSON.parse(fs.readFileSync(deadFile(), 'utf8')) as { at?: string; ids?: string[]; counts?: Record<string, number> };
    if (Date.now() - Date.parse(j.at || '') > DEAD_TTL_MS) return;
    for (const id of j.ids ?? []) knownDead.add(id);
    // The counts come back too: a source that failed once before the restart is one failure
    // closer to being called unreachable, and the server does not have to fail it all over again
    // to learn what it already knows.
    for (const [id, n] of Object.entries(j.counts ?? {})) {
      if (typeof n === 'number' && n > 0) failCounts.set(id, n);
    }
  } catch {
    /* no list yet, or one that cannot be read */
  }
}

let deadWrite: NodeJS.Timeout | null = null;
function saveDead(): void {
  // Written once the dust settles: a burst of failures must not write the file thirty times.
  if (deadWrite) return;
  deadWrite = setTimeout(() => {
    deadWrite = null;
    try {
      fs.mkdirSync(path.dirname(deadFile()), { recursive: true });
      fs.writeFileSync(deadFile(), JSON.stringify({
        at: new Date().toISOString(),
        ids: [...knownDead],
        counts: Object.fromEntries(failCounts),
      }, null, 2));
    } catch {
      /* the server cannot write there; it forgets, which is no worse than before */
    }
  }, 2000);
  deadWrite.unref?.();
}

loadDead();

/** Whether this source is still cooling down from a failure. */
function isCooling(id: string): boolean {
  const until = failedUntil.get(id);
  if (until === undefined) return false;
  if (Date.now() >= until) { failedUntil.delete(id); return false; }
  return true;
}

/**
 * Does this failure say the SITE is not there, as opposed to the network being slow?
 *
 * A name that does not resolve, a connection that is refused, a socket that is gone: those are
 * the site. A timeout is not -- it is a slow line, and a source that is slow is still a source.
 * The difference matters because the first kind is worth remembering for a long time and the
 * second is not.
 */
function isHardFailure(err: unknown): boolean {
  const e = err as { name?: string; message?: string } | undefined;
  const message = String(e?.message ?? '');
  if (e?.name === 'AbortError') return false;
  if (/timed? ?out|timeout|aborted|stopped waiting/i.test(message)) return false;
  return /fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|socket|unreachable/i.test(message);
}

/** A source that failed: it is not asked again for a while. */
function noteFailure(id: string, err?: unknown): void {
  failedUntil.set(id, Date.now() + FAIL_COOLDOWN_MS);
  // A source that has answered us before is not written off: a reset socket is the network's
  // bad moment, and a source that has given us four hundred books is not "unreachable".
  if (answeredBefore.has(id)) return;
  // A site that is not there counts for two; a slow answer counts for one. Two is a fact about
  // the source; one may be the network having a bad moment.
  const n = (failCounts.get(id) ?? 0) + (isHardFailure(err) ? 2 : 1);
  failCounts.set(id, n);
  if (n >= DEAD_AFTER && !knownDead.has(id)) {
    knownDead.add(id);
    saveDead();
  } else if (n >= DEAD_AFTER - 1) {
    // One failure short of the mark is worth writing down too: the next failure then decides.
    saveDead();
  }
}

/** A source that answered: whatever was remembered about it is forgotten. */
function noteSuccess(id: string): void {
  failedUntil.delete(id);
  answeredBefore.add(id);
  // A source that has just given us books is not a source that is not there, whatever the last
  // failure said -- and it must not stay in the list of unreachable ones.
  if (knownDead.delete(id)) {
    failCounts.delete(id);
    saveDead();
  }
}

/** Tests only: how many sources are cooling down. */
export const _coolingSources = (): number => failedUntil.size;

/** The adult switch: on unless the request says otherwise. */
const adultAsked = (req: { query?: unknown }): boolean => {
  const q = (req.query as { adult?: string } | undefined)?.adult;
  return q === undefined ? true : q === '1';
};

/**
 * The language the reader wants, as the request says it.
 *
 * `zh` is what a Chinese reader asks for, and it is the default: MangaDex publishes every language
 * on one site, so without this the shelves fill up with whatever is biggest -- which is English.
 * `all` asks for every language there is.
 */
const langAsked = (req: { query?: unknown }): string => {
  const q = (req.query as { lang?: string } | undefined)?.lang;
  const lang = (q ?? 'zh').trim().toLowerCase();
  return LANGUAGES.includes(lang) ? lang : 'zh';
};

/** The languages the app offers. */
const LANGUAGES = ['zh', 'ja', 'ko', 'en', 'all'];

/**
 * Does a source publish in the language the reader asked for?
 *
 * The Chinese MangaDex adapters are two (`zh-Hans` and `zh-Hant`), and a reader who asked for
 * Chinese wants both -- a work translated into traditional Chinese is Chinese too, and there are
 * far more of them than there are simplified ones.
 *
 * A source that does not say what language it is in (`lang` is empty) is left alone: it is a site
 * rather than one language of a site, and the rule that decides is "does it publish Chinese", which
 * such a source cannot answer either way. Those are shown under "all" and under nothing else --
 * hmm, no: a source with no language is shown under EVERY choice, because refusing to show it to
 * somebody who asked for Chinese would be worse than showing it to somebody who wanted English.
 */
function matchesLang(source: SourceAdapter, lang: string): boolean {
  if (lang === 'all') return true;
  if (!source.lang) return true;
  const s = source.lang.toLowerCase();
  if (lang === 'zh') return s === 'zh-hans' || s === 'zh-hant' || s === 'zh';
  return s === lang || s.startsWith(lang + '-');
}

// -----------------------------------------------------------------------------------------------
// The manga side
// -----------------------------------------------------------------------------------------------

/** A source as the reader app shows it. */
function mangaSourceOf(s: SourceAdapter) {
  return {
    id: s.id,
    name: s.name,
    lang: s.lang ?? null,
    isNsfw: !!s.isNsfw,
    canLatest: typeof s.latest === 'function',
    canPopular: typeof s.popular === 'function',
    // Whether this source failed a moment ago and is being left alone for now. It is still in the
    // list -- the reader may name it -- but the fan-out does not spend a slot on it.
    cooling: isCooling(s.id),
  };
}

/** A series as the reader app shows it. */
function mangaCardOf(series: SourceSeries, source: SourceAdapter) {
  return {
    kind: 'manga' as const,
    source: source.id,
    sourceName: source.name,
    id: series.sourceId,
    title: series.title,
    author: series.author ?? null,
    intro: series.summary ?? null,
    coverUrl: series.coverUrl ?? null,
    url: series.url ?? null,
    genres: series.genres ?? [],
    contentRating: series.contentRating ?? null,
    isNsfw: series.contentRating === 'erotica' || series.contentRating === 'pornographic' || !!source.isNsfw,
    updatedAt: series.updatedAt ?? null,
    status: series.status ?? null,
  };
}

/**
 * Ask every source, and answer as soon as there is enough.
 *
 * The sources are asked in parallel, but they do NOT answer at the same speed: MangaDex paces its
 * API at four requests a second, so fourteen languages take seconds to answer together. Waiting for
 * all of them makes the page feel broken, so the answer goes out as soon as there is enough of it --
 * a moment after the first source with results, or when the hard budget runs out, whichever is
 * first. What has not answered by then is simply not in the answer.
 *
 * A source that is slow must not hold up the others and a source that is down must not fail the
 * search, so every source is asked on its own and its failure is kept beside its answer.
 */
async function fanOutManga(
  sources: SourceAdapter[],
  run: (s: SourceAdapter, page: number) => Promise<SourceSeries[]>,
  options: {
    graceMs?: number; maxMs?: number; enough?: number; concurrency?: number; budgetMs?: number; stopEarly?: boolean;
    /** How many pages of each source to ask for. One is the search's answer; a shelf wants more. */
    pages?: number;
    /**
     * Whether to hold off starting new work.
     *
     * The background shelf pass and the reader's search share one rate limit -- MangaDex's, four
     * requests a second -- and the pass asks for hundreds of books. A search that arrives while
     * the pass is running waits behind it, and the reader is the one waiting. So the pass is told
     * to keep quiet while somebody is searching.
     */
    pauseWhile?: () => boolean;
    /** Called with each source's books as they arrive, before the answer goes out. */
    onSeries?: (source: SourceAdapter, series: SourceSeries[]) => void;
  } = {},
): Promise<{ cards: ReturnType<typeof mangaCardOf>[]; errors: Array<{ source: string; error: string }>; partial: boolean }> {
  const graceMs = options.graceMs ?? 1200;
  const maxMs = options.maxMs ?? FANOUT_MS;
  const enough = options.enough ?? 24;
  // How many sources are asked at once. Four is what the upstream searches with, and it matters:
  // fourteen MangaDex languages are ONE site, and asking it twenty-eight times at once is what
  // earns "fetch failed" from it.
  const concurrency = Math.max(1, options.concurrency ?? 4);
  // How long one source may take. It is shorter than the fan-out's own wait on purpose: a source
  // that is still running when the answer has gone out is work nobody is waiting for, and the
  // socket it holds is one the next request needs.
  const budgetMs = options.budgetMs ?? SOURCE_BUDGET_MS;
  // How many pages of each source are asked for.
  const pages = Math.max(1, options.pages ?? 1);

  const cards: ReturnType<typeof mangaCardOf>[] = [];
  const errors: Array<{ source: string; error: string }> = [];

  if (!sources.length) return { cards, errors, partial: false };

  return new Promise((resolve) => {
    let done = false;
    let running = 0;
    let graceTimer: NodeJS.Timeout | null = null;
    const startedAt = Date.now();

    const finish = (partial: boolean) => {
      if (done) return;
      done = true;
      if (graceTimer) clearTimeout(graceTimer);
      resolve({ cards, errors, partial });
    };

    const hardStop = setTimeout(() => finish(true), maxMs);

    /**
     * One source, one page, under a budget.
     *
     * The budget is the point. Without it, a source that is not there holds its socket open for
     * the whole of its own timeout -- and the fan-out has answered by then, so nobody is waiting
     * for it, but the connection is still held. Ask a few dozen of those and the working sources
     * cannot get a connection of their own: the shelf comes back empty while every dead site is
     * still hanging on to something.
     *
     * So each task is given a deadline and a signal. The signal closes the socket when the time
     * is up, and the source that was still running is not remembered as broken -- it was our
     * budget that ran out, not the site.
     */
    const runOne = (source: SourceAdapter, page: number) => {
      // The source gets what is left of the fan-out's wait, and never more than its own budget.
      const left = Math.max(500, Math.min(budgetMs, maxMs - (Date.now() - startedAt)));
      return withSolverDeadline(left, () => withStopSignal(left, () => run(source, page)));
    };

    /**
     * The tasks, in order: each source's pages, one after the other.
     *
     * A source that answers with an empty page has no more pages: the second one would be empty
     * too, and asking it is a request spent on nothing. That is what keeps the deep shelf from
     * turning into a hundred requests to a site that has twelve books.
     *
     * The pages of one source are asked together, so a source that answers does all of its pages
     * before the next source is started -- a live source is finished while the dead ones are still
     * on their first page.
     */
    const cursor = new Map<SourceAdapter, number>();
    const exhausted = new Set<SourceAdapter>();
    /** The sources being asked right now. A source's pages are asked one after the other. */
    const active = new Set<SourceAdapter>();
    /** Where the next source is looked for, so the sources take turns. */
    let turn = 0;

    /**
     * The next task, WITHOUT taking it.
     *
     * It is a peek and not a take because the fan-out has to know whether there is anything left
     * before it says the answer is complete -- and a take would eat a task to find that out.
     *
     * One source's pages are asked one after the other, never all at once: a site that is not
     * there would then be asked for ten pages before its first answer came back, which is ten
     * requests spent on a site that has nothing.
     */
    const peekTask = (): { source: SourceAdapter; page: number } | null => {
      for (let i = 0; i < sources.length; i++) {
        const source = sources[(turn + i) % sources.length];
        if (exhausted.has(source) || active.has(source)) continue;
        const page = (cursor.get(source) ?? 0) + 1;
        if (page > pages) { exhausted.add(source); continue; }
        return { source, page };
      }
      return null;
    };

    const start = () => {
      // No new task is begun when the answer is about to go out: it would be work nobody waits
      // for, holding a socket that the next request needs.
      const left = maxMs - (Date.now() - startedAt);
      // And none while somebody is waiting for a search: the search comes first.
      if (options.pauseWhile?.()) return;
      while (!done && running < concurrency && left > 500) {
        const task = peekTask();
        if (!task) break;
        const { source, page } = task;
        cursor.set(source, page);
        active.add(source);
        running++;
        runOne(source, page)
          .then((series) => {
            // An answer with no books in it is still an answer: the site is up and has nothing for
            // this word. Only a source that FAILED is remembered as failing.
            noteSuccess(source.id);
            // An empty page means there is no page after it.
            if (!series.length) exhausted.add(source);
            options.onSeries?.(source, series);
            for (const s of series) cards.push(mangaCardOf(s, source));
          })
          .catch(async (err) => {
            // One retry, on its own: a source that failed because the network hiccupped is worth
            // asking again, and by the time the retry runs the others have moved on.
            //
            // But a source that ran out of TIME is not asked again straight away: the time is gone,
            // and the retry would only be a second way of not answering. It is asked again on the
            // next request, which is a moment later.
            const ranOutOfTime = (err as { name?: string })?.name === 'AbortError'
              || (err as { selfTimeout?: boolean })?.selfTimeout === true;
            let lastErr = err;
            if (!ranOutOfTime) {
              try {
                const series = await runOne(source, page);
                noteSuccess(source.id);
                if (!series.length) exhausted.add(source);
                options.onSeries?.(source, series);
                for (const s of series) cards.push(mangaCardOf(s, source));
                return;
              } catch (err2) {
                lastErr = err2;
              }
            }
            // A source that did not answer is a source that did not answer -- whatever the reason,
            // including our own budget running out. Remembering it is what keeps the next answer
            // from spending its time on it all over again, and the sites that hang are exactly the
            // ones that must be written off. The exception is a source that has answered us
            // before: that one is alive, whatever this attempt did.
            //
            // Only a failure on the FIRST page says the source is not there. A source that
            // answered page one and then timed out on page four is alive and having a bad
            // minute, and remembering it as broken keeps it out of the next answer.
            if (page === 1) noteFailure(source.id, lastErr);
            // A source that failed has no pages to give either: asking it again for the next
            // page is the same request with a different number on it.
            exhausted.add(source);
            errors.push({ source: source.id, error: lastErr instanceof Error ? lastErr.message : String(lastErr) });
          })
          .finally(() => {
            running--;
            active.delete(source);
            // The source that has just answered goes to the front of the rotation: its NEXT page is
            // asked before another source's first page, so a live source finishes its ten pages in
            // its own slot instead of waiting behind every site that is not there.
            turn = sources.indexOf(source);
            // The first source with results starts the clock: a moment later, the answer goes out with
            // whatever has arrived.
            if (options.stopEarly !== false && cards.length >= enough && !graceTimer) {
              graceTimer = setTimeout(() => { clearTimeout(hardStop); finish(true); }, graceMs);
            }
            start();
          });
      }
      // Nothing left to ask: the answer is the whole of it.
      if (!done && running === 0 && !peekTask()) {
        clearTimeout(hardStop);
        finish(false);
      }
    };
    start();
  });
}

/** A chapter, as the reader app shows it. */
function mangaChapterOf(c: SourceChapter) {
  return {
    id: c.sourceId,
    title: c.title ?? `Chapter ${c.number}`,
    number: c.number,
    pages: c.pages ?? null,
    publishedAt: c.publishedAt ?? null,
    scanlator: c.scanlator ?? null,
  };
}

// -----------------------------------------------------------------------------------------------
// The shelves
//
// A shelf is not an answer, it is a collection. One fan-out cannot ask thirty-nine sources in the
// time a reader is willing to wait: the sources answer at their own speed, the ones that are not
// there take their whole timeout, and the reader is looking at a spinner.
//
// So the shelf keeps what it has collected and collects more in the background, and the reader
// watches it grow. That is also why the sources that failed are remembered for a while: the next
// pass asks the ones that answered last time first and leaves the others alone.
// -----------------------------------------------------------------------------------------------

/** What one shelf holds right now. */
interface Shelf {
  /** The books each source has last said it has. Kept per source so a refresh replaces a source's
   *  books instead of adding a second copy of them. */
  bySource: Map<string, ReturnType<typeof mangaCardOf>[]>;
  /** Whether a pass over the sources is going on right now. */
  running: boolean;
  /** When the last pass finished. */
  at: number;
  /** How many passes have been made. */
  passes: number;
  /** What the sources said when they did not answer. */
  errors: Array<{ source: string; error: string }>;
}

const shelves = new Map<string, Shelf>();

/** The shelf for a sort, made if it is not there yet. */
function shelfFor(sort: string): Shelf {
  let s = shelves.get(sort);
  if (!s) { s = { bySource: new Map(), running: false, at: 0, passes: 0, errors: [] }; shelves.set(sort, s); }
  return s;
}

/** The books of a shelf, in the order they arrived. */
function shelfCards(shelf: Shelf): ReturnType<typeof mangaCardOf>[] {
  const out: ReturnType<typeof mangaCardOf>[] = [];
  for (const books of shelf.bySource.values()) out.push(...books);
  return out;
}

/** How long a shelf is good for before it is collected again. */
const SHELF_TTL_MS = 5 * 60_000;

/**
 * How long a shelf that collected NOTHING is good for.
 *
 * Twenty seconds. A pass that came back empty is not a shelf -- it is a network having a bad
 * minute, and the shelf is worth asking again long before the five minutes a full shelf lasts.
 */
const SHELF_EMPTY_TTL_MS = 20_000;

/** How long one shelf pass may run. */
const SHELF_PASS_MS = 180_000;

/**
 * How many pages of each source a shelf pass asks for.
 *
 * Ten. MangaDex answers a page with twenty-four series and has hundreds of pages of Chinese
 * series behind them, so one page is not a library -- it is the front of one. Ten pages is two
 * hundred and forty series per language, which is a shelf a reader can browse.
 *
 * A source that answers with an empty page is not asked for the pages after it, and a source that
 * fails is not asked again at all, so this costs nothing on a site that has twelve books.
 */
const SHELF_PAGES = 10;

/** Wait for something to become true, up to a time. */
async function waitFor(what: () => boolean, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (!what() && Date.now() < until) {
    await new Promise((go) => setTimeout(go, 150));
  }
}

// -----------------------------------------------------------------------------------------------
// The novel side
// -----------------------------------------------------------------------------------------------

function novelCardOf(hit: { id: string; source: string; title: string; author?: string; intro?: string; kind?: string; lastChapter?: string; coverUrl?: string; url?: string; isNsfw?: boolean }, sourceName: string) {
  return {
    kind: 'novel' as const,
    source: hit.source,
    sourceName,
    id: hit.id,
    title: hit.title,
    // The site's own punctuation is not the author's name: one site says "作者：宅猪" and another
    // says "宅猪 著", and the reader wants to see the name.
    author: hit.author ? cleanAuthor(hit.author) : null,
    intro: hit.intro ?? null,
    kindText: hit.kind ?? null,
    lastChapter: hit.lastChapter ?? null,
    coverUrl: hit.coverUrl ?? null,
    url: hit.url ?? null,
    isNsfw: !!hit.isNsfw,
  };
}

/**
 * The categories a book source publishes, from its `exploreUrl`.
 *
 * A source's explore list is a JSON array of `{ title, url }`: the shelves the site itself offers.
 * The ones with no URL are headings and are skipped -- there is nothing to open.
 */
function exploreCategoriesOf(source: LegadoSource): Array<{ title: string; url: string }> {
  const raw = source.json.exploreUrl;
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: Array<{ title: string; url: string }> = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const title = (item as { title?: unknown }).title;
    const url = (item as { url?: unknown }).url;
    if (typeof title !== 'string' || !title) continue;
    if (typeof url !== 'string' || !url) continue;
    out.push({ title, url });
  }
  return out;
}

// -----------------------------------------------------------------------------------------------
// The routes
// -----------------------------------------------------------------------------------------------

const searchQuery = z.object({
  kind: z.enum(['manga', 'novel']).default('manga'),
  q: z.string().trim().min(1).max(120),
  source: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const sourceQuery = z.object({
  source: z.string().trim().min(1).max(200),
  id: z.string().trim().min(1).max(2000),
});

export default async function readerRoutes(app: FastifyInstance) {
  // The limiter is scoped to these routes: a reader is one person hammering the same few sources, and
  // a burst of requests is a mis-click rather than an attack -- but there is no account to rate-limit
  // by, so it is per address and generous.
  if (!app.hasDecorator('createRateLimit')) await app.register(rateLimit, { global: true, max: 240, timeWindow: '1 minute' });

  /**
   * The sources to ask.
   *
   * The ones that failed a moment ago are left out: they cannot answer, and asking them costs a
   * connection that a working site needs. But never ALL of them -- a shelf with nothing in it
   * because every source failed once is worse than a slow shelf, so when the cooling list would
   * empty the answer, they are asked anyway.
   *
   * `named` is a source the reader picked by hand: they asked for that one, so it is asked even if
   * it failed a moment ago.
   */
  const mangaSources = (req: { query?: unknown }, named = false) => {
    const all = registeredSources();
    const adult = adultAsked(req);
    const lang = langAsked(req);
    const usable = all.filter((s) => (adult || !s.isNsfw) && matchesLang(s, lang));
    if (named) return usable;
    // The sources that could not be reached are left out -- they are not going to answer, and
    // asking them costs the time the sources that DO answer are waiting for.
    const reachable = usable.filter((s) => !knownDead.has(s.id));
    // Never all of them: a shelf with nothing in it is worse than a slow one.
    const fresh = reachable.filter((s) => !isCooling(s.id));
    return fresh.length ? fresh : (reachable.length ? reachable : usable);
  };

  /** The sources the app shows: manga adapters and book sources, side by side. */
  app.get('/api/reader/sources', async (req) => {
    loadNovelSources();
    const adult = adultAsked(req);
    const lang = langAsked(req);
    const manga = registeredSources()
      .filter((s) => (adult || !s.isNsfw) && matchesLang(s, lang))
      .map(mangaSourceOf);
    const novels = listNovelSources().filter((s) => adult || !s.isNsfw);
    return {
      adult: adult || undefined,
      lang,
      manga,
      novels: novels.map((s) => ({ id: s.id, name: s.name, baseUrl: s.baseUrl, isNsfw: s.isNsfw })),
      novelCount: novelSourceCount(),
      workingNovels: workingNovelSourceIds()?.size ?? null,
    };
  });

  /** One search box, two kinds of thing behind it. */
  app.get('/api/reader/search', async (req, reply) => {
    const parsed = searchQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_query' });
    const { kind, q, source, limit } = parsed.data;
    const adult = adultAsked(req);

    // The shelf pass is told to keep quiet while this is above zero: the search is the one the
    // reader is waiting for, and they share the sources' rate limits.
    searchesInFlight++;
    try {
      return await runSearch(req, kind, q, source, limit, adult);
    } finally {
      searchesInFlight--;
    }
  });

  async function runSearch(
    req: { query?: unknown },
    kind: string,
    q: string,
    source: string | undefined,
    limit: number | undefined,
    adult: boolean,
  ) {
    // What the reader typed may name a title AND an author: "帝尊 作者：宅猪". A search box is a
    // title box to every engine, so the whole string would be looked up as a title and find nothing
    // -- or the site's fuzzy leftovers, which is worse.
    const { title, author } = parseQuery(q);

    if (kind === 'novel') {
      const { hits, errors, partial } = await searchNovelSources(title, {
        limit: limit ?? 40,
        // The sources the last probe found working are asked FIRST, not asked alone. The probe ran
        // on the machine that built this file; the reader's machine is a different one, and the
        // sources that could not be reached from here may answer there. Asking only the probe's
        // list is how a reader is told that a book does not exist.
        workingFirst: true,
        sourceIds: source && source !== 'all' ? source.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
        allow: (s) => adult || !s.isNsfw,
        // With an author named, the title alone is not the answer, so the search does not stop at the
        // first three sources that had something: it asks the sources it has until they run out.
        author: author ?? undefined,
        exhaustive: !!author,
      });
      const names = new Map(listNovelSources().map((s) => [s.id, s.name]));
      return {
        kind,
        query: { title, author },
        hits: hits.map((h) => novelCardOf(h, names.get(h.source) ?? h.source)),
        errors: errors.slice(0, 20),
        partial,
      };
    }

    let sources = mangaSources(req, !!source);
    if (source) sources = sources.filter((s) => s.id === source);

    // A source that knows how to search by author is asked by author: MangaDex has the author's own
    // catalogue, which is a better answer than a title search that has to guess which of the books
    // with that title is the one.
    const run = async (s: SourceAdapter) => {
      let byTitle = await s.search(title);
      // Nothing, and the source can search without the language filter: ask it again that way.
      //
      // MangaDex answers a search with the titles that have chapters in the language asked for, and
      // that is right for the downloader and wrong for a reader. A Chinese reader who types 我独自升级
      // wants to see that the book is there -- MangaDex holds that name as an alternative title of a
      // series whose chapters are in other languages -- and "not found" is the wrong answer to give.
      if (!byTitle.length && typeof s.searchAnyLanguage === 'function') {
        try {
          byTitle = await s.searchAnyLanguage(title);
        } catch {
          /* a source that cannot answer that way still answered (with nothing) the first time */
        }
      }
      if (!author || typeof s.searchCreator !== 'function') return byTitle;
      let byAuthor: SourceSeries[] = [];
      try {
        byAuthor = await s.searchCreator(author, 'author');
      } catch {
        /* a source that cannot answer for the author alone still answered for the title */
      }
      // The books that are by that author AND carry that title are the answer; the rest of the
      // author's catalogue is below them, and the lookalikes are below that.
      const want = author;
      const exact: SourceSeries[] = [];
      const rest: SourceSeries[] = [];
      const seen = new Set<string>();
      for (const series of [...byTitle, ...byAuthor]) {
        if (seen.has(series.sourceId)) continue;
        seen.add(series.sourceId);
        const titled = (series.title || '').toLowerCase().includes(title.trim().toLowerCase());
        const byWhom = authorMatches(series.author, want);
        if (titled && byWhom) exact.push(series);
        else rest.push(series);
      }
      return [...exact, ...rest];
    };

    const { cards, errors, partial } = await fanOutManga(sources, run, {
      enough: 40,
      graceMs: 1500,
      // With an author named the list is thinned afterwards, so the early stop would stop too soon.
      maxMs: author ? 20_000 : undefined,
      // A source that is not there gets eight seconds, not the whole search: it has to FAIL
      // before it can be remembered as one that is not there, and a source that is still waiting
      // when the search ends has failed nothing.
      budgetMs: 8_000,
    });
    // The book whose title IS the word comes before the ones that merely carry it. A search for
    // "咒术回战" on a source that indexes thousands of series comes back with a hundred that carry
    // the word in their subtitle, and the one that is called 咒术回战 is somewhere in the middle of
    // them. Nothing is dropped -- the lookalikes are all still there, below.
    const ranked = title.trim() ? rankByTitle(cards, title) : cards;
    return { kind, query: { title, author }, hits: ranked.slice(0, limit ?? 40), errors: errors.slice(0, 20), partial };
  }

  /** The manga shelves: what is new, and what is read. */
  app.get('/api/reader/manga/browse', async (req, reply) => {
    const parsed = z.object({
      sort: z.enum(['latest', 'popular']).default('latest'),
      page: z.coerce.number().int().min(1).max(20).default(1),
      source: z.string().trim().max(200).optional(),
    }).safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_query' });
    const { sort, page } = parsed.data;

    let sources = mangaSources(req, !!parsed.data.source);
    if (parsed.data.source) sources = sources.filter((s) => s.id === parsed.data.source);

    const run = async (s: SourceAdapter, p: number): Promise<SourceSeries[]> => {
      if (sort === 'latest') return s.latest ? s.latest(p) : [];
      return s.popular ? s.popular(p) : [];
    };

    // A source the reader named: that one source, asked now, with nothing kept in between.
    if (parsed.data.source) {
      const { cards, errors, partial } = await fanOutManga(sources, run, { enough: 24, graceMs: 1200, pages: SHELF_PAGES });
      return { sort, hits: cards, errors: errors.slice(0, 20), partial };
    }

    // The shelf itself: what has been collected so far, plus a pass over the sources going on in
    // the background.
    //
    // The reader is not made to wait for the pass. They get what is there now, and the page says
    // that more is coming; the app asks again a moment later and the shelf has grown. A shelf that
    // answers with one source's books because that source was the quickest is not a shelf.
    const shelf = shelfFor(sort);
    const ttl = shelf.bySource.size ? SHELF_TTL_MS : SHELF_EMPTY_TTL_MS;
    const stale = Date.now() - shelf.at > ttl;
    if (!shelf.running && (stale || shelf.passes === 0)) {
      shelf.running = true;
      // The sources that have answered before are asked first. The ones that never have are asked
      // after them, so the shelf is not held up by a site that is not there.
      const asked = sources.slice().sort((a, b) => Number(answeredBefore.has(b.id)) - Number(answeredBefore.has(a.id)));
      // What this pass collects. A source that answers replaces its old books; one that does not
      // answer keeps what it had, because a bad minute at one site is no reason to empty the shelf.
      const collected = new Map<string, ReturnType<typeof mangaCardOf>[]>();
      // The pass runs on its own: nobody is waiting for it, and it must not be cut short by the
      // reader's request going away.
      void fanOutManga(asked, run, {
        enough: 24,
        graceMs: 1200,
        stopEarly: false,
        maxMs: SHELF_PASS_MS,
        pages: SHELF_PAGES,
        // The reader's search comes first: the pass stops taking new work while one is running.
        pauseWhile: () => searchesInFlight > 0,
        onSeries: (source, series) => {
          const list = collected.get(source.id) ?? [];
          list.push(...series.map((s) => mangaCardOf(s, source)));
          collected.set(source.id, list);
          // Into the shelf as well, so the reader watches it grow instead of waiting for the pass
          // to end. A source that has not answered this pass keeps what it had.
          shelf.bySource.set(source.id, list);
        },
      }).then(({ errors }) => {
        for (const [id, books] of collected) shelf.bySource.set(id, books);
        shelf.running = false;
        shelf.at = Date.now();
        shelf.passes++;
        shelf.errors = errors.slice(0, 20);
      });
    }

    // On the first visit there is nothing to show yet, so wait a little for the first answers.
    if (shelf.bySource.size === 0) await waitFor(() => shelf.bySource.size > 0, 5000);

    const hits = shelfCards(shelf);
    return {
      sort,
      hits,
      errors: shelf.errors,
      // Whether the shelf is still being filled. The app asks again while this is true.
      pending: shelf.running,
      partial: shelf.running,
    };
  });

  /** A manga's details and its chapters. */
  app.get('/api/reader/manga/book', async (req, reply) => {
    const parsed = sourceQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_query' });
    const source = registeredSources().find((s) => s.id === parsed.data.source);
    if (!source) return reply.code(404).send({ error: 'not_found' });
    try {
      const [series, chapters] = await Promise.all([
        source.getSeries(parsed.data.id),
        source.listChapters(parsed.data.id),
      ]);
      if (!series) return reply.code(404).send({ error: 'not_found' });
      return {
        ...mangaCardOf(series, source),
        chapters: chapters.map(mangaChapterOf),
      };
    } catch (err) {
      return reply.code(502).send({ error: 'source_failed', message: (err as Error).message });
    }
  });

  /** The pages of a chapter: the image URLs, in order. */
  app.get('/api/reader/manga/pages', async (req, reply) => {
    const parsed = sourceQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_query' });
    const source = registeredSources().find((s) => s.id === parsed.data.source);
    if (!source) return reply.code(404).send({ error: 'not_found' });
    try {
      const urls = await source.getPageUrls(parsed.data.id);
      return { urls };
    } catch (err) {
      return reply.code(502).send({ error: 'source_failed', message: (err as Error).message });
    }
  });

  /** The novel shelves: the categories the book sources publish. */
  app.get('/api/reader/novel/explore', async (req, reply) => {
    loadNovelSources();
    const adult = adultAsked(req);
    const out: Array<{ source: string; sourceName: string; categories: Array<{ title: string; url: string }> }> = [];
    for (const s of listNovelSources()) {
      if (!adult && s.isNsfw) continue;
      const source = getNovelSource(s.id);
      if (!source) continue;
      const categories = exploreCategoriesOf(source);
      if (categories.length) out.push({ source: s.id, sourceName: s.name, categories });
    }
    // The shelves come back in the order the sources are loaded, which puts a dead source next to a
    // live one with no difference between them. The last probe knows which ones answered, so the
    // ones that did come first: the reader opens this page and clicks a category, and the first
    // category should be one that opens.
    const working = workingNovelSourceIds();
    if (working) {
      out.sort((a, b) => Number(working.has(b.source)) - Number(working.has(a.source)));
    }
    // 129 sources of shelves is a wall of text, not a shelf. The rest are still one search away.
    const limit = 60;
    return { shelves: out.slice(0, limit), total: out.length };
  });

  /** The books on one of those shelves. */
  app.get('/api/reader/novel/shelf', async (req, reply) => {
    const parsed = z.object({
      source: z.string().trim().min(1).max(200),
      url: z.string().trim().min(1).max(2000),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }).safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_query' });
    const source = getNovelSource(parsed.data.source);
    if (!source) return reply.code(404).send({ error: 'not_found' });
    try {
      const hits = await source.searchShelf(parsed.data.url);
      return { hits: hits.slice(0, parsed.data.limit ?? 40).map((h) => novelCardOf(h, source.name)) };
    } catch (err) {
      return reply.code(502).send({ error: 'source_failed', message: (err as Error).message });
    }
  });

  /** A book's details and its table of contents. */
  app.get('/api/reader/novel/book', async (req, reply) => {
    const parsed = sourceQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_query' });
    const source = getNovelSource(parsed.data.source);
    if (!source) return reply.code(404).send({ error: 'not_found' });
    try {
      const book = await source.info(parsed.data.id);
      if (!book) return reply.code(404).send({ error: 'not_found' });
      return {
        ...novelCardOf(book, source.name),
        chapters: book.chapters.map((c) => ({
          id: c.id,
          title: c.title,
          index: c.index,
          url: c.url ?? null,
          isVip: !!c.isVip,
        })),
      };
    } catch (err) {
      return reply.code(502).send({ error: 'source_failed', message: (err as Error).message });
    }
  });

  /** A chapter's text. */
  app.get('/api/reader/novel/chapter', async (req, reply) => {
    const parsed = sourceQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_query' });
    const source = getNovelSource(parsed.data.source);
    if (!source) return reply.code(404).send({ error: 'not_found' });
    try {
      const content = await source.content(parsed.data.id);
      if (!content) return reply.code(404).send({ error: 'not_found' });
      return { title: content.title ?? null, text: content.text };
    } catch (err) {
      return reply.code(502).send({ error: 'source_failed', message: (err as Error).message });
    }
  });

  /**
   * What an image really is, from its first bytes.
   *
   * The route used to answer `content-type: image/webp` for everything, because that is what the
   * cover route answers -- but this route hands over the bytes the source served, untouched, and a
   * PNG labelled as webp is a PNG some browsers refuse to draw. The type is decided by the bytes,
   * not by what anybody said about them.
   */
  function imageTypeOf(buffer: Buffer): string {
    if (buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
      return 'image/png';
    }
    if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return 'image/jpeg';
    }
    if (buffer.length > 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
      return 'image/webp';
    }
    if (buffer.length > 3 && buffer.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
    if (buffer.length > 4 && buffer.toString('ascii', 0, 4) === 'AVIF') return 'image/avif';
    return 'image/jpeg';
  }

  /**
   * An image, fetched here rather than by the browser.
   *
   * A page's images sit on the source's own servers, which refuse a hot-linked request from another
   * host, and which the browser may not reach at all. Fetching them here -- with the source's own
   * referer and a browser-ish agent -- is what makes the pages appear.
   *
   * The deadline is a minute, not the cover route's twenty seconds: a comic page is several
   * megabytes, and on a slow link twenty seconds is not enough to fetch one. The reader waited for
   * the answer to time out and got a blank rectangle for every page of the chapter.
   *
   * `source` says which source the image belongs to, and it is what makes the fetch work: MangaDex's
   * CDN answers 403 to a request that does not name it as the referer, and the referer is a property
   * of the SOURCE (`https://mangadex.org/`), not of the image. Without it every cover was a
   * placeholder and every page of every chapter was blank.
   */
  app.get('/api/reader/img', async (req, reply) => {
    const parsed = z.object({
      u: z.string().trim().min(1).max(4000),
      source: z.string().trim().max(200).optional(),
      referer: z.string().trim().max(2000).optional(),
    }).safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_query' });
    try {
      const buffer = await sourceCoverInput(parsed.data.u, parsed.data.source, { timeoutMs: 60000 });
      reply.header('content-type', imageTypeOf(buffer));
      reply.header('cache-control', 'public, max-age=86400');
      return reply.send(buffer);
    } catch {
      return reply.code(502).send({ error: 'fetch_failed' });
    }
  });
}
