// A small JSONPath, covering the forms the book sources use.
//
//   $.data.list            a child chain
//   $..book_data[0]        a recursive descent, then an index
//   $.data[*].name         every element of an array
//   $['odd key'].x         a quoted key
//   data[0]                the same, without the `$.` prefix
//
// Returns a value, not a path: the rule wants the thing, not the way to it.

interface Step {
  kind: 'child' | 'descend' | 'index' | 'wildcard' | 'slice';
  key?: string;
  index?: number;
  from?: number;
  to?: number;
}

function parse(path: string): Step[] {
  const steps: Step[] = [];
  let i = 0;
  const s = path.trim();

  // A leading `$` is the root. `$.` and `$[` after it are just separators.
  if (s[0] === '$') i = 1;

  while (i < s.length) {
    const c = s[i];
    if (c === '.') {
      if (s[i + 1] === '.') {
        // `..name` -- every descendant named `name`.
        i += 2;
        const start = i;
        while (i < s.length && /[\w$-]/.test(s[i])) i++;
        const key = s.slice(start, i);
        if (key) steps.push({ kind: 'descend', key });
        continue;
      }
      i++;
      const start = i;
      while (i < s.length && /[\w$-]/.test(s[i])) i++;
      const key = s.slice(start, i);
      if (key) steps.push({ kind: 'child', key });
      continue;
    }
    if (c === '[') {
      const end = s.indexOf(']', i);
      if (end === -1) break;
      const body = s.slice(i + 1, end).trim();
      i = end + 1;
      if (body === '*') {
        steps.push({ kind: 'wildcard' });
      } else if (/^-?\d+$/.test(body)) {
        steps.push({ kind: 'index', index: parseInt(body, 10) });
      } else if (body.includes(':')) {
        const [a, b] = body.split(':');
        steps.push({
          kind: 'slice',
          from: a.trim() ? parseInt(a, 10) : undefined,
          to: b.trim() ? parseInt(b, 10) : undefined,
        });
      } else {
        const key = body.replace(/^['"]|['"]$/g, '');
        steps.push({ kind: 'child', key });
      }
      continue;
    }
    // A bare name right after the root.
    const start = i;
    while (i < s.length && /[\w$-]/.test(s[i])) i++;
    if (i === start) break;
    steps.push({ kind: 'child', key: s.slice(start, i) });
  }

  return steps;
}

function children(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>);
  return [];
}

/** Collect every descendant of `value` that has the named key. */
function descend(value: unknown, key: string, out: unknown[]): void {
  for (const child of children(value)) {
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      if (Object.prototype.hasOwnProperty.call(child, key)) out.push((child as Record<string, unknown>)[key]);
    }
    descend(child, key, out);
  }
}

export function jsonPath(path: string, root: unknown): unknown {
  const steps = parse(path);
  if (!steps.length) return root;

  let current: unknown[] = [root];

  for (const step of steps) {
    const next: unknown[] = [];
    for (const value of current) {
      switch (step.kind) {
        case 'child': {
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            const v = (value as Record<string, unknown>)[step.key!];
            if (v !== undefined) next.push(v);
          }
          break;
        }
        case 'descend': {
          descend(value, step.key!, next);
          break;
        }
        case 'index': {
          if (Array.isArray(value)) {
            const at = step.index! < 0 ? value.length + step.index! : step.index!;
            if (at >= 0 && at < value.length) next.push(value[at]);
          }
          break;
        }
        case 'wildcard': {
          next.push(...children(value));
          break;
        }
        case 'slice': {
          if (Array.isArray(value)) {
            next.push(...value.slice(step.from, step.to));
          }
          break;
        }
      }
    }
    current = next;
    if (!current.length) return undefined;
  }

  if (current.length === 1) return current[0];
  return current;
}
