// Probe every book source: run a search through it and record what happened.
//
// This is the measurement the reader needs. A collection of rules is not a set of working sources --
// rules rot, sites change, and a source that returns nothing is indistinguishable from one that was
// never wired up. So each source is actually searched, and the result is kept.
//
//   node --import tsx scripts/novel-probe.ts "斗破苍穹" [maxSources]
//
// Writes `novel-sources/status.json`, which the app reads to show which sources work.

import fs from 'node:fs';
import path from 'node:path';
import { BookSourceJson, LegadoSource } from '../src/lib/novel/legado/source';
import { CookieJar, HttpError } from '../src/lib/novel/legado/http';
import { sourcesDir, sourceIdFor } from '../src/lib/novel/sources';

const query = process.argv[2] || '斗破苍穹';
const maxSources = Number(process.argv[3] || 300);
const CONCURRENCY = 8;

interface ProbeResult {
  id: string;
  name: string;
  baseUrl: string;
  ok: boolean;
  hits: number;
  sample: string[];
  error?: string;
  /**
   * WHY it failed, when it did.
   *
   * `network` means this machine could not reach the site -- the rules may be fine. `blocked` means
   * the site refused us. `dead` means the site answered, but with an error page or nothing at all,
   * so there is no rule that could have matched. `rules` means the page came back with real content
   * and the rules did not match it -- the only one of the four that says anything about the rules.
   */
  reason?: 'network' | 'blocked' | 'dead' | 'rules';
  status?: number;
  pageLength?: number;
  /** Whether the keyword the probe searched for was in the page at all. */
  keywordInPage?: boolean;
  ms: number;
}

/** Tell a dead site apart from a rule that no longer matches. */
function classifyFailure(last: { status: number; length: number } | null | undefined): ProbeResult['reason'] {
  if (!last) return 'dead';
  // An error status, or a page too short to be a search results page.
  if (last.status >= 400) return 'dead';
  if (last.length < 500) return 'dead';
  return 'rules';
}

function readAll(): BookSourceJson[] {
  const dir = sourcesDir();
  const out: BookSourceJson[] = [];
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'status.json');
  } catch {
    return out;
  }
  for (const file of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const s of list) if (s && s.bookSourceUrl) out.push(s);
    } catch {
      /* a file that is not a source collection */
    }
  }
  return out;
}

async function main(): Promise<void> {
  const all = readAll();
  const seen = new Set<string>();
  const sources: LegadoSource[] = [];
  for (const json of all) {
    const id = sourceIdFor(json);
    if (seen.has(id)) continue;
    seen.add(id);
    sources.push(new LegadoSource(json, { id, jar: new CookieJar(), timeoutMs: 15_000 }));
  }
  const todo = sources.slice(0, maxSources);
  console.log(`probing ${todo.length} sources for "${query}"`);

  const results: ProbeResult[] = [];
  let done = 0;

  const workers = Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const source = todo.shift();
      if (!source) return;
      const started = Date.now();
      let result: ProbeResult;
      try {
        const hits = await source.search(query, 1);
        const last = source.lastFetch;
        result = {
          id: source.id,
          name: source.name,
          baseUrl: source.baseUrl,
          ok: hits.length > 0,
          hits: hits.length,
          sample: hits.slice(0, 3).map((h) => h.title),
          reason: hits.length ? undefined : classifyFailure(last),
          status: last?.status,
          pageLength: last?.length,
          keywordInPage: hits.length ? undefined : source.lastBody.includes(query),
          ms: Date.now() - started,
        };
      } catch (err) {
        const http = err instanceof HttpError ? err : null;
        const kind = http?.kind;
        result = {
          id: source.id,
          name: source.name,
          baseUrl: source.baseUrl,
          ok: false,
          hits: 0,
          sample: [],
          error: err instanceof Error ? err.message : String(err),
          reason: kind === 'blocked' ? 'blocked' : kind ? 'network' : 'rules',
          ms: Date.now() - started,
        };
      }
      results.push(result);
      done++;
      if (result.ok) {
        console.log(`  OK     ${result.name.padEnd(18)} hits=${String(result.hits).padEnd(4)} ${result.sample.join(' | ').slice(0, 70)}`);
      } else {
        const tag = result.reason === 'network' ? 'NET' : result.reason === 'blocked' ? 'BLOCK'
          : result.reason === 'dead' ? 'DEAD' : 'RULE';
        const extra = result.status ? ` [${result.status}${result.pageLength ? ` ${result.pageLength}b` : ''}]` : '';
        console.log(`  ${tag.padEnd(6)} ${result.name.padEnd(18)} ${(result.error || '').slice(0, 60)}${extra}`);
      }
    }
  });
  await Promise.all(workers);

  const working = results.filter((r) => r.ok);
  const network = results.filter((r) => r.reason === 'network');
  const blocked = results.filter((r) => r.reason === 'blocked');
  const dead = results.filter((r) => r.reason === 'dead');
  const rules = results.filter((r) => r.reason === 'rules');
  // Of the failures whose page came back: was the keyword in it at all? If it was not, the results
  // were never in the HTML -- the site renders them with JavaScript -- and no rule can match them.
  const rulesWithoutKeyword = rules.filter((r) => r.keywordInPage === false).length;
  console.log(`\nworking     ${working.length}/${results.length}`);
  console.log(`  network   ${network.length}  (this machine could not reach the site)`);
  console.log(`  blocked   ${blocked.length}  (the site refused us)`);
  console.log(`  dead      ${dead.length}  (the site answered with an error page or nothing)`);
  console.log(`  rules     ${rules.length}  (the page came back with content; the rules did not match)`);
  console.log(`    of those, ${rulesWithoutKeyword} had no trace of the keyword in the HTML` +
    ` -- the results are rendered with JavaScript, which no rule can read.`);
  console.log(`median latency ${median(results.map((r) => r.ms))}ms`);

  const status = {
    probedAt: new Date().toISOString(),
    query,
    total: results.length,
    working: working.length,
    breakdown: {
      network: network.length,
      blocked: blocked.length,
      dead: dead.length,
      rules: rules.length,
      rulesWithoutKeyword,
    },
    sources: results.map((r) => ({
      id: r.id, name: r.name, baseUrl: r.baseUrl, ok: r.ok, hits: r.hits,
      error: r.error, reason: r.reason, status: r.status,
      keywordInPage: r.keywordInPage, checkedAt: new Date().toISOString(),
    })),
  };
  const file = path.join(sourcesDir(), 'status.json');
  fs.writeFileSync(file, JSON.stringify(status, null, 2));
  console.log(`wrote ${file}`);
}

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
