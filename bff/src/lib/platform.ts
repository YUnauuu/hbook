// Which kind of install this is, as far as the server can tell (#72).
//
// Only one thing reads it: Admin → Extensions, to open its setup steps on the right platform. Adding the extension
// engine is a different job on each -- a line in .env on Compose, a second template on Unraid, an imported add-on
// on CasaOS, nothing at all on Umbrel -- and a page that shows all four at once reads as four problems. A wrong
// guess costs one tap on another platform chip, so this is a hint and never a gate: no behaviour anywhere else
// depends on it.
//
// Read from process.env directly, like admin.ts's EMBEDDED_DB, and not through env.ts: none of these are settings
// of hbook's, and a value env.ts refused would exit the server at boot over a label.

export type InstallPlatform = 'compose' | 'unraid' | 'casaos' | 'umbrel' | 'unknown';

/** What HBOOK_PLATFORM may say. The CasaOS listing and the Unraid template set it; anything else is ignored. */
export const PLATFORM_HINTS: ReadonlySet<string> = new Set(['compose', 'unraid', 'casaos', 'umbrel']);

/**
 * The install's platform, most specific evidence first:
 *   1. an explicit HBOOK_PLATFORM hint (the CasaOS listing and the Unraid template carry one);
 *   2. HOST_OS=Unraid, which Unraid's Docker manager adds to every container it starts -- the fallback for a
 *      template made before the hint existed;
 *   3. EXTENSION_ENGINE present at all: every v0.49.0 compose file passes it to the app, and nothing else does;
 *   4. otherwise unknown (an older compose file, a hand-written `docker run`).
 *
 * `e` is a parameter for the tests; the server calls it without one.
 */
export function installPlatform(e: NodeJS.ProcessEnv = process.env): InstallPlatform {
  const hint = (e.HBOOK_PLATFORM ?? '').trim().toLowerCase();
  if (PLATFORM_HINTS.has(hint)) return hint as InstallPlatform;
  if ((e.HOST_OS ?? '').trim().toLowerCase() === 'unraid') return 'unraid';
  if (e.EXTENSION_ENGINE !== undefined) return 'compose';
  return 'unknown';
}
