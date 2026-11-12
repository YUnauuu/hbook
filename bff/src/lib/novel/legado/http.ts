// Fetching a page, the way a book source needs it.
//
// The rules do not say anything about headers, cookies or referers -- they assume a browser, and a
// browser is what a site checks for. So this layer supplies the things a rule does not mention:
// a desktop user agent, a referer, the cookies the source collected, and the redirects a site
// answers with. What the rule DOES mention -- a header in the source's own `header` field -- wins.

export interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  referer?: string;
  /** Cookies to send, as a `name=value; name=value` string. */
  cookie?: string;
  timeoutMs?: number;
  /**
   * The character set the page is in.
   *
   * Node's fetch decodes as UTF-8 whatever the server says, and a good number of these sites are
   * GBK or Big5 -- their pages then arrive as mojibake and every rule matches nothing, which looks
   * exactly like a broken rule. The source says which it is in its URL options; this is where that
   * is honoured.
   */
  charset?: string;
}

export interface FetchResult {
  status: number;
  url: string;
  contentType: string;
  body: string;
  /** The cookies the response set, as `name=value; attributes` lines. */
  setCookie: string[];
}

/**
 * Why a fetch failed, when it failed before an answer came.
 *
 * The distinction matters more than it looks. A source whose rules are wrong and a source whose
 * SITE is unreachable produce the same empty search, and they call for opposite decisions: the
 * first is a bug in this app, the second is a source to drop. Without this, a probe run from a
 * network that cannot reach half the sites reports the whole collection as broken.
 */
export type FetchFailure =
  | 'dns'        // the host does not resolve
  | 'connect'    // refused, reset, or unreachable
  | 'tls'        // the TLS handshake failed
  | 'timeout'
  | 'blocked'    // answered, but refused us (403 and friends)
  | 'http'       // answered with an error status
  | 'other';

export class HttpError extends Error {
  constructor(
    message: string,
    readonly kind: FetchFailure,
    readonly status?: number,
    readonly url?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Read the reason out of a fetch failure. Node buries it in `cause`. */
export function classifyFetchError(err: unknown, url: string): HttpError {
  if (err instanceof HttpError) return err;
  const cause = (err as { cause?: { code?: string; message?: string } } | null)?.cause;
  const code = cause?.code ?? '';
  const message = err instanceof Error ? err.message : String(err);

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new HttpError(`host not found (${code})`, 'dns', undefined, url);
  }
  if (code === 'UND_ERR_SSL' || code === 'CERT_HAS_EXPIRED' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT'
    || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || message.includes('SSL') || message.includes('certificate')) {
    return new HttpError(`TLS failed (${code || 'ssl'})`, 'tls', undefined, url);
  }
  if (code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT' || err instanceof Error && err.name === 'AbortError') {
    return new HttpError('timed out', 'timeout', undefined, url);
  }
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return new HttpError(`connection failed (${code})`, 'connect', undefined, url);
  }
  return new HttpError(message || 'fetch failed', 'other', undefined, url);
}

/** A header name the HTTP layer will accept. Anything else is dropped rather than sent. */
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const DEFAULT_HEADERS: Record<string, string> = {
  'user-agent': DEFAULT_UA,
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'accept-encoding': 'gzip, deflate, br',
};

/** A cookie jar, keyed by host. */
export class CookieJar {
  private readonly jars = new Map<string, Map<string, string>>();

  /** Remember the cookies a response set. */
  store(url: string, setCookie: string[]): void {
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      return;
    }
    let jar = this.jars.get(host);
    if (!jar) {
      jar = new Map();
      this.jars.set(host, jar);
    }
    for (const raw of setCookie) {
      const [pair] = raw.split(';');
      const at = pair.indexOf('=');
      if (at <= 0) continue;
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      if (!name) continue;
      // A cookie value cannot contain a newline or a control character, and a value that does is
      // not a cookie at all -- it is a page that was mistaken for one. Letting it through means the
      // next request carries it as a header, and the request is refused.
      if (/[\r\n\0]/.test(name) || /[\r\n\0]/.test(value)) continue;
      jar.set(name, value);
    }
  }

  /** The cookies to send to a URL, as a header value. */
  header(url: string): string {
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      return '';
    }
    const jar = this.jars.get(host);
    if (!jar || !jar.size) return '';
    return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  /** The raw jar for a host, as `name\tvalue` lines -- the shape Legado's `cookie` API expects. */
  raw(url: string): string {
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      return '';
    }
    const jar = this.jars.get(host);
    if (!jar) return '';
    return [...jar.entries()].map(([k, v]) => `${k}\t${v}`).join('\n');
  }

  clear(url?: string): void {
    if (!url) {
      this.jars.clear();
      return;
    }
    try {
      this.jars.delete(new URL(url).host);
    } catch {
      /* not a URL; nothing to clear */
    }
  }
}

/**
 * A header value as a ByteString.
 *
 * The fetch API refuses a header value with a character outside Latin-1, and plenty of these sites
 * put Chinese into a `Referer` or a custom header. A real HTTP client would send those bytes as
 * they are, so that is what happens here: the value is encoded as UTF-8 and read back as Latin-1,
 * which is the same byte sequence on the wire.
 */
function toByteString(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e\x80-\xff]*$/.test(value)) return value;
  return Buffer.from(value, 'utf8').toString('latin1');
}

/** The character sets a source may name, and the labels Node's decoder knows them by. */
const CHARSETS: Record<string, string> = {
  gbk: 'gbk',
  gb2312: 'gbk',
  gb18030: 'gb18030',
  big5: 'big5',
  'big5-hkscs': 'big5',
  utf8: 'utf-8',
  'utf-8': 'utf-8',
  shift_jis: 'shift_jis',
  sjis: 'shift_jis',
  'euc-jp': 'euc-jp',
  'euc-kr': 'euc-kr',
  'iso-2022-jp': 'iso-2022-jp',
  'windows-1252': 'windows-1252',
};

/**
 * Decode a page's bytes.
 *
 * The charset the SOURCE names wins over the one the server declares: a source that says "this site
 * is GBK" is right about its own site, and the header is often absent or wrong. When neither says
 * anything, the bytes are sniffed for a `<meta charset>` and, failing that, UTF-8 is assumed.
 */
export function decodeBody(bytes: Uint8Array, contentType: string, charset?: string): string {
  const named = (charset || '').trim().toLowerCase();
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType)?.[1]?.toLowerCase() || '';
  const label = CHARSETS[named] ?? CHARSETS[fromHeader];

  if (label) {
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      /* an unknown label: fall through to the sniffing below */
    }
  }

  // Sniff the first bytes for a declared charset -- a GBK page that declares itself is common.
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048));
  const meta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1]?.toLowerCase();
  const sniffed = meta ? CHARSETS[meta] : undefined;
  if (sniffed) {
    try {
      return new TextDecoder(sniffed).decode(bytes);
    } catch {
      /* fall through */
    }
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * Fetch a page.
 *
 * An HTTP error is part of the answer, not an exception -- except for the statuses that mean "you
 * are not welcome", which are raised as an `HttpError` so the caller can tell a refusal apart from
 * a page that simply has nothing on it.
 */
export async function fetchPage(url: string, options: FetchOptions = {}): Promise<FetchResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
  try {
    const rawHeaders: Record<string, string> = {
      ...DEFAULT_HEADERS,
      ...(options.headers || {}),
    };
    if (options.referer) rawHeaders.referer = options.referer;
    if (options.cookie) rawHeaders.cookie = options.cookie;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = toByteString(v);

    const res = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body: options.body,
      redirect: 'follow',
      signal: controller.signal,
    });

    // The bytes are decoded here rather than by `res.text()`, so a page in GBK can be read as GBK.
    const bytes = new Uint8Array(await res.arrayBuffer());
    const body = decodeBody(bytes, res.headers.get('content-type') || '', options.charset);
    // A site that answers with a refusal has answered. Treating it as an exception would hide the
    // status, which is the most useful thing to know about it.
    if (res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500) {
      throw new HttpError(`HTTP ${res.status}`, 'blocked', res.status, url);
    }
    return {
      status: res.status,
      url: res.url || url,
      contentType: res.headers.get('content-type') || '',
      body,
      // The response's own cookies. These are what the jar is for -- and what the jar must NOT be
      // given is the page body, which is how a request ends up carrying a whole HTML document in its
      // Cookie header.
      setCookie: typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [],
    };
  } catch (err) {
    throw classifyFetchError(err, url);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Legado lets a source declare its own headers as a JSON string, sometimes with a `,` and a second
 * JSON object after it: `"header":"{\"User-Agent\":\"...\"},{\"Referer\":\"...\"}"`.
 * Both shapes are read here; the first object's headers are the ones that apply to requests.
 */
/** Keep only the headers whose NAME the HTTP layer will accept. */
function keepHeaders(entries: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(entries)) {
    if (HEADER_NAME.test(k)) out[k.toLowerCase()] = v;
  }
  return out;
}

export function parseSourceHeaders(raw: string | Record<string, string> | undefined): Record<string, string> {
  if (!raw) return {};
  // Some collections store the headers as an object rather than as the JSON string the format
  // specifies. Both are read here; the object form needs no parsing at all.
  if (typeof raw === 'object') {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'string') out[k] = v;
    }
    return keepHeaders(out);
  }
  const trimmed = raw.trim();
  if (!trimmed) return {};
  const first = trimmed.split(',{')[0];
  try {
    const parsed = JSON.parse(first);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string') out[k] = v;
      }
      return keepHeaders(out);
    }
  } catch {
    /* not JSON; a source may put a bare header line here */
  }
  const out: Record<string, string> = {};
  for (const line of trimmed.split('\n')) {
    const at = line.indexOf(':');
    if (at > 0) out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return keepHeaders(out);
}

/** The `,{"method":"POST","body":...,"charset":"gbk"}` tail some sources put on their search URL. */
export function splitUrlOptions(url: string): {
  url: string;
  options: { method?: string; body?: string; headers?: Record<string, string>; charset?: string };
} {
  const at = url.indexOf(',{');
  if (at === -1) return { url, options: {} };
  // The comma is the separator, not part of the address. A source whose own URL string ends in a
  // comma (which happens when a rule builds the address by concatenation) would otherwise have
  // that comma left on the end of the request.
  const head = url.slice(0, at).replace(/,+$/, '');
  const tail = url.slice(at + 1);
  try {
    const parsed = JSON.parse(tail);
    return {
      url: head,
      options: {
        method: typeof parsed.method === 'string' ? parsed.method : undefined,
        body: typeof parsed.body === 'string' ? parsed.body : undefined,
        headers: parsed.headers && typeof parsed.headers === 'object' ? parsed.headers : undefined,
        charset: typeof parsed.charset === 'string' ? parsed.charset : undefined,
      },
    };
  } catch {
    return { url, options: {} };
  }
}
