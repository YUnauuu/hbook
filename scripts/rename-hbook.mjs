// Rename the project to hbook.
//
// This is the script that did it, kept in the tree so the rename is reproducible and reviewable
// rather than a pile of hand edits. Running it again on the renamed tree changes nothing.
//
//   node scripts/rename-hbook.mjs [--dry]
//
// The rule the whole thing rests on:
//
//   the PROJECT's name changes, the ACCOUNT does not.
//
// So github.com/AngeloSha/uchiyomi becomes github.com/YUnauuu/hbook -- the project is ours, the
// account was the operator's to change, and they have -- and every name this project owns
// (containers, images, volumes, networks, the configuration prefix, the cookies, the API's own
// field names, the localStorage keys, the service worker's cache names) becomes hbook.
//
// The third party's names are NOT ours and are left exactly as they are: suwayomi, tachiyomi,
// mihon, komga, flaresolverr, madara, manganato, postgres. A reader of this code has to be able to
// tell at a glance which names belong to hbook and which belong to something else, and the word
// boundaries are what keep "Suwayomi" from becoming "Suwahbook".
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DRY = process.argv.includes('--dry');

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'out', '.next', 'coverage', '.turbo']);
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.zip', '.gz', '.mp4', '.webm', '.pdf', '.mp3']);

// The script itself talks about the old names, so it must not rewrite its own rules.
const SELF = 'scripts/rename-hbook.mjs';

// The third party's names are NOT ours and are left exactly as they are -- see the header.

const RULES = [
  // ---- the project name in the three cases it is written in --------------------------------
  // The upstream's own spellings. "Uchiyomi" in prose, "uchiyomi" in paths and URLs,
  // "UCHIYOMI" in the places a shell variable or a cookie is written in caps.
  [/\bUchiyomi\b/g, 'hbook'],
  [/\buchiyomi\b/g, 'hbook'],
  [/\bUCHIYOMI(?![A-Za-z0-9])/g, 'HBOOK'],

  // ---- the short name ---------------------------------------------------------------------
  // "yomi" on its own: the database role, the container's system user, the API's `yomi` block,
  // the cookie and localStorage names, the service worker's cache names, the OPDS feed's URNs.
  // The lookbehinds are the guard: a word boundary already keeps "suwayomi" and "tachiyomi" out,
  // and these make it explicit at the point of the rule.
  [/(?<!suwa)(?<!Suwa)(?<!SUWA)(?<!tachi)(?<!Tachi)(?<!TACHI)\bYOMI(?![A-Za-z0-9])/g, 'HBOOK'],
  [/(?<!suwa)(?<!Suwa)(?<!SUWA)(?<!tachi)(?<!Tachi)(?<!TACHI)\bYomi(?![A-Za-z0-9])/g, 'hbook'],
  [/(?<!suwa)(?<!Suwa)(?<!SUWA)(?<!tachi)(?<!Tachi)(?<!TACHI)\byomi(?![A-Za-z0-9])/g, 'hbook'],
  // Inside an identifier: __yomiInstall, the desktop's window hook.
  [/(?<!suwa)(?<!Suwa)(?<!SUWA)(?<!tachi)(?<!Tachi)(?<!TACHI)\byomi(?=[A-Z])/g, 'hbook'],
  // A second database in the end-to-end walk.
  [/\byomi2\b/g, 'hbook2'],
  // The screenshot script's network on the maintainer's server. It was yomi_uchiyomi_app upstream,
  // and the two rules above would have turned that into hbook_hbook_app.
  [/\bhbook_hbook_app\b/g, 'hbook_app'],
  [/\byomi_hbook_app\b/g, 'hbook_app'],
];

function transform(text) {
  let out = text;
  for (const [from, to] of RULES) out = out.replace(from, to);
  return out;
}

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), files);
    } else {
      if (SKIP_EXT.has(path.extname(entry.name).toLowerCase())) continue;
      files.push(path.join(dir, entry.name));
    }
  }
  return files;
}

let changed = 0;
for (const file of walk(ROOT)) {
  const rel = path.relative(ROOT, file);
  if (rel === SELF) continue;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
  if (text.includes('\u0000')) continue;               // binary that slipped through
  const next = transform(text);
  if (next === text) continue;
  changed++;
  const hits = (text.match(/yomi/gi) || []).length;
  console.log(`${rel}  (${hits})`);
  if (!DRY) fs.writeFileSync(file, next);
}
console.log(`\n${changed} file(s) ${DRY ? 'would change' : 'changed'}.`);
