// Why the rules did not match, for a batch of sources.
//
//   node --import tsx scripts/dbg-batch.ts [query] [count]
//
// It goes through the source's OWN search path -- the same URL computation, the same JavaScript
// rules, the same character set -- so what it prints is what really happened. The point is to find
// the ONE common reason behind many failures: a rule engine that is subtly wrong fails the same way
// everywhere.

import fs from 'node:fs';
import path from 'node:path';
import { BookSourceJson, LegadoSource } from '../src/lib/novel/legado/source';
import { CookieJar } from '../src/lib/novel/legado/http';
import { queryAll, parseHtml, elementsOf } from '../src/lib/novel/legado/html';
import { sourcesDir, sourceIdFor } from '../src/lib/novel/sources';

const query = process.argv[2] || '修仙';
const want = Number(process.argv[3] || 6);

function readAll(): BookSourceJson[] {
  const dir = sourcesDir();
  const out: BookSourceJson[] = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'status.json')) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      for (const s of (Array.isArray(parsed) ? parsed : [parsed])) if (s?.bookSourceUrl) out.push(s);
    } catch { /* not a collection */ }
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
    sources.push(new LegadoSource(json, { id, jar: new CookieJar(), timeoutMs: 12_000 }));
  }

  let shown = 0;
  for (const source of sources) {
    if (shown >= want) break;
    try {
      const hits = await source.search(query, 1);
      if (hits.length) continue;                       // this one works
    } catch {
      continue;                                        // a network failure is not a rule failure
    }

    const debug = await source.debugSearch(query, 1);
    console.log(`\n================ ${source.name} ================`);
    console.log('base      :', source.baseUrl);
    console.log('requested :', debug.url || '(none)');
    console.log('computed  :', JSON.stringify(debug.computed).slice(0, 300));
    console.log('status    :', debug.status, '| length:', debug.body.length, debug.error ? `| error: ${debug.error}` : '');
    console.log('bookList  :', debug.listRule);
    console.log('rule matched', debug.items, 'items');
    if (!debug.body) continue;

    const root = parseHtml(debug.body);
    const classes = new Map<string, number>();
    for (const el of elementsOf(root)) {
      for (const c of (el.attrs.class ?? '').split(/\s+/).filter(Boolean)) classes.set(c, (classes.get(c) ?? 0) + 1);
    }
    const top = [...classes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
    console.log('top classes:', top.map(([c, n]) => `${c}(${n})`).join(' '));
    console.log('tags       :', ['a', 'li', 'div', 'span', 'p', 'h3', 'h2', 'tr', 'td', 'dd', 'dt']
      .map((t) => { const n = queryAll(root, t).length; return n ? `${t}(${n})` : ''; }).filter(Boolean).join(' '));
    // The decisive question: is the keyword in the page at all? If it is not, the site did not put
    // the results in its HTML -- it renders them with JavaScript, and no rule can read what is not
    // there. That is a different thing from a rule that no longer matches.
    const keywordPresent = debug.body.includes(query);
    console.log(`keyword "${query}" in page:`, keywordPresent ? 'YES' : 'NO',
      keywordPresent ? '' : '  <- the results are not in the HTML (client-side rendered?)');
    console.log('page head  :', debug.body.slice(0, 240).replace(/\s+/g, ' '));
    shown++;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
