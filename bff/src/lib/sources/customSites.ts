// User-added "template" sites (Admin → Providers → Add a site). The core writes a JSON list; this reads it and
// instantiates a generic-engine adapter per entry, registering each. Re-run at boot + on reload, so adding a
// site needs no rebuild. (loader.ts must NOT import this file — keep the dependency one-directional.)
import { readFileSync } from 'fs';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { forDesktop } from '../desktop';
import type { SourceAdapter } from './types';
import { registerAdapter } from './loader';
import { editionLang } from '../lang';
import { makeMadara } from './engines/madara';
import { makeManganato } from './engines/manganato';
import { makeMangaThemesia } from './engines/mangathemesia';
import { makeAutoSite } from './engines/auto';

/**
 * One site added by address, as sites.json keeps it. `lang` (v0.62.0): the language the site is in, from its pages when
 * it was added (detect.ts siteLanguage) or from its sheet; absent, the site is in the unstated language (lib/lang.ts).
 */
export interface Site { engine?: string; id?: string; name?: string; base?: string; order?: number; lang?: string }
/**
 * Where the operator's template sites live. Written by Admin, read by the pack on every reload.
 *
 * ⚠️ The server keeps the literal `/config/sites.json` even when CONFIG_DIR points elsewhere: an install
 * that moved CONFIG_DIR has its sites at the old path today, and following CONFIG_DIR would make every one
 * of them vanish on upgrade. The desktop app has no `/config` (on Windows it would mean `C:\config`), so
 * there the file follows CONFIG_DIR, the one place the rest of its settings live.
 */
export const FILE = process.env.CUSTOM_SITES_FILE
  || forDesktop('/config/sites.json', join(process.env.CONFIG_DIR || '/config', 'sites.json'));

/**
 * The operator's site list, as a file.
 *
 * These were closures inside the admin routes. The watchdog needs them too, because following a site to a
 * new domain means rewriting this list, and that is the one auto-fix worth having: a moved domain is the
 * most common way a source dies and the only one with an unambiguous correct answer.
 */
export async function readSites(): Promise<Site[]> {
  try {
    const j = JSON.parse(await readFile(FILE, 'utf8'));
    return Array.isArray(j) ? j : [];
  } catch { return []; }
}

/**
 * The sites that ship with the app.
 *
 * The operator's own file is ADDED to this list, not instead of it: the list here is a starting
 * point -- the Chinese manga sites a reader would expect to find -- and the operator's file is where
 * they add the ones only they know about. A site in both is the operator's (their file is read last
 * and wins), because the operator asked for it by name.
 *
 * Resolved the way `apiDocs.ts` finds openapi.yaml: relative to this file, which is `dist/lib/` in
 * the image and `src/lib/` in the checkout.
 */
export const BUNDLED_FILE = resolve(__dirname, '..', '..', '..', 'manga-sites.json');

/** The sites that ship with the app, as a file. */
export function readBundledSites(): Site[] {
  try {
    const j = JSON.parse(readFileSync(BUNDLED_FILE, 'utf8'));
    return Array.isArray(j) ? j : [];
  } catch { return []; }
}

export async function writeSites(list: Site[]): Promise<void> {
  await mkdir(dirname(FILE), { recursive: true }).catch(() => {});
  await writeFile(FILE, JSON.stringify(list, null, 2));
}

function build(s: Site): SourceAdapter | null {
  if (!s.id || !s.base) return null;
  // As a source's code (lib/lang.ts editionLang): the file is the operator's, and a hand-written "ES" is Spanish and
  // "es-MX" the Latin American edition; "all" or nonsense declares nothing.
  const cfg = { id: s.id, name: s.name || s.id, base: s.base, order: s.order, lang: editionLang(s.lang) ?? undefined };
  if (s.engine === 'madara') return makeMadara(cfg);
  if (s.engine === 'manganato') return makeManganato(cfg);
  if (s.engine === 'mangathemesia') return makeMangaThemesia(cfg);
  // "auto": the engine is not known, so the app works it out by trying them (engines/auto.ts). A list of
  // sites written down before their theme was known -- or before it changed -- is the common case.
  if (s.engine === 'auto') return makeAutoSite(cfg);
  return null;
}

/**
 * Register every site via its generic engine: the ones that ship with the app, then the operator's.
 *
 * The operator's list is read LAST, so a site in both is the operator's version -- they asked for it
 * by name, and a name they gave beats a name we guessed.
 */
export function loadCustomSites(): number {
  const sites = [...readBundledSites()];
  let mine: Site[] = [];
  try { mine = JSON.parse(readFileSync(FILE, 'utf8')); } catch { /* no file yet → the bundled list alone */ }
  const byId = new Map<string, Site>();
  for (const s of sites) if (s?.id) byId.set(s.id, s);
  for (const s of Array.isArray(mine) ? mine : []) if (s?.id) byId.set(s.id, s);

  let n = 0;
  for (const s of byId.values()) {
    const a = build(s);
    if (a && registerAdapter(a)) n++;
  }
  return n;
}
