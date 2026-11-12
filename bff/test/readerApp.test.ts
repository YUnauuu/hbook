// The reader app's own files.
//
// The app in `reader/` is three files with no build step, so nothing checks them: a typo in the
// markup or a rule in the stylesheet ships exactly as written. These tests are the checks.
//
// The one that matters most is the last one. The reader's overlay is a full-screen panel, and the
// browser's own `[hidden] { display: none }` does NOT hide it: an author style wins over a
// user-agent style, and the overlay's rule says `display: flex`. The overlay then sat on top of a
// perfectly good page, and the reader saw a blank screen while the app worked perfectly behind it.
// The server's access log is what proved it -- the API calls and the cover images were all there.
//
// Pure file checks: no browser, no network, no database.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';

const REPO = join(__dirname, '..', '..');
const READER = join(REPO, 'reader');

const html = readFileSync(join(READER, 'index.html'), 'utf8');
const css = readFileSync(join(READER, 'style.css'), 'utf8');
const js = readFileSync(join(READER, 'app.js'), 'utf8');

/** The style rules: selector -> declarations. Good enough for what is asked of it below. */
function rules(source: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  // Comments out, so a rule mentioned in prose is not mistaken for a rule.
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    for (const selector of m[1].split(',')) {
      const sel = selector.trim();
      if (sel) out.push({ selector: sel, body: m[2] });
    }
  }
  return out;
}

/** The elements the markup hides with the `hidden` attribute, and the classes they carry. */
function hiddenElements(): Array<{ tag: string; id: string; classes: string[] }> {
  const out: Array<{ tag: string; id: string; classes: string[] }> = [];
  const re = /<([a-zA-Z][\w-]*)([^>]*?)\bhidden\b([^>]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const attrs = `${m[2]} ${m[3]}`;
    const id = /id="([^"]+)"/.exec(attrs)?.[1] ?? '';
    const cls = /class="([^"]+)"/.exec(attrs)?.[1] ?? '';
    out.push({ tag: m[1], id, classes: cls.split(/\s+/).filter(Boolean) });
  }
  return out;
}

test('the markup is well-formed enough to parse', () => {
  // Every id the script reaches for has to exist -- either in the markup, or in the markup the
  // script writes itself (the history's "clear" button is created when the page is drawn).
  const ids = [...new Set([...js.matchAll(/\$\('#([a-zA-Z][\w-]*)'\)/g)].map((m) => m[1]))];
  for (const id of ids) {
    const inMarkup = html.includes(`id="${id}"`);
    const inScript = js.includes(`id="${id}"`);
    assert.ok(inMarkup || inScript, `app.js uses #${id}, which nothing ever creates`);
  }
});

test('the script parses', () => {
  // A syntax error in app.js is a blank page, and the browser's console is the only place it shows.
  assert.doesNotThrow(() => {
    // eslint-disable-next-line no-new-func
    new Function(js);
  }, 'app.js does not parse');
});

test('every hidden element is really hidden', () => {
  const problems: string[] = [];
  const all = rules(css);
  for (const el of hiddenElements()) {
    const selectors = [el.id && `#${el.id}`, ...el.classes.map((c) => `.${c}`)].filter(Boolean) as string[];
    for (const rule of all) {
      // Does this rule apply to the element?
      const applies = selectors.some((sel) =>
        rule.selector.split(',').some((s) => s.trim() === sel || s.trim().startsWith(sel + ':') || s.trim().startsWith(sel + ' ')));
      if (!applies) continue;
      const display = /display\s*:\s*([^;]+)/i.exec(rule.body)?.[1]?.trim().toLowerCase();
      if (!display || display === 'none') continue;
      // The rule sets a display value, so the browser's `[hidden] { display: none }` is overridden.
      // There has to be a rule that puts it back.
      const rescued = all.some((r) =>
        r.selector.split(',').some((s) => s.trim().endsWith('[hidden]') && r.body.includes('display: none')));
      if (!rescued) {
        problems.push(
          `${el.tag}${el.id ? '#' + el.id : ''}${el.classes.length ? '.' + el.classes.join('.') : ''} `
          + `is hidden, but "${rule.selector}" sets display: ${display} and nothing puts it back`,
        );
      }
    }
  }
  assert.deepEqual(problems, [], `\n  ${problems.join('\n  ')}`);
});

test('the 18+ switch is always sent, so "off" means off', () => {
  // The server treats a MISSING `adult` as "yes". A reader who turned the switch off must have
  // that said out loud, or the adult sources are asked for anyway.
  assert.match(js, /searchParams\.set\('adult',\s*state\.adult\s*\?\s*'1'\s*:\s*'0'\)/,
    'the adult parameter is not always sent');
});

test('a chapter knows what kind of thing it belongs to', () => {
  // The reader overlay has to know whether it is showing pages or text. It reads that off the
  // chapter list, not off a variable left over from the last read.
  assert.match(js, /data-kind="novel"/, 'the novel chapter list does not say what it is');
  assert.match(js, /data-kind="manga"/, 'the manga chapter list does not say what it is');
});
