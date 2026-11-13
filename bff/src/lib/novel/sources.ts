// The registry of book sources.
//
// Sources come from JSON collections -- the same format the Legado reader uses, so a collection
// that works in Legado works here. They are read from a directory (`NOVEL_SOURCES_PATH`, default
// `./novel-sources`) and every `*.json` in it is loaded: either one source, or an array of them.
//
// A source is identified by its URL, which is what a book is addressed by inside it. The same site
// appears in several collections; the one with the most rules wins, because a collection that adds
// rules to a source usually adds BETTER ones.

import fs from 'node:fs';
import path from 'node:path';
import { BookSourceJson, LegadoSource } from './legado/source';
import { CookieJar } from './legado/http';
import { authorMatches, rankByTitle, titleRank } from '../readerQuery';
import { NovelHit, NovelSourceInfo } from './types';

export interface SourceStatus {
  /** When the source was last probed. */
  checkedAt?: string;
  /** What the probe found. */
  status?: 'unknown' | 'ok' | 'broken';
  /** The reason it broke, when it did. */
  detail?: string;
}

interface Registered {
  source: LegadoSource;
  status: SourceStatus;
  /** How many rules the source has -- more rules means a more specific source. */
  ruleCount: number;
}

const registry = new Map<string, Registered>();
const statusById = new Map<string, SourceStatus>();
let loaded = false;

/**
 * How long the search keeps going after it already has enough books.
 *
 * The search answers as soon as one source has returned the whole page of results, and this is how
 * long it lets the sources that are already in flight finish. A moment is enough to catch a second
 * source's worth of results and to make the list less lopsided; any longer and the reader is waiting
 * for a source they cannot see.
 */
const GRACE_MS = 600;

/**
 * How many different sources have to contribute before the search calls itself done.
 *
 * One source is not enough: a source whose search rule quietly matches the site's home page answers
 * with forty books that have nothing to do with the word, and if that source happens to answer first
 * the whole page is noise. Three sources that agree is a result; one source that answers is a
 * coincidence.
 */
const ENOUGH_SOURCES = 3;

/**
 * How long one source may take inside a search.
 *
 * Eight seconds. A source that answers in less is not affected, and one that does not answer at all
 * is let go of in eight seconds rather than in the twenty it would take on its own -- a search asks
 * two hundred sources, and the unreachable ones are most of them.
 */
const SOURCE_TIMEOUT_MS = 8_000;

/**
 * The search's deadline.
 *
 * A hundred and thirty sources, six at a time, is a minute of asking. The reader asked for a word,
 * not for a census, so the search stops asking and answers with what it has. This is what the
 * deadline is for: it is the difference between a search that takes a second and one that takes a
 * minute, and it is why the answer says how much of itself it is.
 */
const SEARCH_DEADLINE_MS = 6000;

function ruleCountOf(json: BookSourceJson): number {
  let n = 0;
  for (const stage of [json.ruleSearch, json.ruleBookInfo, json.ruleToc, json.ruleContent]) {
    if (!stage) continue;
    for (const v of Object.values(stage)) if (typeof v === 'string' && v.trim()) n++;
  }
  return n;
}

/**
 * The sources directory: the env var, or the bundled one.
 *
 * The bundled one is resolved from this file's own location rather than from the working
 * directory, because the two differ between running from source (`bff/src/lib/novel/`) and running
 * the built server (`bff/dist/lib/novel/`) -- and the working directory is wherever the operator
 * happened to start it.
 *
 * ⚠️ The two layouts are NOT the same depth. From source, `novel-sources/` is a sibling of `bff/`,
 * four levels up. In the image the server's code is at `/app/dist/lib/novel` and the sources were
 * copied to `/app/novel-sources` -- three levels up. Four levels up there is `/`, and the sources
 * were not found: the reader showed no novels at all, with nothing to say about it.
 *
 * So: the places they may be, in order, and the first that exists wins.
 */
export function sourceDirCandidates(dirname: string = __dirname): string[] {
  const configured = process.env.NOVEL_SOURCES_PATH;
  if (configured) return [path.resolve(configured)];
  return [
    path.resolve(dirname, '../../../..', 'novel-sources'), // the repository root (running from source)
    path.resolve(dirname, '../../..', 'novel-sources'),    // the image: beside dist/, at /app/novel-sources
  ];
}

/** The sources directory: the first candidate that is really there. */
export function sourcesDir(dirname: string = __dirname): string {
  const candidates = sourceDirCandidates(dirname);
  for (const dir of candidates) if (fs.existsSync(dir)) return dir;
  return candidates[0];
}

/** Read every source out of one JSON file. */
function readSources(file: string): BookSourceJson[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.filter((s) => s && typeof s === 'object');
    if (parsed && typeof parsed === 'object') return [parsed];
  } catch {
    // A file that is not JSON may still be JSON with a byte-order mark, or a `.json` that holds
    // something else entirely. Either way it contributes nothing.
  }
  return [];
}

/** Load every source from the sources directory. Safe to call twice. */
export function loadNovelSources(): number {
  const dir = sourcesDir();
  const jar = new CookieJar();
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    files = [];
  }

  let added = 0;
  for (const file of files) {
    for (const json of readSources(path.join(dir, file))) {
      if (!json.bookSourceUrl) continue;
      if (json.enabled === false) continue;
      const id = sourceIdFor(json);
      const rules = ruleCountOf(json);
      const existing = registry.get(id);
      if (existing && existing.ruleCount >= rules) continue;
      const source = new LegadoSource(json, { id, jar, knownHit });
      registry.set(id, { source, status: statusById.get(id) ?? {}, ruleCount: rules });
      added++;
    }
  }
  loaded = true;
  return added;
}

/** The id of a source: its URL, without the scheme and the trailing slash. */
export function sourceIdFor(json: BookSourceJson): string {
  const url = (json.bookSourceUrl || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return url || (json.bookSourceName || 'unknown').toLowerCase().replace(/\s+/g, '-');
}

/** Force the next `loadNovelSources` to re-read the directory. */
export function reloadNovelSources(): void {
  registry.clear();
  loadNovelSources();
}

export function isNovelSourcesLoaded(): boolean {
  return loaded;
}

export function novelSourceCount(): number {
  return registry.size;
}

/** Every source, as the list the UI shows. */
export function listNovelSources(): NovelSourceInfo[] {
  const out: NovelSourceInfo[] = [];
  for (const [id, entry] of registry) {
    out.push({
      id,
      name: entry.source.name,
      baseUrl: entry.source.baseUrl,
      isNsfw: entry.source.isNsfw,
      canExplore: Boolean(entry.source.json.enabledExplore && entry.source.json.exploreUrl),
      lastCheckedAt: entry.status.checkedAt,
      status: entry.status.status ?? 'unknown',
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  return out;
}

export function getNovelSource(id: string): LegadoSource | null {
  return registry.get(id)?.source ?? null;
}

/** Remember how a source's last probe went. */
export function setSourceStatus(id: string, status: SourceStatus): void {
  statusById.set(id, status);
  const entry = registry.get(id);
  if (entry) entry.status = status;
}

export function getSourceStatus(id: string): SourceStatus {
  return statusById.get(id) ?? registry.get(id)?.status ?? {};
}

/**
 * The books a search has recently seen, by their URL.
 *
 * A source with no `ruleBookInfo` rules has no book page of its own to read the details from: the
 * title it showed in the search IS the title it knows. Legado keeps that pairing, and so does this
 * -- the search remembers what it found, and the book page falls back to it.
 *
 * The map is small and bounded: it is a fallback, not a cache.
 */
const seenHits = new Map<string, NovelHit>();
const SEEN_HITS_MAX = 2000;

export function rememberHit(hit: NovelHit): void {
  if (!hit.url) return;
  seenHits.set(hit.url, hit);
  if (seenHits.size > SEEN_HITS_MAX) {
    const oldest = seenHits.keys().next();
    if (!oldest.done) seenHits.delete(oldest.value);
  }
}

export function knownHit(url: string): NovelHit | undefined {
  return seenHits.get(url);
}

/**
 * The sources the last probe found working, by id.
 *
 * The probe (scripts/novel-probe.ts) searches every source and writes down which ones answered.
 * That answer is what makes a search usable: asking 280 sites for one title takes long enough that
 * the reader gives up, and most of them answer nothing anyway. Reading the probe's list and asking
 * only the sources that work turns a 25-second, mostly-empty answer into a fast one.
 *
 * Null when there is no probe yet -- which means "ask everybody", not "ask nobody".
 */
let workingIds: Set<string> | null | undefined;

export function workingNovelSourceIds(): Set<string> | null {
  if (workingIds !== undefined) return workingIds;
  workingIds = null;
  try {
    const raw = fs.readFileSync(path.join(sourcesDir(), 'status.json'), 'utf8');
    const parsed = JSON.parse(raw) as { sources?: Array<{ id: string; ok: boolean }> };
    if (Array.isArray(parsed.sources)) {
      workingIds = new Set(parsed.sources.filter((s) => s.ok).map((s) => s.id));
    }
  } catch {
    /* no probe yet */
  }
  return workingIds;
}

/** Forget the probe's answer, so the next read looks again. */
export function forgetWorkingNovelSources(): void {
  workingIds = undefined;
}

/**
 * Search every source, or the ones named.
 *
 * The sources are searched CONCURRENTLY, but each one is searched on its own -- a site that is slow
 * must not hold up the others, and one that is down must not fail the search. A source that throws
 * contributes nothing and is remembered as broken.
 *
 * CONCURRENTLY, BUT NOT ALL AT ONCE. The verified list has a hundred sources in it now, and asking
 * a hundred sites at the same moment is what earns "connection reset" from the sites that were
 * answering: the same hundred sources, asked a few at a time, answer every time. Six at a time is
 * what the search costs in wall-clock and what it saves in failed requests.
 *
 * And the answer goes out as soon as there is enough of it. One source often returns forty books by
 * itself, so waiting for the hundredth source to answer is waiting for nothing -- the search should
 * feel like a search and not like a roll call.
 *
 * `allow` decides which sources may be searched at all. The 18+ filter is applied HERE rather than
 * to the results, because searching an adult source and then hiding its hits would still have asked
 * the adult site for them.
 */
export async function searchNovelSources(
  query: string,
  options: {
    sourceIds?: string[];
    limit?: number;
    page?: number;
    /** Which sources this caller may search. */
    allow?: (source: LegadoSource) => boolean;
    /**
     * Ask the sources the last probe found working FIRST.
     *
     * It is an order and not a filter: the probe ran somewhere else, and a source that did not
     * answer there may answer here. Only the sources that answered first are asked first.
     */
    workingFirst?: boolean;
    /** How long the search keeps asking. */
    deadlineMs?: number;
    /** How many sources are asked at once. */
    concurrency?: number;
    /**
     * The author the reader asked for, when the query named one.
     *
     * The search runs TWICE then: once for the title, once for the author. Most Chinese novel sites
     * index their authors as well as their titles, so the second search finds the author's books
     * even when the title search does not -- and a book is the answer when BOTH agree.
     */
    author?: string;
    /** Do not stop early, however many books have come back. */
    exhaustive?: boolean;
  } = {},
): Promise<{ hits: NovelHit[]; errors: Array<{ source: string; error: string }>; partial: boolean }> {
  const working = options.workingFirst ? workingNovelSourceIds() : null;
  const all = options.sourceIds?.length
    ? options.sourceIds.map((id) => registry.get(id)?.source).filter(Boolean) as LegadoSource[]
    : [...registry.values()]
      // The probe's list is a filter on the registry, not a separate list: a source that is not in
      // the registry any more cannot be searched however well it did last time.
      .map((e) => e.source);
  // The probe's list says which sources answered FROM WHERE THE PROBE RAN. That is not where the
  // reader is: half of the sources that failed here are perfectly reachable from a house in
  // China, and dropping them from the search is how a reader ends up told that a book does not
  // exist. So the list is an ORDER, not a wall -- the sources that worked are asked first, and the
  // rest are asked after them, when the search has not already found its answer.
  const wanted = working
    ? [...all.filter((s) => working.has(s.id)), ...all.filter((s) => !working.has(s.id))]
    : all;

  const visible = options.allow ? wanted.filter(options.allow) : wanted;
  const limit = options.limit ?? 40;
  const concurrency = Math.max(1, options.concurrency ?? 6);

  // The answer is per source, in the order the sources were asked, so the same search gives the same
  // list twice -- and a source that failed is remembered beside the ones that answered.
  const perSource: Array<{ hits: NovelHit[]; byAuthor?: NovelHit[] } | { error: string } | undefined> = new Array(visible.length);
  const errors: Array<{ source: string; error: string }> = [];

  let enough = false;
  let graceTimer: NodeJS.Timeout | null = null;
  let next = 0;
  const sourcesWithHits = new Set<string>();
  /** The sources that have a book whose title IS the word. */
  const sourcesWithExact = new Set<string>();

  const collect = (index: number, result: { hits: NovelHit[]; byAuthor?: NovelHit[] } | { error: string }) => {
    perSource[index] = result;
    if ('hits' in result) {
      if (result.hits.length) sourcesWithHits.add(visible[index]?.id ?? '');
      if (result.hits.some((h) => titleRank(h.title, query) === 0)) sourcesWithExact.add(visible[index]?.id ?? '');
      // The first source with enough books starts the clock: a moment later the answer goes out.
      // Not when an author was named: the list is thinned afterwards, so stopping early would stop
      // before the source that actually has the book was asked.
      //
      // And not when the books are only LOOKALIKES: a source that answers with "神魔帝尊" and
      // "万古帝尊" has not answered a search for "帝尊" -- the book that is called 帝尊 is somewhere
      // else. So the search carries on until it has a book whose title IS the word, and only then
      // does it let itself stop early.
      //
      // Two sources that both have the book IS the answer, and it does not have to wait for a full
      // page of lookalikes to be collected as well: the reader asked for one book, and two sources
      // agreeing that it exists is the end of the asking.
      if (!enough && !options.exhaustive) {
        let have = 0;
        for (const r of perSource) if (r && 'hits' in r) have += r.hits.length;
        const full = have >= limit && sourcesWithHits.size >= ENOUGH_SOURCES && sourcesWithExact.size > 0;
        const exact = sourcesWithExact.size >= 2;
        if (full || exact) {
          enough = true;
          graceTimer = setTimeout(() => { next = visible.length; }, GRACE_MS);
        }
      }
    } else {
      errors.push({ source: visible[index]?.id ?? 'unknown', error: result.error });
      setSourceStatus(visible[index]?.id ?? 'unknown', {
        status: 'broken',
        checkedAt: new Date().toISOString(),
        detail: result.error,
      });
    }
  };

  const runOne = async (index: number) => {
    const source = visible[index];
    // What this source may take. A source that is not there would otherwise hold its slot for its
    // own full timeout -- twenty seconds, which is longer than the whole search is willing to take
    // -- and the answer would go out late for the want of one unreachable site.
    const budget = Math.max(1000, Math.min(SOURCE_TIMEOUT_MS, deadlineAt - Date.now()));
    try {
      const found = await source.search(query, options.page ?? 1, { timeoutMs: budget });
      setSourceStatus(source.id, { status: 'ok', checkedAt: new Date().toISOString() });
      // Remembered so a book page can fall back to what the search already knew.
      for (const hit of found) rememberHit(hit);
      // The author's books, from the same source, in the same request: the site indexes its authors
      // as well as its titles, so asking for the author alone finds the book the title search missed.
      let byAuthor: NovelHit[] = [];
      if (options.author) {
        try {
          byAuthor = await source.search(options.author, options.page ?? 1, { timeoutMs: budget });
        } catch {
          /* a source that cannot answer for the author alone still answered for the title */
        }
      }
      collect(index, { hits: found, byAuthor });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      collect(index, { error: message });
    }
  };

  // The pool. Each worker takes the next source, and a source that answers hands the worker back.
  // The deadline stops the pool from taking on new work; the sources already in flight finish.
  const deadlineMs = options.deadlineMs ?? SEARCH_DEADLINE_MS;
  const deadlineAt = Date.now() + deadlineMs;
  const deadline = setTimeout(() => { next = visible.length; }, deadlineMs);
  const worker = async () => {
    while (next < visible.length) {
      const index = next++;
      await runOne(index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, visible.length) }, worker));
  clearTimeout(deadline);
  if (graceTimer) clearTimeout(graceTimer);

  // The hits are collected in the order the sources were asked, not the order they answered, so the
  // list does not shuffle between two searches for the same word.
  const ordered: NovelHit[] = [];
  for (const result of perSource) {
    if (result && 'hits' in result) ordered.push(...result.hits);
    // The books the author's own search found: the title search missed them, because the site's
    // search does not match a title against a word the author wrote.
    if (result && 'hits' in result && result.byAuthor?.length) ordered.push(...result.byAuthor);
  }
  // With an author named, the books that ARE by that author come first, and the rest stay below.
  // The reader asked for one book by one author; a title that matches but an author that does not is
  // a different book, and saying so is the difference between an answer and a list of lookalikes.
  if (options.author) {
    const want = options.author;
    const mine: NovelHit[] = [];
    const others: NovelHit[] = [];
    const seen = new Set<string>();
    for (const hit of ordered) {
      const key = `${hit.source}|${hit.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (authorMatches(hit.author, want)) mine.push(hit);
      else others.push(hit);
    }
    ordered.length = 0;
    ordered.push(...mine, ...others);
  }
  // The books whose TITLE says the word come first -- and the book whose title IS the word comes
  // before the ones that merely carry it.
  //
  // A site that has no result for the word still answers with a page, and that page often carries a
  // "you might like this" list in the same markup the rule reads -- so the rule finds books that have
  // nothing to do with the question. Nothing is dropped: the books are still there, below the ones
  // that are actually answers. But the book the reader asked for is the first thing they see.
  //
  // The four buckets are: the title IS the word, the title begins with it, the title carries it
  // somewhere, and the title does not carry it at all. Without the first bucket a search for 帝尊
  // comes back with 万古帝尊 and 神魔帝尊 on top and the one book called 帝尊 at the bottom of the
  // page, which is the same as not finding it.
  if (query.trim()) {
    const ranked = rankByTitle(ordered, query);
    ordered.length = 0;
    ordered.push(...ranked);
  }
  // Whether the answer is the whole thing or a slice of it. The sources that were never asked are
  // the ones the deadline cut, so the answer says so rather than pretending.
  const asked = perSource.filter(Boolean).length;
  return { hits: ordered.slice(0, limit), errors, partial: asked < visible.length };
}
