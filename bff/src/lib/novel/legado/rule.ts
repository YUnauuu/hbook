// The Legado rule evaluator.
//
// A book source is a set of small instructions that say how to read ONE site: which CSS selector
// holds the title, which holds the chapter list, how to pull the text out of a chapter page. This
// file is the interpreter for those instructions.
//
// The dialect, as the sources actually use it:
//
//   class.book-mid-list@tag.li@text   CSS chain: elements with the class, then `li` inside each,
//                                     then their text
//   class.author@tag.a.0@text         `.0` takes the FIRST match only; no index means "all of them"
//   class.author@tag.a!0@text         `!0` means "all of them except the first"
//   tag.a.-1@href                     a negative index counts from the end
//   $.data.list                       a JSON path
//   $..book_data[0]                   a JSON path with a recursive descent
//   {{$.volume_name}}•{{$.words}}字   a template: JSON paths interpolated into a string
//   //meta[@property='og:title']/@content   an XPath
//   :"sS":(\d),.*?"cN":"(.*?)"        a regex over the whole page; `$1`/`$2` then read its groups
//   @js:result.replace(...)           a JavaScript expression
//   <js> ... </js>                    a JavaScript block
//   a || b                            the first alternative that yields something
//   a && b                            both, joined
//
// The one rule that decides everything else: the FIRST rule of a stage is usually the LIST rule, and
// every other rule of that stage is then read RELATIVE TO EACH ITEM of the list. `ruleSearch.bookList`
// says where the results are; `ruleSearch.name` says where the title is *inside* one result. That is
// why the same rule string can mean different things in different stages, and why `evalList` and
// `evalField` are separate functions.

import {
  DomElement, DomNode, elementsByText, innerHtmlOf, outerHtmlOf, parseHtml, queryAll, rawTextOf, textOf,
} from './html';
import { jsonPath } from './jsonpath';
import { evalJsExpression, evalJsRule, JsRuntime } from './js';

export type RuleKind = 'css' | 'json' | 'xpath' | 'regex' | 'js' | 'text';

export interface RuleScope {
  /** The raw text this scope reads from. */
  content: string;
  /** The DOM for it, when the content is HTML. Built lazily. */
  node?: DomNode;
  /** The parsed JSON for it, when the content is JSON. */
  json?: unknown;
  /** Capture groups of the last regex that ran in this scope. */
  groups: string[];
  /** The URL the content came from -- where relative links resolve against. */
  origin: string;
  /** True when the content is JSON, so a `$.` path can be used without saying so. */
  isJson: boolean;
  /**
   * The runtime a JavaScript step in this scope may use.
   *
   * A chain can end in a script (`@onclick@js:result.match(...)`), and that script needs the
   * source's runtime -- its headers, its cookie jar, its ability to fetch a page.
   */
  runtime?: JsRuntime;
  /**
   * The dialect the STAGE is written in, when the list rule decided it.
   *
   * A source does not repeat the dialect on every rule: it says `$.data.list[*]` once for the list
   * and then writes `name`, `author`, `coverUrl` -- which are JSON keys, not CSS selectors. The stage
   * inherits its list rule's dialect, and this is where that inheritance is recorded.
   */
  mode?: 'json' | 'xpath';
}

/** The runtime a scope carries, when it has one. */
function jsRuntimeOf(scope: RuleScope): JsRuntime {
  return scope.runtime ?? new JsRuntime();
}

export interface RuleEnv {
  /** The URL the rule is running against. */
  url: string;
  /** The runtime for JavaScript rules (network, cookies, the DOM). */
  runtime: JsRuntime;
  /** Where a rule's `{{...}}` template reads from. */
  vars: Record<string, unknown>;
}

export function makeScope(content: string, origin: string, groups: string[] = []): RuleScope {
  const trimmed = content.trim();
  const isJson = (trimmed.startsWith('{') || trimmed.startsWith('[')) && looksLikeJson(trimmed);
  const scope: RuleScope = { content, groups, origin, isJson };
  if (isJson) {
    try {
      scope.json = JSON.parse(trimmed);
    } catch {
      scope.isJson = false;
    }
  }
  return scope;
}

function looksLikeJson(s: string): boolean {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

function domOf(scope: RuleScope): DomNode {
  if (!scope.node) scope.node = parseHtml(scope.content);
  return scope.node;
}

// ---------------------------------------------------------------------------------------------
// Splitting a rule into its parts
// ---------------------------------------------------------------------------------------------

/**
 * Split on `&&` and `||`, which are the only two operators, at the top level only -- an `&&` inside
 * a JavaScript block, or inside a regex, is not an operator.
 */
export function splitOperators(rule: string): Array<{ op: 'and' | 'or'; rule: string }> {
  const parts: Array<{ op: 'and' | 'or'; rule: string }> = [];
  let buf = '';
  let op: 'and' | 'or' = 'or';
  let inJs = false;
  let inRegex = false;
  for (let i = 0; i < rule.length; i++) {
    const c = rule[i];
    if (inJs) {
      if (rule.startsWith('</js>', i)) { inJs = false; buf += '</js>'; i += 4; continue; }
      buf += c;
      continue;
    }
    if (rule.startsWith('<js>', i)) { inJs = true; buf += '<js>'; i += 3; continue; }
    if (c === '#' && rule[i + 1] === '#') { inRegex = true; }
    if (!inRegex && (rule.startsWith('&&', i) || rule.startsWith('||', i))) {
      parts.push({ op, rule: buf.trim() });
      op = rule.startsWith('&&', i) ? 'and' : 'or';
      buf = '';
      i++;
      continue;
    }
    buf += c;
  }
  parts.push({ op, rule: buf.trim() });
  return parts.filter((p) => p.rule.length > 0 || parts.length === 1);
}

/**
 * Split a rule on `@`, but never inside a JavaScript block.
 *
 * The `@` separates chain steps, and a step says what to do with what the previous step found:
 *
 *   `class.item@tag.a@text`   select by class, then the link inside it, then its text
 *   `a@href`                  the link's address
 *   `img@src`                 the image's source
 *   `text.下一页@href`         the element whose text is 下一页, then its address
 *   `css:td:eq(1)@text`       a raw CSS selector, then its text
 *
 * Legado's own three prefixes (`class.`, `id.`, `tag.`) are one spelling of the same thing, and the
 * collections use all of them -- so a step is read by what it LOOKS like, not by which spelling it
 * came in. `parseCssStep` is where that decision is made.
 */
export function splitChain(rule: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inJs = false;
  for (let i = 0; i < rule.length; i++) {
    if (rule.startsWith('<js>', i)) { inJs = true; buf += '<js>'; i += 3; continue; }
    if (rule.startsWith('</js>', i)) { inJs = false; buf += '</js>'; i += 4; continue; }
    if (!inJs && rule[i] === '@') {
      out.push(buf.trim());
      buf = '';
      continue;
    }
    buf += rule[i];
  }
  out.push(buf.trim());
  return out.filter((s) => s.length > 0);
}

/** Which dialect a rule is written in. */
export function kindOf(rule: string): RuleKind {
  const r = rule.trim();
  if (r.startsWith('<js>')) return 'js';
  if (r.startsWith('@js:')) return 'js';
  // A template is not a JSON path, even though it starts with `{`.
  if (r.includes('{{') && r.includes('}}')) return 'text';
  // A rule that starts with `:` is a regex over the page: `:"sS":(\d),.*?"cN":"(.*?)"`.
  if (r.startsWith(':')) return 'regex';
  if (r.startsWith('$.') || r.startsWith('$[') || r.startsWith('{')) return 'json';
  if (r.startsWith('//') || r.startsWith('./') || r.includes('/@')) return 'xpath';
  // A `##` on the end of a rule is a REPLACEMENT applied to what the rule produced -- not a regex
  // rule in its own right. `id.ChapterContents@html##(ad text)[\s\S]+` reads the element and then
  // strips the advertisement from it; reading the whole thing as a regex would apply the pattern to
  // the page and lose the content entirely.
  if (splitRule(r).replace) return 'css';
  if (r.includes('##')) return 'regex';
  return 'css';
}

/**
 * A rule split into the part that SELECTS and the part that REWRITES what it selected.
 *
 * `##` cuts a rule into at most three parts: the selector, a pattern, and a replacement.
 *
 *   `class.update@tag.p@text##最新更新 `   selects the text, then REMOVES the label from it
 *   `id.content@html##(ad)[\s\S]+`         selects the element, then removes the advertisement
 *   `##pattern##replacement`                no selector: the pattern is applied to the page itself
 *
 * Two parts means the pattern is removed; three means it is replaced. The distinction matters:
 * reading the whole of `id.content@html##(ad)[\s\S]+` as a regex rule would apply the pattern to
 * the PAGE and throw the content away instead of the advertisement.
 */
export interface SplitRule {
  /** The part that selects. */
  selector: string;
  /** The pattern and replacement that follow the selector, when there are any. */
  replace?: { pattern: string; replacement: string };
}

export function splitRule(rule: string): SplitRule {
  const trimmed = rule.trim();
  // A whole-rule regex has no selector at all: `:"pattern"` is the rule.
  if (trimmed.startsWith(':')) return { selector: trimmed };
  const parts = trimmed.split('##');
  if (parts.length < 2) return { selector: trimmed };
  return {
    selector: parts[0],
    replace: {
      pattern: parts[1],
      replacement: parts.length >= 3 ? parts.slice(2).join('##') : '',
    },
  };
}

/** Apply a rule's `##pattern##replacement` to what it produced. */
function applyReplacement(text: string, replace: { pattern: string; replacement: string } | undefined): string {
  if (!replace || !text) return text;
  // An empty pattern matches everywhere and would delete the whole value.
  if (!replace.pattern) return text;
  try {
    return text.replace(new RegExp(replace.pattern, 'g'), replace.replacement);
  } catch {
    // A pattern that will not compile leaves the text as it was.
    return text;
  }
}

// ---------------------------------------------------------------------------------------------
// CSS chain
// ---------------------------------------------------------------------------------------------

interface CssStep {
  kind: 'select' | 'text' | 'html' | 'outer' | 'attr' | 'textNodes' | 'js' | 'textMatch';
  selector: string;
  index: number | null;
  exclude: number | null;
  attr: string;
}

/**
 * The HTML tags a rule may name directly.
 *
 * The collections name a tag the way a person writes it: `a@href` is "the link's address" and
 * `img@src` is "the image's source". This list only has to cover the tags that actually appear --
 * a name that is neither a tag nor an attribute is read as an attribute, which is what Legado
 * does with it anyway.
 */
const HTML_TAGS = new Set([
  'a', 'abbr', 'address', 'article', 'aside', 'audio', 'b', 'bdi', 'bdo', 'blockquote', 'body',
  'br', 'button', 'canvas', 'caption', 'center', 'code', 'col', 'colgroup', 'dd', 'del',
  'details', 'dfn', 'dialog', 'div', 'dl', 'dt', 'em', 'embed', 'fieldset', 'figcaption', 'figure',
  'font', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hgroup', 'hr',
  'html', 'i', 'iframe', 'img', 'input', 'ins', 'kbd', 'label', 'legend', 'li', 'main', 'map',
  'mark', 'menu', 'meta', 'nav', 'nobr', 'ol', 'optgroup', 'option', 'output', 'p', 'param',
  'picture', 'pre', 'progress', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'script', 'section',
  'select', 'small', 'source', 'span', 'strike', 'strong', 'sub', 'summary', 'sup', 'svg', 'table',
  'tbody', 'td', 'template', 'textarea', 'tfoot', 'th', 'thead', 'time', 'tr', 'tt', 'u', 'ul',
  'var', 'video', 'wbr',
]);

/**
 * The attributes a rule may name directly.
 *
 * Checked BEFORE the tag list, because a few words are both: `title` is an attribute on every
 * element and a tag on `<head>`, and in these rules it is always the attribute. `span` is the
 * other way round -- it is an attribute on `<col>` and a tag everywhere else, and here it is the
 * tag, so it is not in this list.
 */
const ATTR_NAMES = new Set([
  'abbr', 'accept', 'action', 'alt', 'async', 'autocomplete', 'autofocus', 'charset', 'checked',
  'cite', 'class', 'colspan', 'content', 'controls', 'coords', 'crossorigin', 'datetime', 'defer',
  'dir', 'disabled', 'download', 'enctype', 'for', 'formaction', 'headers', 'height', 'high',
  'href', 'hreflang', 'id', 'integrity', 'ismap', 'kind', 'label', 'lang', 'list', 'loading',
  'low', 'max', 'maxlength', 'method', 'min', 'multiple', 'muted', 'name', 'nonce', 'open',
  'pattern', 'ping', 'placeholder', 'playsinline', 'poster', 'preload', 'property', 'readonly',
  'referrerpolicy', 'rel', 'required', 'reversed', 'role', 'rows', 'rowspan', 'sandbox',
  'scope', 'selected', 'sizes', 'span', 'srclang', 'src', 'srcdoc', 'srcset', 'start', 'step',
  'style', 'tabindex', 'target', 'title', 'type', 'usemap', 'value', 'width', 'wrap',
]);
// `span` is a tag here, not an attribute -- see the note above.
ATTR_NAMES.delete('span');

/**
 * Peel an index off the end of a step.
 *
 * The collections write the index in three ways, and all three are in use:
 *   `a.1`            take the second match
 *   `li!0`           take all of them except the first
 *   `.ablum_read[0]` take the first, in the jQuery spelling
 *   `a.-1`           take the last
 */
function peelIndex(step: string): { body: string; index: number | null; exclude: number | null } {
  let body = step;
  let index: number | null = null;
  let exclude: number | null = null;

  const jq = /^(.*)\[(\d+)\]$/.exec(body);
  if (jq) {
    body = jq[1];
    index = parseInt(jq[2], 10);
  }

  // The `.N` / `!N` suffix. The class name may itself contain dots (`td.odd.0` is "the first
  // `td.odd`"), so the LAST one wins.
  const suffix = /^(.*?)([.!])(-?\d+)$/.exec(body);
  if (suffix) {
    body = suffix[1];
    const n = parseInt(suffix[3], 10);
    if (suffix[2] === '!') exclude = n;
    else index = n;
  }

  return { body: body.trim(), index, exclude };
}

/**
 * Parse one link of a CSS chain.
 *
 * `class.book-mid-list`      select by class
 * `id.content`               select by id
 * `tag.li`                   select by tag name
 * `a@href`                   the link's address
 * `img@src`                  the image's source
 * `.0` / `!0` / `.-1`        take the n-th / all but the n-th / the n-th from the end
 * `text.下一页`               the element whose text is 下一页
 * `css:td:eq(1)`             a raw CSS selector, with the jQuery index the collections use
 */
function parseCssStep(raw: string): CssStep | null {
  let step = raw.trim();
  // A step may be written with a leading `@`: `@css:a.orange@title`.
  if (step.startsWith('@')) step = step.slice(1).trim();
  if (!step) return null;

  // A JavaScript step: `...@js:result.replace(...)`.
  if (step.startsWith('js:')) {
    return { kind: 'js', selector: '', index: null, exclude: null, attr: step.slice(3) };
  }
  if (step === 'text') return { kind: 'text', selector: '', index: null, exclude: null, attr: '' };
  if (step === 'html') return { kind: 'html', selector: '', index: null, exclude: null, attr: '' };
  // `all` is `html` under another name: every descendant's markup, not the element's own text.
  if (step === 'all') return { kind: 'html', selector: '', index: null, exclude: null, attr: '' };
  if (step === 'outerHTML' || step === 'outerHtml') return { kind: 'outer', selector: '', index: null, exclude: null, attr: '' };
  if (step === 'textNodes') return { kind: 'textNodes', selector: '', index: null, exclude: null, attr: '' };
  // `text.下一页` finds the element BY its text -- the site gives that link no class to name.
  if (step.startsWith('text.')) {
    return { kind: 'textMatch', selector: step.slice(5).trim(), index: null, exclude: null, attr: '' };
  }

  // Legado's own three prefixes.
  const m = /^(class|id|tag)\.(.+)$/.exec(step);
  if (m) {
    const how = m[1];
    const { body, index, exclude } = peelIndex(m[2]);
    if (!body) return null;
    const selector = how === 'class' ? `.${cssEscape(body)}`
      : how === 'id' ? `#${cssEscape(body)}`
        : cssEscape(body);
    return { kind: 'select', selector, index, exclude, attr: '' };
  }

  // A raw CSS selector, with the jQuery index some of them carry.
  if (step.startsWith('css:')) {
    const raw2 = step.slice(4).trim();
    const eq = /:eq\((\d+)\)\s*$/.exec(raw2);
    const selector = eq ? raw2.slice(0, eq.index).trim() : raw2;
    if (!selector) return null;
    return { kind: 'select', selector, index: eq ? parseInt(eq[1], 10) : null, exclude: null, attr: '' };
  }

  // Everything else: an index may be attached, and what is left is a tag, a raw selector, or an
  // attribute name.
  const { body, index, exclude } = peelIndex(step);
  if (!body) return null;

  // `data-*`, `aria-*` and `on*` are attributes whatever they are called.
  if (/^(data|aria)-/i.test(body) || /^on[a-z]/i.test(body)) {
    return { kind: 'attr', selector: '', index: null, exclude: null, attr: body };
  }
  if (ATTR_NAMES.has(body.toLowerCase())) {
    return { kind: 'attr', selector: '', index: null, exclude: null, attr: body };
  }
  if (HTML_TAGS.has(body.toLowerCase())) {
    return { kind: 'select', selector: body.toLowerCase(), index, exclude, attr: '' };
  }
  // A raw CSS selector: `.item`, `#main`, `[property="og:title"]`, `h3 > a`, `td.odd`.
  if (/^[.#\[*>]/.test(body) || /[\s>]/.test(body) || body.includes('.')) {
    return { kind: 'select', selector: body, index, exclude, attr: '' };
  }
  // An unknown name is an attribute: that is what Legado does with it, and an attribute the site
  // does not have simply comes back empty -- which loses that one field, not the whole rule.
  return { kind: 'attr', selector: '', index: null, exclude: null, attr: body };
}

function cssEscape(s: string): string {
  return s.replace(/([^\w-])/g, '\\$1');
}

function applyIndex(nodes: DomElement[], step: CssStep): DomElement[] {
  let list = nodes;
  if (step.exclude !== null) {
    const at = step.exclude < 0 ? list.length + step.exclude : step.exclude;
    list = list.filter((_, i) => i !== at);
  }
  if (step.index !== null) {
    const at = step.index < 0 ? list.length + step.index : step.index;
    const one = list[at];
    return one ? [one] : [];
  }
  return list;
}

/** Run a CSS chain against a scope. Returns the elements it lands on (possibly empty). */
export function evalCssChain(steps: string[], scope: RuleScope): DomElement[] {
  const parsed = steps.map(parseCssStep);
  if (parsed.some((s) => s === null)) return [];
  const chain = parsed as CssStep[];

  let current: DomElement[] = [];
  let started = false;

  for (const step of chain) {
    if (step.kind === 'select' || step.kind === 'textMatch') {
      // A step after the first one searches INSIDE what the previous step found -- and inside EVERY
      // element it found, because `class.item@tag.a` means "the link inside each item", not "the link
      // inside the first item".
      const roots = started ? current : [domOf(scope)];
      const found: DomElement[] = [];
      for (const root of roots) {
        if (!root) continue;
        found.push(...(step.kind === 'textMatch'
          ? elementsByText(root, step.selector)
          : queryAll(root, step.selector)));
      }
      current = applyIndex(found, step);
      started = true;
      continue;
    }
    // Terminal steps collapse the current elements into text.
    if (step.kind === 'text' || step.kind === 'textNodes') {
      const texts = current.map((el) => (step.kind === 'textNodes' ? rawTextOf(el) : textOf(el)));
      current = texts.map((t) => fakeText(t)).filter(Boolean) as unknown as DomElement[];
      // A terminal step ends the chain: the elements are gone, only text remains.
      return [];
    }
    if (step.kind === 'html' || step.kind === 'outer') {
      const htmls = current.map((el) => (step.kind === 'html' ? innerHtmlOf(el) : outerHtmlOf(el)));
      current = htmls.map((h) => fakeText(h)).filter(Boolean) as unknown as DomElement[];
      return [];
    }
    if (step.kind === 'attr') {
      const vals = current.map((el) => el.attrs[step.attr] ?? '');
      current = vals.map((v) => fakeText(v)).filter(Boolean) as unknown as DomElement[];
      // An attribute in the MIDDLE of a chain is a value the next step works on, so the chain goes on.
      // At the end of one it is the answer, and evalCssValue reads it there.
      continue;
    }
    if (step.kind === 'js') {
      // A JavaScript step runs on what the chain has produced so far.
      const values = current.map((el) => textOf(el));
      const out = values.map((v) => {
        const r = evalJsExpression(step.attr, jsRuntimeOf(scope), {
          result: v,
          origin: scope.origin,
          groups: scope.groups,
          vars: {},
        });
        return stringify(r);
      });
      current = out.map((v) => fakeText(v)).filter(Boolean) as unknown as DomElement[];
      continue;
    }
  }
  return current;
}

/**
 * The chain can end on a text/html/attr step, in which case the value is not an element but a string.
 * `evalCssChain` returns elements; this returns the value the rule actually produced.
 */
/**
 * The elements a scope IS.
 *
 * A list rule makes one scope per item, and the item IS an element. A field rule that is a single
 * step -- `text`, `href`, `html` -- reads that element, because there is no earlier step to find it:
 * the chain is one link long and its only element is the one it is already in.
 *
 * Without this, every field rule of the shape `text` or `href` came back empty, and the sources
 * that write their fields that way -- which is most of them -- had chapters with no title and no
 * address. The symptom was "the site works, the list works, and every field of every item is
 * blank", which reads like a broken site rather than a rule that forgot where it was.
 */
function scopeElements(scope: RuleScope): DomElement[] {
  if (scope.node && scope.node.type === 'element') return [scope.node];
  // A JSON scope has no elements: parsing its content as HTML would answer with the JSON.
  if (scope.isJson) return [];
  // A scope made from a whole page: its root is the element.
  const root = domOf(scope);
  return root.type === 'element' ? [root] : [];
}

export function evalCssValue(rule: string, scope: RuleScope): { text: string; nodes: DomElement[] } {
  const steps = splitChain(rule);
  const terminal = steps[steps.length - 1];
  const terminalParsed = terminal ? parseCssStep(terminal) : null;
  if (terminalParsed && terminalParsed.kind !== 'select' && terminalParsed.kind !== 'textMatch') {
    const before = steps.slice(0, -1);
    const nodes = before.length ? evalCssChain(before, scope) : scopeElements(scope);
    const step = terminalParsed;
    const pick = (fn: (el: DomElement) => string) => nodes.map(fn).filter((s) => s !== '').join('\n');
    switch (step.kind) {
      case 'text': return { text: pick((el) => textOf(el)), nodes };
      case 'textNodes': return { text: pick((el) => rawTextOf(el)), nodes };
      case 'html': return { text: pick((el) => innerHtmlOf(el)), nodes };
      case 'outer': return { text: pick((el) => outerHtmlOf(el)), nodes };
      case 'attr': return { text: pick((el) => el.attrs[step.attr] ?? ''), nodes };
      case 'js': {
        const values = nodes.map((el) => textOf(el));
        const out = values.map((v) => stringify(evalJsExpression(step.attr, jsRuntimeOf(scope), {
          result: v, origin: scope.origin, groups: scope.groups, vars: {},
        })));
        return { text: out.filter(Boolean).join('\n'), nodes };
      }
      default: return { text: '', nodes };
    }
  }
  const nodes = evalCssChain(steps, scope);
  return { text: nodes.map((el) => textOf(el)).join('\n'), nodes };
}

/** A text value wrapped so it can flow through the same code paths as an element. */
function fakeText(text: string): DomElement | null {
  if (!text) return null;
  const el: DomElement = { type: 'element', name: '#text', attrs: {}, children: [], parent: null };
  el.children.push({ type: 'text', text, parent: el });
  return el;
}

// ---------------------------------------------------------------------------------------------
// Regex
// ---------------------------------------------------------------------------------------------

export interface RegexResult {
  groups: string[];
  value: string;
}

/**
 * A Legado regex rule. Two spellings:
 *   `##pattern##replacement`  replace every match of `pattern` with `replacement`
 *   `:pattern`                capture the page, and let later rules read `$1`, `$2` ...
 */
export function evalRegex(rule: string, scope: RuleScope): RegexResult {
  const groups: string[] = [];
  let value = '';

  if (rule.includes('##')) {
    // `##pattern##replacement`: the pattern is between the first pair, the replacement after it.
    const m = /^##([\s\S]*?)##([\s\S]*)$/.exec(rule.trim());
    if (!m) return { groups, value: '' };
    const pattern = m[1];
    const replacement = m[2];
    let re: RegExp;
    try {
      re = new RegExp(pattern, 'g');
    } catch {
      return { groups, value: '' };
    }
    value = scope.content.replace(re, replacement);
    const first = re.exec(scope.content);
    if (first) groups.push(...first.slice(1).map((g) => g ?? ''));
    return { groups, value };
  }

  // A bare regex over the page: `:pattern` or `pattern`.
  const raw = rule.trim().replace(/^:/, '');
  if (!raw) return { groups, value: '' };
  let re: RegExp;
  try {
    re = new RegExp(raw, 's');
  } catch {
    try {
      re = new RegExp(raw);
    } catch {
      return { groups, value: '' };
    }
  }
  const m = re.exec(scope.content);
  if (!m) return { groups, value: '' };
  groups.push(...m.slice(1).map((g) => g ?? ''));
  value = m[0];
  return { groups, value };
}

// ---------------------------------------------------------------------------------------------
// XPath (the subset the sources use)
// ---------------------------------------------------------------------------------------------

export function evalXPath(rule: string, scope: RuleScope): string {
  const { selectXPath } = require('./xpath') as typeof import('./xpath');
  return selectXPath(rule, domOf(scope));
}

// ---------------------------------------------------------------------------------------------
// The evaluator
// ---------------------------------------------------------------------------------------------

export interface EvalResult {
  /** The value the rule produced. */
  value: unknown;
  /** The scope the value came from -- a list rule leaves the scope of its items. */
  scopes: RuleScope[];
}

/**
 * Evaluate a rule that selects a LIST of things (a search result, a chapter list).
 *
 * Returns one scope per item, each carrying that item's own content -- so the field rules of the
 * same stage can be read relative to it.
 */
export function evalList(rule: string, env: RuleEnv, base: RuleScope): RuleScope[] {
  const parts = splitOperators(rule);
  const collected: RuleScope[] = [];
  let started = false;

  for (const part of parts) {
    const got = evalListOne(part.rule, env, base);
    if (part.op === 'or') {
      // The first alternative that yields something wins; the rest are not tried.
      if (!started || collected.length === 0) {
        collected.push(...got);
        started = true;
      }
    } else {
      collected.push(...got);
      started = true;
    }
  }
  return collected;
}

function evalListOne(rule: string, env: RuleEnv, base: RuleScope): RuleScope[] {
  base.runtime = env.runtime;
  const { selector, replace } = splitRule(rule);
  const kind = kindOf(selector);

  if (kind === 'js') {
    const value = runJs(selector, env, base);
    return arrayOf(value).map((item) => scopeOfValue(item, env, base));
  }
  if (kind === 'json') {
    const value = runJson(selector, base);
    return arrayOf(value).map((item) => {
      const s = scopeOfValue(item, env, base);
      s.mode = 'json';
      return s;
    });
  }
  if (kind === 'regex') {
    const { groups, value } = evalRegex(selector, base);
    const scope: RuleScope = { ...base, content: value, groups: groups.length ? groups : base.groups };
    return [scope];
  }
  if (kind === 'xpath') {
    const nodes = evalXPathNodes(selector, base);
    return nodes.filter(isElementNode).map((node) => {
      const s = scopeOfNode(node, env, base);
      s.mode = 'xpath';
      return s;
    });
  }

  // CSS.
  const steps = splitChain(selector);
  const terminal = steps[steps.length - 1];
  const terminalParsed = terminal ? parseCssStep(terminal) : null;
  const isList = !terminalParsed || terminalParsed.kind === 'select' || terminalParsed.kind === 'textMatch';

  if (!isList) {
    // A scalar rule used as a list rule yields one item.
    const { text } = evalCssValue(selector, base);
    return [scopeOfText(applyReplacement(text, replace), env, base)];
  }

  const nodes = evalCssChain(steps, base);
  return nodes.map((node) => scopeOfNode(node, env, base));
}

/**
 * Evaluate a rule that yields ONE value (a title, an author, a chapter body).
 */
export function evalField(rule: string, env: RuleEnv, base: RuleScope): string {
  const parts = splitOperators(rule);
  let result = '';
  let started = false;

  for (const part of parts) {
    const value = evalFieldOne(part.rule, env, base);
    if (part.op === 'or') {
      // The first alternative that yields something wins.
      if (!started || result === '') {
        result = value;
        started = true;
      }
    } else {
      result = started && value ? `${result}\n${value}` : (result || value);
      started = true;
    }
  }
  return result;
}

function evalFieldOne(rule: string, env: RuleEnv, base: RuleScope): string {
  base.runtime = env.runtime;
  const { selector, replace } = splitRule(rule);
  const kind = kindOf(selector);

  // A rule that is nothing but a replacement (`##pattern##replacement`) applies to the page itself.
  if (!selector && replace) return applyReplacement(base.content, replace);

  // `$1`, `$2` read the capture groups of the regex that ran before this rule.
  if (/^\$\d+$/.test(selector.trim())) {
    const n = parseInt(selector.trim().slice(1), 10);
    return base.groups[n - 1] ?? '';
  }

  if (kind === 'js') {
    const value = runJs(selector, env, base);
    return applyReplacement(stringify(value), replace);
  }
  if (kind === 'text' && selector.includes('{{')) {
    return applyReplacement(interpolate(selector, env, base), replace);
  }
  if (kind === 'json') {
    return applyReplacement(stringify(runJson(selector, base)), replace);
  }
  if (kind === 'regex') {
    const { groups, value } = evalRegex(selector, base);
    // `$1`, `$2` read the groups of the regex that ran before this rule.
    if (/^\$\d+$/.test(selector.trim())) {
      const n = parseInt(selector.trim().slice(1), 10);
      const g = groups[n - 1] ?? base.groups[n - 1] ?? '';
      return g;
    }
    return applyReplacement(value, replace);
  }
  if (kind === 'xpath') {
    return applyReplacement(evalXPath(selector, base), replace);
  }

  // The stage's dialect wins over the rule's own shape: in a JSON stage a bare `name` is a JSON
  // key, and in an XPath stage it is an XPath. Both are tried before falling back to CSS, because
  // a rule that means nothing in the stage's dialect may still mean something in CSS.
  if (base.mode === 'json') {
    const s = stringify(runJson(selector, base));
    if (s) return applyReplacement(s, replace);
  }
  if (base.mode === 'xpath') {
    const x = evalXPath(selector, base);
    if (x) return applyReplacement(x, replace);
  }

  const { text } = evalCssValue(selector, base);
  return applyReplacement(text, replace);
}

/** A `{{...}}` template: JSON paths interpolated into a string. */
function interpolate(rule: string, env: RuleEnv, base: RuleScope): string {
  return rule.replace(/\{\{([\s\S]*?)\}\}/g, (_whole, expr: string) => {
    const e = expr.trim();
    if (e.startsWith('$')) {
      const v = runJson(e, base);
      return stringify(v);
    }
    const v = env.vars[e];
    return v === undefined ? '' : stringify(v);
  });
}

function runJson(rule: string, scope: RuleScope): unknown {
  const r = rule.trim();
  if (r.startsWith('{')) {
    // A JSON path that starts with `{` -- `{$.a}`.
    const inner = r.replace(/^\{|\}$/g, '');
    return jsonPath(inner, scope.json ?? safeParse(scope.content));
  }
  return jsonPath(r, scope.json ?? safeParse(scope.content));
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function runJs(rule: string, env: RuleEnv, scope: RuleScope): unknown {
  return evalJsRule(rule, env.runtime, {
    result: scope.content,
    origin: scope.origin,
    groups: scope.groups,
    vars: env.vars,
  });
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(stringify).join('\n');
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function arrayOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined || value === '') return [];
  if (typeof value === 'object') {
    // An object with a `data`/`list`/`items` array is a list of results.
    for (const key of ['data', 'list', 'items', 'results', 'books']) {
      const arr = (value as Record<string, unknown>)[key];
      if (Array.isArray(arr)) return arr;
    }
  }
  return [value];
}

function scopeOfValue(value: unknown, env: RuleEnv, base: RuleScope): RuleScope {
  if (typeof value === 'string') return scopeOfText(value, env, base);
  if (value && typeof value === 'object') {
    try {
      return makeScope(JSON.stringify(value), base.origin, base.groups);
    } catch {
      return scopeOfText(stringify(value), env, base);
    }
  }
  return scopeOfText(stringify(value), env, base);
}

function scopeOfText(text: string, env: RuleEnv, base: RuleScope): RuleScope {
  const scope = makeScope(text, base.origin, base.groups);
  scope.json = undefined;
  scope.isJson = false;
  void env;
  return scope;
}

function isElementNode(node: DomNode): node is DomElement {
  return node.type === 'element';
}

function scopeOfNode(node: DomElement, env: RuleEnv, base: RuleScope): RuleScope {
  const scope: RuleScope = {
    content: innerHtmlOf(node),
    node,
    groups: base.groups,
    origin: base.origin,
    isJson: false,
  };
  void env;
  return scope;
}

function evalXPathNodes(rule: string, scope: RuleScope): DomNode[] {
  const { selectXPathNodes } = require('./xpath') as typeof import('./xpath');
  return selectXPathNodes(rule, domOf(scope));
}
