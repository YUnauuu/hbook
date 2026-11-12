// Re-measure which book sources work, through the running server's own API.
//
// `scripts/novel-probe.ts` drives the engine directly and is the tool to use when the engine
// changes. This one asks the SERVER instead, which measures the thing that actually matters: what a
// reader pressing a key in the browser gets. The two answer the same question from different sides,
// and the difference between them is worth knowing -- a source can work in the engine and still not
// work through the app, if the app's rate limiter or its time budget is what stands in the way.
//
//   node scripts/novel-reprobe.mjs [baseUrl] [query]
//
// Writes `novel-sources/status.json`, which the app reads to decide which sources to ask.

import fs from 'node:fs';
import path from 'node:path';

const base = process.argv[2] || 'http://127.0.0.1:3000/api/reader';
const query = process.argv[3] || '修仙';
/**
 * How many sources are asked at once.
 *
 * Low on purpose. Asking 283 sources at once is what earns "connection reset" from the sites that
 * are answering -- the app asks its verified list at once and gets four sources back out of two
 * hundred and eighty, while the same sources asked one at a time answer every time. Four is enough
 * to finish in reasonable time and low enough that the sites keep answering.
 */
const CONCURRENCY = 4;

const dir = path.resolve(process.cwd(), '..', 'novel-sources');
const statusPath = path.join(dir, 'status.json');

/** Every source id the probe knows about, and what it said last time. */
function loadPrevious() {
  try {
    const parsed = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    return Array.isArray(parsed.sources) ? parsed.sources : [];
  } catch {
    return [];
  }
}

const previous = loadPrevious();
const all = previous.map((s) => s.id).filter(Boolean);
if (!all.length) {
  console.error('No source list in status.json -- run novel-probe.ts first.');
  process.exit(1);
}

const results = new Map();

async function measure(id) {
  const started = Date.now();
  const url = `${base}/search?kind=novel&q=${encodeURIComponent(query)}&source=${encodeURIComponent(id)}&adult=1&limit=3`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text();
      return { id, ok: false, hits: 0, sample: [], ms: Date.now() - started, error: text.slice(0, 120) };
    }
    const body = await res.json();
    const hits = (body.hits || []).length;
    return {
      id,
      ok: hits > 0,
      hits,
      sample: (body.hits || []).slice(0, 3).map((h) => h.title),
      ms: Date.now() - started,
    };
  } catch (err) {
    return { id, ok: false, hits: 0, sample: [], ms: Date.now() - started, error: String(err.message || err).slice(0, 120) };
  }
}

/** One retry: a source that failed on a hiccup is worth asking again. */
async function measureWithRetry(id) {
  const first = await measure(id);
  if (first.ok) return first;
  if (!/fetch failed|ECONNRESET|timeout|timed out/i.test(first.error || '')) return first;
  return measure(id);
}

let next = 0;
let done = 0;
const workers = Array.from({ length: CONCURRENCY }, async () => {
  while (next < all.length) {
    const id = all[next++];
    const result = await measureWithRetry(id);
    results.set(id, result);
    done++;
    if (result.ok) console.log(`[${done}/${all.length}] ✓ ${id} — ${result.hits} 本 (${result.ms}ms)`);
    else if (done % 10 === 0) console.log(`[${done}/${all.length}] ${id} — ${result.error || '没有结果'}`);
  }
});

await Promise.all(workers);

// The old file's shape is kept: the app reads `sources[].ok`, and the probe's own fields are
// carried over so a reader can still tell a network failure from a rule failure.
const sources = previous.map((old) => {
  const fresh = results.get(old.id);
  if (!fresh) return old;
  return {
    ...old,
    ok: fresh.ok,
    hits: fresh.hits,
    sample: fresh.sample.length ? fresh.sample : old.sample,
    ms: fresh.ms,
    ...(fresh.error ? { error: fresh.error } : { error: undefined }),
  };
});

const working = sources.filter((s) => s.ok).length;
const out = {
  probedAt: new Date().toISOString(),
  query,
  total: sources.length,
  working,
  breakdown: {
    working,
    failed: sources.length - working,
  },
  sources,
};
fs.writeFileSync(statusPath, JSON.stringify(out, null, 2) + '\n');
console.log(`\n${working}/${sources.length} 个源能搜出书。已写入 ${statusPath}`);
