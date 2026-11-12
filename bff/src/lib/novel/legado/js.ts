// The JavaScript half of the rule dialect.
//
// Two spellings reach this file:
//   `@js:result.replace(/1.*/,'false')`  an EXPRESSION, whose value is the rule's value
//   `<js> ... </js>`                     a BLOCK, whose last expression is the rule's value
//
// THE HARD PART: a rule's JavaScript is synchronous -- `a = java.ajax(u)` reads its result on the
// next line -- but Node has no synchronous HTTP. The usual answers are all bad: a child process per
// request is slow and fragile; `child_process` + curl is the same; `Atomics.wait` on a worker that
// answers over `postMessage` deadlocks, because the blocked thread is the one that would deliver
// the message.
//
// So the bridge is a worker thread with a SharedArrayBuffer: the main thread writes the request
// into the buffer, sets a flag, and blocks on `Atomics.wait`. The worker polls that flag on its own
// event loop, does the fetch, writes the answer back into the buffer, and sets another flag. The
// main thread wakes, reads the answer, and continues. Synchronous from the rule's point of view,
// and the rule's `java.ajax(u)` behaves exactly as it was written.
//
// WHAT THE CONTEXT GETS: a small, fixed set of globals. The rule code comes from a JSON file the
// operator installed, so it is trusted the way a Legado book source is trusted -- but it still runs
// in a context with no `require`, no `process`, and no filesystem, so a rule cannot reach outside
// what this file hands it.

import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { DomElement, innerHtmlOf, parseHtml, queryAll, textOf } from './html';

// ---------------------------------------------------------------------------------------------
// The synchronous HTTP bridge
// ---------------------------------------------------------------------------------------------

const CONTROL_INTS = 8;   // [0] request length, [1] state, [2] response length, [3] error flag
const PAYLOAD_BYTES = 4 * 1024 * 1024;

interface Bridge {
  control: Int32Array;
  buffer: Uint8Array;
  worker: Worker;
}

let bridge: Bridge | null = null;

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const control = new Int32Array(workerData.control);
const payload = new Uint8Array(workerData.buffer);
const decoder = new TextDecoder();
const encoder = new TextEncoder();

async function serve() {
  for (;;) {
    if (Atomics.load(control, 1) !== 1) {
      await new Promise((r) => setTimeout(r, 2));
      continue;
    }
    const reqLen = Atomics.load(control, 0);
    let request = null;
    let error = null;
    try {
      request = JSON.parse(decoder.decode(payload.subarray(0, reqLen)));
    } catch (e) {
      error = String(e);
    }
    let body = '';
    try {
      if (request) {
        const res = await fetch(request.url, {
          method: request.method || 'GET',
          headers: request.headers || {},
          body: request.body || undefined,
          redirect: 'follow',
        });
        body = res.headers.get('content-type') || '';
        const text = await res.text();
        body = JSON.stringify({
          status: res.status,
          contentType: body,
          body: text,
          url: res.url,
          setCookie: typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [],
        });
      }
    } catch (e) {
      error = String(e && e.message ? e.message : e);
    }
    let out;
    if (error) {
      out = JSON.stringify({ error });
    } else {
      out = body;
    }
    const bytes = encoder.encode(out);
    const n = Math.min(bytes.length, payload.length);
    payload.set(bytes.subarray(0, n), 0);
    Atomics.store(control, 2, n);
    Atomics.store(control, 3, error ? 1 : 0);
    Atomics.store(control, 1, 2);
    Atomics.notify(control, 1);
  }
}
serve();
`;

function getBridge(): Bridge {
  if (bridge) return bridge;
  const control = new SharedArrayBuffer(CONTROL_INTS * 4);
  const buffer = new SharedArrayBuffer(PAYLOAD_BYTES);
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { control, buffer },
  });
  // A dead worker must not leave a rule blocked forever.
  worker.unref();
  bridge = {
    control: new Int32Array(control),
    buffer: new Uint8Array(buffer),
    worker,
  };
  return bridge;
}

export interface SyncResponse {
  status: number;
  contentType: string;
  body: string;
  url: string;
  /** The cookies the response set. */
  setCookie: string[];
}

/** Fetch, blocking the calling thread until the answer is in. */
export function syncFetch(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): SyncResponse {
  const b = getBridge();
  const request = JSON.stringify({
    url,
    method: options.method || 'GET',
    headers: options.headers || {},
    body: options.body || '',
  });
  const bytes = new TextEncoder().encode(request);
  if (bytes.length > PAYLOAD_BYTES) throw new Error('request too large');
  b.buffer.set(bytes, 0);
  Atomics.store(b.control, 0, bytes.length);
  Atomics.store(b.control, 1, 1);
  Atomics.notify(b.control, 1);

  // Wait for the worker to answer. The timeout keeps a wedged worker from hanging the server.
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (Atomics.load(b.control, 1) === 2) break;
    if (Date.now() > deadline) throw new Error(`fetch timed out: ${url}`);
    Atomics.wait(b.control, 1, 1, 200);
  }
  const len = Atomics.load(b.control, 2);
  const raw = new TextDecoder().decode(b.buffer.subarray(0, len));
  Atomics.store(b.control, 1, 0);
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('bad response from the fetch bridge');
  }
  if (parsed.error) throw new Error(parsed.error);
  return parsed as SyncResponse;
}

export function shutdownJsBridge(): void {
  if (!bridge) return;
  bridge.worker.terminate();
  bridge = null;
}

// ---------------------------------------------------------------------------------------------
// The runtime a rule sees
// ---------------------------------------------------------------------------------------------

export interface JsContext {
  /** The value the previous step produced -- `result` in the rule's own words. */
  result: unknown;
  /** The URL the content came from. */
  origin: string;
  /** Capture groups of the last regex, readable as `$1` in a rule. */
  groups: string[];
  /** Named values a `{{...}}` template can read. */
  vars: Record<string, unknown>;
}

export class JsRuntime {
  /** Cookies the source has collected, by host. */
  readonly cookies = new Map<string, string>();
  /**
   * The source's own cookie jar, shared with the requests the source makes outside a rule.
   *
   * They are the same jar on purpose. A rule that fetches a page to read a token out of it opens a
   * session, and the request that follows has to carry that session -- two jars would mean the
   * token is fetched with one session and spent with another.
   */
  jar?: { header(url: string): string; store(url: string, setCookie: string[]): void };
  /** The rule cache: `cache.put` / `cache.get`. */
  readonly cache = new Map<string, unknown>();
  /** The last content `java.setContent` was given. */
  content = '';
  /** The URL the last content came from. */
  contentUrl = '';
  /** The source's own identity. */
  sourceKey = '';
  sourceName = '';
  sourceBaseUrl = '';
  /** Extra headers to send with every request this source makes. */
  headers: Record<string, string> = {};
  /** Called when a rule asks to show a message. */
  onToast?: (message: string) => void;

  constructor(init: Partial<JsRuntime> = {}) {
    Object.assign(this, init);
  }

  /** A cookie header value for a URL, from what the source has collected so far. */
  cookieHeaderFor(url: string): string {
    let host = '';
    try {
      host = new URL(url).host;
    } catch {
      return '';
    }
    const jar = this.cookies.get(host);
    return jar ? jar.split('\n').filter(Boolean).map((c) => c.split('\t')[0]).join('; ') : '';
  }

  request(url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): SyncResponse {
    const absolute = absoluteUrl(url, this.contentUrl || this.sourceBaseUrl);
    const headers: Record<string, string> = {
      'user-agent': this.headers['user-agent'] || DEFAULT_UA,
      accept: '*/*',
      ...this.headers,
      ...(options.headers || {}),
    };
    // The jar is SHARED with the source's own requests. A rule that fetches a page to read a token
    // out of it establishes a session, and the search that follows has to carry that session --
    // otherwise the token is useless.
    const cookie = this.jar?.header(absolute) || this.cookieHeaderFor(absolute);
    if (cookie && !headers.cookie) headers.cookie = cookie;
    const res = syncFetch(absolute, { ...options, headers });
    if (this.jar && res.setCookie?.length) this.jar.store(absolute, res.setCookie);
    return res;
  }
}

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export function absoluteUrl(url: string, base: string): string {
  try {
    return new URL(url, base || undefined).toString();
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------------------------
// The element API -- `java.getElement(...)`
// ---------------------------------------------------------------------------------------------

interface ElementList {
  length: number;
  get(i: number): unknown;
  text(): string;
  html(): string;
  attr(name: string): string | undefined;
  each(fn: (el: unknown, i: number) => void): void;
}

/** A jQuery-shaped wrapper over the parser's elements, which is what the rules expect. */
function wrapElements(nodes: DomElement[]): ElementList {
  return {
    get length() {
      return nodes.length;
    },
    get(i: number) {
      const el = nodes[i];
      return el ? wrapElement(el) : undefined;
    },
    text() {
      return nodes.map((el) => textOf(el)).join('\n');
    },
    html() {
      return nodes.map((el) => innerHtmlOf(el)).join('\n');
    },
    attr(name: string) {
      return nodes[0]?.attrs[name];
    },
    each(fn: (el: unknown, i: number) => void) {
      nodes.forEach((el, i) => fn(wrapElement(el), i));
    },
  };
}

function wrapElement(el: DomElement) {
  return {
    text: () => textOf(el),
    html: () => innerHtmlOf(el),
    attr: (name: string) => el.attrs[name],
    outerHTML: () => innerHtmlOf(el),
    get: (i: number) => (i === 0 ? wrapElement(el) : undefined),
    length: 1,
    each: (fn: (e: unknown, i: number) => void) => fn(wrapElement(el), 0),
  };
}

// ---------------------------------------------------------------------------------------------
// Running a rule
// ---------------------------------------------------------------------------------------------

function buildSandbox(runtime: JsRuntime, ctx: JsContext): Record<string, unknown> {
  const java: Record<string, unknown> = {
    ajax(url: string, headers?: Record<string, string>) {
      return runtime.request(url, { headers }).body;
    },
    get(url: string, headers?: Record<string, string>) {
      return runtime.request(url, { headers }).body;
    },
    getString(url: string) {
      return runtime.request(url).body;
    },
    post(url: string, body: string, headers?: Record<string, string>) {
      return runtime.request(url, { method: 'POST', body, headers }).body;
    },
    /** Legado's `ajax` with the response's headers and status, as JSON. */
    connect(url: string) {
      const res = runtime.request(url);
      return JSON.stringify({ status: res.status, headers: {}, body: res.body, url: res.url });
    },
    setContent(html: string) {
      runtime.content = html;
      runtime.contentUrl = ctx.origin;
      return '';
    },
    getContent() {
      return runtime.content;
    },
    /** The elements of the CURRENT content, by CSS selector. */
    getElement(selector: string) {
      const root = parseHtml(runtime.content);
      return wrapElements(queryAll(root, selector));
    },
    webView(html: string) {
      runtime.content = html;
      return '';
    },
    toast(message: string) {
      runtime.onToast?.(String(message));
      return '';
    },
    getCookie(url: string, key: string) {
      const jar = runtime.cookies.get(hostOf(url)) ?? '';
      for (const line of jar.split('\n')) {
        const [name, value] = line.split('\t');
        if (name === key) return value ?? '';
      }
      return '';
    },
    putCookie(url: string, cookie: string) {
      const host = hostOf(url);
      const existing = runtime.cookies.get(host) ?? '';
      runtime.cookies.set(host, existing ? `${existing}\n${cookie}` : cookie);
      return '';
    },
    removeCookie(url: string) {
      runtime.cookies.delete(hostOf(url));
      return '';
    },
    /** Legado asks the reader to open a page to pass a challenge. We cannot, so we say so. */
    startBrowser(url: string, title?: string) {
      runtime.onToast?.(`source wants a browser for ${url}`);
      void title;
      return '';
    },
    startBrowserAwait(url: string, title?: string) {
      runtime.onToast?.(`source wants a browser for ${url}`);
      void title;
      return '';
    },
    cacheFile(url: string) {
      runtime.cache.set(url, runtime.request(url).body);
      return url;
    },
    readFile(path: string) {
      return String(runtime.cache.get(path) ?? '');
    },
    downloadFile(url: string) {
      return runtime.request(url).body;
    },
    log(msg: unknown) {
      runtime.onToast?.(String(msg));
      return '';
    },
  };

  const source = {
    getKey: () => runtime.sourceKey,
    getName: () => runtime.sourceName,
    getBaseUrl: () => runtime.sourceBaseUrl,
    getLoginUrl: () => '',
  };

  const cookie = {
    getCookie: (url: string, key: string) => (java.getCookie as (u: string, k: string) => string)(url, key),
    getCookies: (url: string) => (runtime.cookies.get(hostOf(url)) ?? ''),
    putCookie: (url: string, c: string) => (java.putCookie as (u: string, c: string) => string)(url, c),
    removeCookie: (url: string) => (java.removeCookie as (u: string) => string)(url),
  };

  const cache = {
    get: (key: string) => runtime.cache.get(key),
    put: (key: string, value: unknown) => { runtime.cache.set(key, value); return ''; },
  };

  const base64 = {
    encode: (s: string) => Buffer.from(String(s), 'utf8').toString('base64'),
    decode: (s: string) => Buffer.from(String(s), 'base64').toString('utf8'),
  };

  return {
    java,
    source,
    cookie,
    cache,
    base64,
    md5: (s: string) => createHash('md5').update(String(s)).digest('hex'),
    sha1: (s: string) => createHash('sha1').update(String(s)).digest('hex'),
    result: ctx.result,
    // The rule's own variables, both as `$` and as bare names -- Legado's rules use `key` and
    // `page` directly, without a prefix.
    $: ctx.vars,
    ...ctx.vars,
    JSON,
    Math,
    Date,
    String,
    Number,
    Boolean,
    Object,
    Array,
    RegExp,
    Error,
    Map,
    Set,
    Promise,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
    encodeURI,
    decodeURI,
    escape,
    unescape,
    atob: (s: string) => Buffer.from(String(s), 'base64').toString('binary'),
    btoa: (s: string) => Buffer.from(String(s), 'binary').toString('base64'),
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function makeContext(runtime: JsRuntime, ctx: JsContext): vm.Context {
  const sandbox = buildSandbox(runtime, ctx);
  const context = vm.createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false },
  });
  return context;
}

/** Run an expression and return its value. */
export function evalJsExpression(expression: string, runtime: JsRuntime, ctx: JsContext): unknown {
  const source = expression.trim();
  if (!source) return undefined;
  const context = makeContext(runtime, ctx);
  try {
    const script = new vm.Script(`(${source})`);
    return script.runInContext(context, { timeout: 15_000, displayErrors: true });
  } catch (err) {
    // A rule that throws yields nothing, the same as one that matched nothing.
    void err;
    return undefined;
  }
}

/** Run an expression, saying whether it RAN -- as opposed to being a syntax error. */
function tryRunExpression(
  code: string,
  runtime: JsRuntime,
  ctx: JsContext,
): { ok: true; value: unknown } | { ok: false } {
  try {
    const context = makeContext(runtime, ctx);
    const script = new vm.Script(`(${code})`);
    return { ok: true, value: script.runInContext(context, { timeout: 15_000, displayErrors: true }) };
  } catch {
    return { ok: false };
  }
}

/**
 * Run a JavaScript rule, whichever of the two shapes it is.
 *
 * `@js:` marks a rule as JavaScript, but the rule may be an EXPRESSION (`@js:result.replace(...)`)
 * or a sequence of STATEMENTS (`@js:url='...'; value=java.ajax(url); url+value`). The expression
 * form is the common one, and it is tried first -- but a statement sequence is not an expression at
 * all, and wrapping it in parentheses is a SyntaxError rather than a wrong answer.
 *
 * `<js>...</js>` is always the block form.
 */
export function evalJsRule(source: string, runtime: JsRuntime, ctx: JsContext): unknown {
  const trimmed = source.trim();
  if (trimmed.startsWith('<js>')) {
    const body = trimmed.replace(/^<js>/, '').replace(/<\/js>$/, '');
    return evalJsBlock(body, runtime, ctx);
  }
  const code = (trimmed.startsWith('@js:') ? trimmed.slice('@js:'.length) : trimmed).trim();
  if (!code) return undefined;
  const asExpression = tryRunExpression(code, runtime, ctx);
  if (asExpression.ok) return asExpression.value;
  return evalJsBlock(code, runtime, ctx);
}

/**
 * Run a block and return the value of its LAST expression -- which is how the block rules are
 * written (`a=java.ajax(u); ...; c=java.getElement(path)` reads as "the value of c").
 */
export function evalJsBlock(code: string, runtime: JsRuntime, ctx: JsContext): unknown {
  const source = code.trim();
  if (!source) return undefined;
  const context = makeContext(runtime, ctx);
  // The block's value is the value of its last statement, so the statements are turned into
  // comma-separated expressions and the whole thing is evaluated as one expression.
  const wrapped = `(() => { ${source}\n; return (${lastExpression(source)}); })()`;
  try {
    const script = new vm.Script(wrapped);
    return script.runInContext(context, { timeout: 20_000, displayErrors: true });
  } catch (err) {
    void err;
    // Fall back: run the block for its effects and return `result` unchanged.
    try {
      const script = new vm.Script(`(() => { ${source}\n })()`);
      script.runInContext(context, { timeout: 20_000, displayErrors: true });
    } catch {
      /* the rule failed; there is no value */
    }
    return undefined;
  }
}

/** The last statement of a block, as an expression. */
function lastExpression(source: string): string {
  const lines = source.split('\n').filter((l) => l.trim() && !/^\s*(\/\/|\/\*|\*)/.test(l));
  const last = lines[lines.length - 1];
  if (!last) return 'result';
  const trimmed = last.trim().replace(/;$/, '');
  if (!trimmed) return 'result';
  // A statement that is not an expression (`if (...) {...}`) cannot be returned; fall back.
  if (/^(if|for|while|switch|try|function|class|return|throw)\b/.test(trimmed)) return 'result';
  return trimmed;
}
