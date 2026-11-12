// A small, forgiving HTML parser and CSS-selector engine.
//
// WHY THIS EXISTS INSTEAD OF A LIBRARY: the Legado rule dialect is not plain CSS. A rule reads
// `class.book-mid-info@tag.a.0@text`, where `.0` picks the n-th match and `!0` drops one -- neither
// is a CSS concept. Whatever parser we used, the dialect would still need a translation layer on top
// of it, so the parser is the only piece that could have been borrowed, and writing it means the
// selector engine and the rule dialect share one set of ideas instead of two.
//
// The parser is deliberately tolerant, because the sites these rules point at are not:
//   - unclosed tags (`<p>text<div>more`) close their parent implicitly,
//   - stray `<` and `>` in text,
//   - attributes written without quotes, with no value, or with unescaped quotes inside,
//   - `<script>`/`<style>` bodies that contain things which look like markup.
// It never throws: a rule that cannot be parsed yields an empty document, which the rule evaluator
// reports as "no match" -- the same outcome the site itself would give for a page that changed.
//
// The selector subset: type, `.class`, `#id`, `[attr]`, `[attr=value]`, `[attr*=value]`, and the
// descendant combinator. That covers every selector Legado rules actually use; `:hover` and friends
// are not in the subset and are treated as "matches nothing" rather than as an error.

export type DomNode = DomElement | DomText | DomComment;

export interface DomElement {
  type: 'element';
  name: string;
  attrs: Record<string, string>;
  children: DomNode[];
  parent: DomElement | null;
}

export interface DomText {
  type: 'text';
  text: string;
  parent: DomElement | null;
}

export interface DomComment {
  type: 'comment';
  text: string;
  parent: DomElement | null;
}

const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);

// Elements whose content is text, not markup. `<title>a < b</title>` is a title, not a tag.
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title']);

// "Optional end tag" rules, in the direction the HTML spec states them: the KEY is the element that
// ARRIVES, and the set is the elements it CLOSES.
//
// The direction matters, and getting it backwards is not a small mistake. Read the other way round --
// "a `<p>` is closed by a `<div>`" turned into "a `<p>` closes a `<div>`" -- the parser pops the
// nearest matching ANCESTOR, so `<ul><li><p>text` closed the `<ul>` and everything inside it was
// silently dropped. Half the page vanished and no rule reported an error.
//
// Only the TOP of the stack is considered: the spec's "immediately followed by" means the element
// being closed is the current one, not something further up.

// These elements close an open `<p>`.
const CLOSES_P = [
  'address', 'article', 'aside', 'blockquote', 'dd', 'details', 'div', 'dl', 'dt', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header',
  'hgroup', 'hr', 'li', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'ul',
];

const CLOSED_BY: Record<string, Set<string>> = {};
for (const tag of CLOSES_P) CLOSED_BY[tag] = new Set(['p']);
CLOSED_BY['li'] = new Set(['p', 'li']);
CLOSED_BY['dd'] = new Set(['p', 'dt', 'dd']);
CLOSED_BY['dt'] = new Set(['p', 'dt', 'dd']);
CLOSED_BY['tr'] = new Set(['p', 'tr', 'td', 'th']);
CLOSED_BY['td'] = new Set(['p', 'td', 'th']);
CLOSED_BY['th'] = new Set(['p', 'td', 'th']);
CLOSED_BY['tbody'] = new Set(['p', 'tr', 'td', 'th', 'thead', 'tbody']);
CLOSED_BY['thead'] = new Set(['p', 'tr', 'td', 'th', 'tbody']);
CLOSED_BY['tfoot'] = new Set(['p', 'tr', 'td', 'th', 'tbody']);
CLOSED_BY['option'] = new Set(['option']);
CLOSED_BY['optgroup'] = new Set(['option', 'optgroup']);

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©',
  reg: '®', hellip: '…', mdash: '—', ndash: '–', ldquo: '“', rdquo: '”',
  lsquo: '‘', rsquo: '’', middot: '·', times: '×', laquo: '«', raquo: '»',
  laquo_: '«', bull: '•', deg: '°', yen: '¥', euro: '€', pound: '£', sect: '§',
  para: '¶', dagger: '†', trade: '™', larr: '←', rarr: '→', harr: '↔',
};

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const hit = ENTITIES[body] ?? ENTITIES[body.toLowerCase()];
    return hit ?? whole;
  });
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let i = 0;
  while (i < raw.length) {
    while (i < raw.length && /[\s/]/.test(raw[i])) i++;
    if (i >= raw.length) break;
    const nameStart = i;
    while (i < raw.length && !/[\s=/>]/.test(raw[i])) i++;
    const name = raw.slice(nameStart, i).toLowerCase();
    if (!name) { i++; continue; }
    while (i < raw.length && /\s/.test(raw[i])) i++;
    if (raw[i] !== '=') { attrs[name] = ''; continue; }
    i++; // '='
    while (i < raw.length && /\s/.test(raw[i])) i++;
    const quote = raw[i];
    if (quote === '"' || quote === "'") {
      i++;
      const end = raw.indexOf(quote, i);
      const value = end === -1 ? raw.slice(i) : raw.slice(i, end);
      i = end === -1 ? raw.length : end + 1;
      attrs[name] = decodeEntities(value);
    } else {
      const start = i;
      while (i < raw.length && !/[\s>]/.test(raw[i])) i++;
      attrs[name] = decodeEntities(raw.slice(start, i));
    }
  }
  return attrs;
}

/** Parse an HTML document into a tree. Never throws. */
export function parseHtml(html: string): DomElement {
  const root: DomElement = { type: 'element', name: '#root', attrs: {}, children: [], parent: null };
  const stack: DomElement[] = [root];
  let i = 0;
  const len = html.length;

  const top = (): DomElement => stack[stack.length - 1];

  while (i < len) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      addText(top(), html.slice(i));
      break;
    }
    if (lt > i) addText(top(), html.slice(i, lt));

    // Comment, doctype, CDATA, closing tag, or an opening tag.
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      const text = end === -1 ? html.slice(lt + 4) : html.slice(lt + 4, end);
      i = end === -1 ? len : end + 3;
      top().children.push({ type: 'comment', text, parent: top() });
      continue;
    }
    if (html.startsWith('<![CDATA[', lt)) {
      const end = html.indexOf(']]>', lt + 9);
      const text = end === -1 ? html.slice(lt + 9) : html.slice(lt + 9, end);
      i = end === -1 ? len : end + 3;
      addText(top(), text);
      continue;
    }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const end = html.indexOf('>', lt);
      i = end === -1 ? len : end + 1;
      continue;
    }

    if (html.startsWith('</', lt)) {
      const end = html.indexOf('>', lt);
      const name = html.slice(lt + 2, end === -1 ? len : end).trim().toLowerCase().split(/[\s/]/)[0];
      i = end === -1 ? len : end + 1;
      // Close the nearest matching open element; if there is none, ignore the stray end tag.
      for (let d = stack.length - 1; d > 0; d--) {
        if (stack[d].name === name) {
          stack.length = d;
          break;
        }
      }
      continue;
    }

    // Opening tag: read the name, then the attributes, then decide whether it is self-closing.
    let j = lt + 1;
    while (j < len && !/[\s/>]/.test(html[j])) j++;
    const name = html.slice(lt + 1, j).toLowerCase();
    if (!name) { i = lt + 1; continue; }

    let k = j;
    let quote: string | null = null;
    while (k < len) {
      const c = html[k];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '>') {
        break;
      }
      k++;
    }
    const attrRaw = html.slice(j, k);
    const selfClosing = /\/\s*$/.test(attrRaw);
    i = k < len ? k + 1 : len;

    // An element whose end tag is optional closes the element it is allowed to close.
    const closes = CLOSED_BY[name];
    if (closes) {
      const top = stack[stack.length - 1];
      if (top && closes.has(top.name)) stack.pop();
    }

    const el: DomElement = { type: 'element', name, attrs: parseAttrs(attrRaw), children: [], parent: top() };
    top().children.push(el);

    if (VOID.has(name) || selfClosing) continue;

    if (RAW_TEXT.has(name)) {
      const closeRe = new RegExp(`</\\s*${name}\\s*>`, 'i');
      const rest = html.slice(i);
      const m = closeRe.exec(rest);
      const body = m ? rest.slice(0, m.index) : rest;
      if (body) el.children.push({ type: 'text', text: body, parent: el });
      i += m ? m.index + m[0].length : rest.length;
      continue;
    }

    stack.push(el);
  }

  return root;
}

function addText(parent: DomElement, text: string): void {
  if (!text) return;
  parent.children.push({ type: 'text', text: decodeEntities(text), parent });
}

// ---------------------------------------------------------------------------------------------
// Traversal
// ---------------------------------------------------------------------------------------------

export function* walk(node: DomNode): Generator<DomNode> {
  yield node;
  if (node.type === 'element') {
    for (const child of node.children) yield* walk(child);
  }
}

export function elementsOf(node: DomNode): DomElement[] {
  const out: DomElement[] = [];
  for (const n of walk(node)) if (n.type === 'element') out.push(n);
  return out;
}

export function isElement(node: unknown): node is DomElement {
  return !!node && typeof node === 'object' && (node as DomNode).type === 'element';
}

/** The element's own text, with the text of its descendants, whitespace-collapsed. */
export function textOf(node: DomNode | null | undefined): string {
  if (!node) return '';
  if (node.type === 'text') return node.text;
  if (node.type === 'comment') return '';
  const parts: string[] = [];
  for (const child of node.children) parts.push(textOf(child));
  return parts.join('').replace(/\s+/g, ' ').trim();
}

/** The element's text WITHOUT collapsing whitespace -- what a body of prose needs. */
export function rawTextOf(node: DomNode | null | undefined): string {
  if (!node) return '';
  if (node.type === 'text') return node.text;
  if (node.type === 'comment') return '';
  return node.children.map(rawTextOf).join('');
}

/** The element's inner HTML, re-serialised. */
export function innerHtmlOf(node: DomNode | null | undefined): string {
  if (!node) return '';
  if (node.type === 'text') return node.text;
  if (node.type === 'comment') return `<!--${node.text}-->`;
  return node.children.map(outerHtmlOf).join('');
}

export function outerHtmlOf(node: DomNode | null | undefined): string {
  if (!node) return '';
  if (node.type === 'text') return node.text;
  if (node.type === 'comment') return `<!--${node.text}-->`;
  const attrs = Object.entries(node.attrs)
    .map(([k, v]) => (v === '' ? ` ${k}` : ` ${k}="${escapeAttr(v)}"`))
    .join('');
  const tag = node.name === '#root' ? '' : node.name;
  if (VOID.has(node.name)) return `<${tag}${attrs}>`;
  return `<${tag}${attrs}>${innerHtmlOf(node)}</${tag}>`;
}

function escapeAttr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// ---------------------------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------------------------

interface Compound {
  tag: string | null;
  classes: string[];
  id: string | null;
  attrs: Array<{ name: string; op: string; value: string }>;
}

interface Selector {
  parts: Compound[]; // in document order: part[0] is the outermost ancestor
  /** child[i] is true when parts[i] must be the DIRECT parent of parts[i - 1]. */
  child: boolean[];
}

function parseCompound(src: string): Compound | null {
  const out: Compound = { tag: null, classes: [], id: null, attrs: [] };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '*') { i++; continue; }
    if (c === '.') {
      i++;
      const start = i;
      while (i < src.length && !/[.#[\s>]/.test(src[i])) i++;
      if (i === start) return null;
      out.classes.push(src.slice(start, i));
      continue;
    }
    if (c === '#') {
      i++;
      const start = i;
      while (i < src.length && !/[.#[\s>]/.test(src[i])) i++;
      if (i === start) return null;
      out.id = src.slice(start, i);
      continue;
    }
    if (c === '[') {
      const end = src.indexOf(']', i);
      if (end === -1) return null;
      // A leading `@` inside the brackets is tolerated: some rules are written in the XPath habit
      // (`[@property='x']`) and losing the whole selector over it would lose the rule.
      const body = src.slice(i + 1, end).replace(/^@/, '');
      const m = /^\s*([-\w:]+)\s*(?:([~^$*|]?=)\s*(.*?)\s*)?$/.exec(body);
      if (!m) return null;
      let value = m[3] ?? '';
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      out.attrs.push({ name: m[1].toLowerCase(), op: m[2] ?? 'exists', value });
      i = end + 1;
      continue;
    }
    if (/[-\w:]/.test(c)) {
      const start = i;
      while (i < src.length && /[-\w:]/.test(src[i])) i++;
      out.tag = src.slice(start, i).toLowerCase();
      continue;
    }
    // `:` (pseudo) and anything else we do not implement: the selector cannot match.
    return null;
  }
  return out;
}

function parseSelector(sel: string): Selector | null {
  const trimmed = sel.trim();
  if (!trimmed) return null;
  const parts: Compound[] = [];
  const child: boolean[] = [];
  // The child combinator. `h3 > a` means "the link inside the heading", which is not the same
  // element as any link further down -- and the rules write it, so it has to mean what it says.
  let pendingChild = false;
  // The split keeps the combinators: whitespace is a descendant step, `>` is a child step.
  for (const token of trimmed.split(/(\s+|>)/)) {
    if (!token) continue;
    if (token === '>') { pendingChild = true; continue; }
    if (/^\s+$/.test(token)) continue;
    const compound = parseCompound(token);
    if (!compound) return null;
    parts.push(compound);
    child.push(pendingChild);
    pendingChild = false;
  }
  return parts.length ? { parts, child } : null;
}

function matchesCompound(el: DomElement, c: Compound): boolean {
  if (c.tag && el.name !== c.tag) return false;
  if (c.id !== null) {
    const id = el.attrs.id ?? '';
    if (id !== c.id) return false;
  }
  if (c.classes.length) {
    const cls = (el.attrs.class ?? '').split(/\s+/).filter(Boolean);
    for (const want of c.classes) if (!cls.includes(want)) return false;
  }
  for (const a of c.attrs) {
    const have = el.attrs[a.name];
    if (have === undefined) return false;
    // `[attr]` asks only that the attribute be there.
    if (a.op === 'exists') continue;
    if (a.op === '=' && have !== a.value) return false;
    if (a.op === '*=' && !have.includes(a.value)) return false;
    if (a.op === '^=' && !have.startsWith(a.value)) return false;
    if (a.op === '$=' && !have.endsWith(a.value)) return false;
    if (a.op === '~=' && !have.split(/\s+/).includes(a.value)) return false;
  }
  return true;
}

function matchesChain(el: DomElement, sel: Selector): boolean {
  const parts = sel.parts;
  const last = parts.length - 1;
  if (!matchesCompound(el, parts[last])) return false;
  let cur: DomElement | null = el;
  for (let d = last - 1; d >= 0; d--) {
    const parent: DomElement | null = sel.child[d + 1]
      ? (cur ? cur.parent : null)
      : ancestorMatching(cur, parts[d]);
    if (!parent || !matchesCompound(parent, parts[d])) return false;
    cur = parent;
  }
  return true;
}

/** The nearest ancestor of `from` that matches the compound. */
function ancestorMatching(from: DomElement | null, c: Compound): DomElement | null {
  let node = from ? from.parent : null;
  while (node) {
    if (matchesCompound(node, c)) return node;
    node = node.parent;
  }
  return null;
}

/**
 * Every element under `root` matching `selector`, in document order.
 * An unusable selector matches nothing -- it never throws.
 */
export function queryAll(root: DomNode, selector: string): DomElement[] {
  const sel = parseSelector(selector);
  if (!sel) return [];
  const out: DomElement[] = [];
  for (const n of walk(root)) {
    if (n.type === 'element' && matchesChain(n, sel)) out.push(n);
  }
  return out;
}

export function queryOne(root: DomNode, selector: string): DomElement | null {
  return queryAll(root, selector)[0] ?? null;
}

/**
 * The elements whose TEXT is the given string.
 *
 * `text.下一页` is how a rule says "the link that says 下一页": the text is the only thing that
 * identifies it, because the site gives it no class and no id. An exact match wins; when there is
 * none, a link that merely CONTAINS the text is used instead, because these links usually read
 * "下一页 >" or "下一页 »" rather than the bare word.
 */
export function elementsByText(root: DomNode, needle: string): DomElement[] {
  const want = needle.trim();
  if (!want) return [];
  const all = elementsOf(root);
  const exact = all.filter((el) => textOf(el) === want);
  if (exact.length) return exact;
  return all.filter((el) => textOf(el).includes(want));
}
