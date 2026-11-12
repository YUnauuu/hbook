// A small XPath, covering the forms the book sources use.
//
//   //meta[@property='og:novel:author']/@content
//   //p[text()='总字数']/span/text()
//   //div[@class='prenext']/span/a[text()='下一页']/@href
//   //meta[@property='a' or @property='b']/@content
//   //title/text()
//
// The subset: the descendant (`//`) and child (`/`) axes, name tests with `*`, predicates over
// attributes / text / position, the `or` and `and` operators, `contains()`, and a trailing
// `@attribute` or `text()`. That is everything these rules ask for; a path outside the subset
// matches nothing rather than throwing, which is what a rule that has gone stale should do.

import { DomElement, DomNode, elementsOf, textOf, walk } from './html';

type Predicate = (el: DomElement, index: number) => boolean;

interface Step {
  axis: 'descendant' | 'child' | 'self';
  name: string;
  predicates: Predicate[];
}

export function selectXPath(path: string, root: DomNode): string {
  const nodes = selectXPathNodes(path, root);
  if (!nodes.length) return '';
  const first = nodes[0];
  if (first.type === 'text') return first.text.trim();
  if (first.type === 'comment') return first.text.trim();
  return textOf(first);
}

export function selectXPathNodes(path: string, root: DomNode): DomNode[] {
  const expr = path.trim();
  if (!expr) return [];

  // Split the trailing `@attr` / `text()` off the step path.
  let attr: string | null = null;
  let wantText = false;
  let body = expr;

  const attrMatch = /@([\w:.-]+)\s*$/.exec(body);
  if (attrMatch) {
    attr = attrMatch[1];
    // The separator before the attribute is not a step of its own: `//meta/@content` is one step
    // that reads an attribute, not two steps where the second matches any child.
    body = body.slice(0, attrMatch.index).replace(/\/+$/, '');
  } else if (/\/text\(\)\s*$/.test(body)) {
    wantText = true;
    body = body.replace(/\/text\(\)\s*$/, '');
  } else if (/^text\(\)\s*$/.test(body)) {
    wantText = true;
    body = '';
  }

  const steps = parseSteps(body);
  let current: DomNode[] = [root];

  for (const step of steps) {
    const next: DomNode[] = [];
    for (const node of current) {
      let candidates: DomElement[] = [];
      if (step.axis === 'self') {
        candidates = node.type === 'element' ? [node] : [];
      } else if (step.axis === 'child') {
        candidates = node.type === 'element'
          ? node.children.filter((c): c is DomElement => c.type === 'element')
          : [];
      } else {
        candidates = elementsOf(node);
      }
      candidates = candidates.filter((el) => step.name === '*' || el.name === step.name);
      const kept = candidates.filter((el, i) => step.predicates.every((p) => p(el, i)));
      next.push(...kept);
    }
    current = next;
    if (!current.length) return [];
  }

  const out: DomNode[] = [];
  for (const node of current) {
    if (attr && node.type === 'element') {
      const v = node.attrs[attr];
      if (v !== undefined) out.push({ type: 'text', text: v, parent: null });
      continue;
    }
    if (wantText) {
      if (node.type === 'element') {
        for (const child of node.children) {
          if (child.type === 'text') out.push(child);
        }
      }
      continue;
    }
    out.push(node);
  }
  return out;
}

function parseSteps(body: string): Step[] {
  const steps: Step[] = [];
  let i = 0;
  // A leading `/` is the document root; `//` is a descendant search from it.
  while (i < body.length) {
    let axis: Step['axis'] = 'child';
    if (body.startsWith('//', i)) { axis = 'descendant'; i += 2; }
    else if (body[i] === '/') { i += 1; axis = body.startsWith('/', i) ? 'descendant' : 'child'; if (axis === 'descendant') i++; }
    else if (body[i] === '.') { i += 1; axis = 'self'; }

    const nameStart = i;
    while (i < body.length && !/[\/@[]/.test(body[i])) i++;
    const name = body.slice(nameStart, i) || '*';

    const predicates: Predicate[] = [];
    while (body[i] === '[') {
      const end = matchBracket(body, i);
      if (end === -1) break;
      const inner = body.slice(i + 1, end);
      i = end + 1;
      const p = parsePredicate(inner);
      if (p) predicates.push(p);
    }
    steps.push({ axis, name, predicates });
  }
  return steps;
}

function matchBracket(s: string, start: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function parsePredicate(inner: string): Predicate | null {
  const expr = inner.trim();
  if (!expr) return null;

  // A number is a position: `[1]` is the second element.
  if (/^\d+$/.test(expr)) {
    const n = parseInt(expr, 10);
    return (_el, i) => i === n - 1;
  }

  const conditions = splitOr(expr).map((part) => parseCondition(part.trim())).filter(Boolean) as Predicate[];
  if (!conditions.length) return null;
  if (conditions.length === 1) return conditions[0];
  return (el, i) => conditions.every((c) => c(el, i));
}

function splitOr(expr: string): string[] {
  const out: string[] = [];
  let buf = '';
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (quote) {
      buf += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; buf += c; continue; }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (depth === 0 && expr.startsWith(' or ', i)) {
      out.push(buf);
      buf = '';
      i += 3;
      continue;
    }
    if (depth === 0 && expr.startsWith(' and ', i)) {
      out.push(buf);
      buf = '';
      i += 4;
      continue;
    }
    buf += c;
  }
  out.push(buf);
  return out;
}

function parseCondition(expr: string): Predicate | null {
  // `contains(@a,'b')` / `contains(text(),'b')`
  const contains = /^contains\(\s*([^,]+?)\s*,\s*(['"])([\s\S]*?)\2\s*\)$/.exec(expr);
  if (contains) {
    const target = contains[1].trim();
    const needle = contains[3];
    return (el) => {
      const hay = target.startsWith('@')
        ? (el.attrs[target.slice(1)] ?? '')
        : textOf(el);
      return hay.includes(needle);
    };
  }

  // `@attr='value'`, `@attr`, `@attr!='value'`
  const attr = /^@([\w:.-]+)\s*(?:(!=|=)\s*(['"])([\s\S]*?)\3)?$/.exec(expr);
  if (attr) {
    const name = attr[1];
    const op = attr[2];
    const want = attr[4];
    return (el) => {
      const have = el.attrs[name];
      if (have === undefined) return false;
      if (!op) return true;
      return op === '=' ? have === want : have !== want;
    };
  }

  // `text()='value'`
  const textEq = /^text\(\)\s*(=|!=)\s*(['"])([\s\S]*?)\2$/.exec(expr);
  if (textEq) {
    const op = textEq[1];
    const want = textEq[3];
    return (el) => {
      const have = textOf(el);
      return op === '=' ? have === want : have !== want;
    };
  }

  // `contains(text(),'x')` without the leading `contains(` parse above -- already handled.
  return null;
}

export { walk };
