// One book source, read through its own rules.
//
// A source is a JSON object that says how to read one site. This file turns that into the four
// operations the app needs -- search, book details, table of contents, chapter text -- by running
// the source's own rules against the pages it names.
//
// The rules are the source's; the decisions here are only about how they are applied:
//   - a rule that yields nothing leaves the field empty rather than failing the whole book,
//   - a URL a rule returns is resolved against the page it came from, because rules say
//     `a[href]` and expect a full URL back,
//   - a chapter list is read page by page when the source says there is a next page.
//
// Nothing here caches. The pages change, the rules rot, and a cache would hide both.

import { NovelBook, NovelChapter, NovelContent, NovelHit } from '../types';
import { RuleEnv, RuleScope, evalField, evalList, makeScope } from './rule';
import { CookieJar, FetchOptions, fetchPage, parseSourceHeaders, splitUrlOptions } from './http';
import { absoluteUrl, JsRuntime, evalJsRule } from './js';
import { DomElement, innerHtmlOf, parseHtml, rawTextOf, textOf } from './html';

/** The JSON of a book source, as it appears in a collection file. */
export interface BookSourceJson {
  bookSourceName?: string;
  bookSourceUrl?: string;
  bookSourceGroup?: string;
  /** 0 = text, 1 = comic, 2 = audio. */
  bookSourceType?: number;
  searchUrl?: string;
  ruleSearch?: Record<string, string>;
  ruleBookInfo?: Record<string, string>;
  ruleToc?: Record<string, string>;
  ruleContent?: Record<string, string>;
  /** The rules for a source's own shelves (its `exploreUrl` categories). */
  ruleExplore?: Record<string, string>;
  header?: string;
  bookUrlPattern?: string;
  enabled?: boolean;
  enabledExplore?: boolean;
  enabledCookieJar?: boolean;
  exploreUrl?: string;
  loginUrl?: string;
  customOrder?: number;
  /** Sources that carry adult material say so here, in one of a few spellings. */
  [key: string]: unknown;
}

export interface SourceOptions {
  /** The id the source is known by in the registry. */
  id: string;
  /** The cookies this source has collected. Shared per source so a login survives a reload. */
  jar: CookieJar;
  /** How long a single request may take. */
  timeoutMs?: number;
  /**
   * What a search already knew about a book at this URL.
   *
   * A source whose `ruleBookInfo` is empty has no details page of its own -- the title it showed
   * in the search is the title it knows. This is how that pairing reaches the book page without
   * the two modules having to know about each other.
   */
  knownHit?: (url: string) => { title: string; author?: string; intro?: string; coverUrl?: string } | undefined;
}

/** Turn a book's page HTML into readable text. */
export function htmlToText(html: string): string {
  const root = parseHtml(html);
  const parts: string[] = [];

  const walk = (node: { type: string; name?: string; children?: unknown[]; text?: string }): void => {
    if (node.type === 'text') {
      parts.push(node.text ?? '');
      return;
    }
    if (node.type === 'comment') return;
    const el = node as DomElement;
    if (el.name === 'script' || el.name === 'style' || el.name === 'noscript') return;
    if (el.name === 'br') {
      parts.push('\n');
      return;
    }
    const block = el.name === 'p' || el.name === 'div' || el.name === 'li' || el.name === 'h1'
      || el.name === 'h2' || el.name === 'h3' || el.name === 'h4' || el.name === 'blockquote'
      || el.name === 'section' || el.name === 'tr' || el.name === 'pre';
    if (block && parts.length && !parts[parts.length - 1].endsWith('\n')) parts.push('\n');
    for (const child of el.children) walk(child as never);
    if (block) parts.push('\n');
  };

  walk(root as never);
  return parts
    .join('')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l, i, arr) => l !== '' || (i > 0 && arr[i - 1] !== ''))
    .join('\n')
    .trim();
}

export class LegadoSource {
  readonly id: string;
  readonly json: BookSourceJson;
  readonly name: string;
  readonly baseUrl: string;
  private readonly jar: CookieJar;
  private readonly timeoutMs: number;
  private readonly rt: JsRuntime;
  private readonly knownHit?: SourceOptions['knownHit'];
  private resolvedHeaders: Record<string, string> | null = null;
  /**
   * The character set this source's pages are in, when its search URL says so.
   *
   * The source's URL options name it once, and every page of that site is in the same encoding --
   * so it is remembered and used for the book page and the chapter pages too.
   */
  private charset?: string;

  /**
   * What the last fetch of this source looked like.
   *
   * A search that returns nothing is ambiguous: the rules may not match, or the site may have
   * answered with an error page (a 404 saying the book is gone, a redirect to a challenge, an empty
   * body from a dead host). Those call for opposite decisions -- fix the rules, or drop the source
   * -- so the shape of the last page is kept where the caller can see it.
   */
  lastFetch: { status: number; length: number; url: string } | null = null;

  /**
   * The body of the last page this source fetched.
   *
   * Kept so a caller can ask what the page actually said -- whether the keyword it searched for was
   * in it, for instance. A page without the keyword is a page whose results were never in its HTML,
   * which is a different thing from a rule that stopped matching.
   */
  lastBody = '';

  constructor(json: BookSourceJson, options: SourceOptions) {
    this.json = json;
    this.id = options.id;
    this.jar = options.jar;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.knownHit = options.knownHit;
    this.name = json.bookSourceName || json.bookSourceUrl || options.id;
    this.baseUrl = json.bookSourceUrl || '';
    this.rt = new JsRuntime({
      sourceKey: options.id,
      sourceName: this.name,
      sourceBaseUrl: this.baseUrl,
    });
    // One jar for the whole source: the rule's own requests and the source's requests share it.
    this.rt.jar = this.jar;
  }

  /**
   * The headers this source asks for.
   *
   * A source may give them as JSON, as an object, or -- which is the case that catches people out --
   * as a JavaScript rule that COMPUTES them: `@js:JSON.stringify({"User-Agent":"..."})`. The rule
   * form is why the headers are resolved lazily: the rule needs a runtime, and the runtime wants
   * the headers.
   */
  get headers(): Record<string, string> {
    if (this.resolvedHeaders) return this.resolvedHeaders;
    const raw = this.json.header;
    let out: Record<string, string> = {};

    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (trimmed.startsWith('@js:') || trimmed.startsWith('<js>')) {
        try {
          const ctx = { result: '', origin: this.baseUrl, groups: [], vars: {} };
          const value = evalJsRule(trimmed, this.rt, ctx);
          if (typeof value === 'string') out = parseSourceHeaders(value);
          else if (value && typeof value === 'object') out = parseSourceHeaders(value as Record<string, string>);
        } catch {
          out = {};
        }
      } else {
        out = parseSourceHeaders(raw);
      }
    } else if (raw && typeof raw === 'object') {
      out = parseSourceHeaders(raw as Record<string, string>);
    }

    this.resolvedHeaders = out;
    this.rt.headers = out;
    return out;
  }

  /**
   * The adult flag, read from the several spellings a source may use.
   *
   * The rule for "18" is that it is not part of a longer number: `R18`, `(18)`, `18禁`, `18ys` are
   * adult markers, and `118` or `318` in a host name are not. The spellings the collections actually
   * use are many -- `PO18`, `R18`, `18禁`, `无码`, `无修正`, `里番` -- and a source that carries adult
   * material but is not flagged is one the 18+ switch would put on screen unasked.
   */
  get isNsfw(): boolean {
    const j = this.json as Record<string, unknown>;
    if (j.isNsfw === true || j.nsfw === true) return true;
    const ADULT = /(^|[^\d])18($|[^\d])|po18|r18|nsfw|无码|无修正|禁漫|里番|色情|成人|福利|重口|绅士/i;
    if (typeof j.bookSourceComment === 'string' && ADULT.test(j.bookSourceComment)) return true;
    if (typeof j.bookSourceName === 'string' && ADULT.test(j.bookSourceName)) return true;
    if (typeof j.bookSourceGroup === 'string' && ADULT.test(j.bookSourceGroup)) return true;
    if (typeof j.bookSourceUrl === 'string' && ADULT.test(j.bookSourceUrl)) return true;
    return false;
  }

  private env(url: string): RuleEnv {
    return { url, runtime: this.rt, vars: {} };
  }

  /** Fetch a page the way this source's rules expect it to be fetched. */
  private async get(url: string, extra: FetchOptions = {}): Promise<{ body: string; url: string; status: number }> {
    const absolute = absoluteUrl(url, this.baseUrl);
    const cookie = this.jar.header(absolute);
    const res = await fetchPage(absolute, {
      ...extra,
      headers: { ...this.headers, ...(extra.headers || {}) },
      cookie: cookie || extra.cookie,
      referer: extra.referer ?? this.baseUrl,
      timeoutMs: extra.timeoutMs ?? this.timeoutMs,
      charset: extra.charset ?? this.charset,
    });
    this.jar.store(res.url, res.setCookie);
    this.lastFetch = { status: res.status, length: res.body.length, url: res.url };
    this.lastBody = res.body;
    return { body: res.body, url: res.url, status: res.status };
  }

  // -------------------------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------------------------

  /**
   * Search the source.
   *
   * `opts.timeoutMs` is how long this one call may take. A search asks two hundred sources at
   * once, and a source that is not there would otherwise hold its slot for the source's own full
   * timeout (twenty seconds) -- which is longer than the whole search is willing to take, and long
   * enough to be the reason the answer is late.
   */
  async search(query: string, page = 1, opts: { timeoutMs?: number } = {}): Promise<NovelHit[]> {
    const template = this.json.searchUrl;
    if (!template) return [];

    // The search URL may be a JavaScript rule rather than a template: the rule fetches a page, reads
    // a token out of it, and builds the URL (and often the POST body) from what it found. The result
    // of such a rule is a URL with the usual `,{...}` options tail, so it is split the same way.
    const computed = this.searchUrlFrom(template, query, page);
    const { url: rawUrl, options } = splitUrlOptions(computed);
    const url = this.buildUrl(rawUrl, { key: query, page: String(page) });
    if (options.charset) this.charset = options.charset;
    const res = await this.get(url, {
      method: options.method,
      body: options.body?.replace(/\{\{key\}\}/g, encodeURIComponent(query)).replace(/\{\{page\}\}/g, String(page)),
      headers: options.headers,
      charset: options.charset,
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    });
    if (!res.body) return [];

    const scope = makeScope(res.body, res.url);
    const rules = this.json.ruleSearch || {};
    const listRule = rules.bookList;
    if (!listRule) return [];

    const items = evalList(listRule, this.env(res.url), scope);
    const hits: NovelHit[] = [];

    for (const item of items) {
      const name = this.field(rules.name, res.url, item);
      if (!name) continue;
      const rawUrl2 = this.field(rules.bookUrl, res.url, item);
      const bookUrl = rawUrl2 ? absoluteUrl(rawUrl2, res.url) : '';
      hits.push({
        id: bookUrl || `${this.id}:${name}`,
        source: this.id,
        title: name,
        author: this.field(rules.author, res.url, item) || undefined,
        intro: this.field(rules.intro, res.url, item) || undefined,
        kind: this.field(rules.kind, res.url, item) || undefined,
        lastChapter: this.field(rules.lastChapter, res.url, item) || undefined,
        coverUrl: absoluteUrl(this.field(rules.coverUrl, res.url, item), res.url) || undefined,
        url: bookUrl || undefined,
        wordCount: this.field(rules.wordCount, res.url, item) || undefined,
        isNsfw: this.isNsfw,
      });
    }
    return hits;
  }

  // -------------------------------------------------------------------------------------------
  // Book details
  // -------------------------------------------------------------------------------------------

  async info(bookUrl: string): Promise<NovelBook | null> {
    const res = await this.get(bookUrl);
    if (!res.body) return null;

    const rules = this.json.ruleBookInfo || {};
    // `init` is where the book's own record lives when the page carries a JSON blob.
    let scope = makeScope(res.body, res.url);
    if (rules.init) {
      const inits = evalList(rules.init, this.env(res.url), scope);
      if (inits.length) scope = inits[0];
    }

    const tocUrlRaw = this.field(rules.tocUrl, res.url, scope);
    const tocUrl = tocUrlRaw ? absoluteUrl(tocUrlRaw, res.url) : res.url;

    // A source with no details rules of its own knows only what its search told it.
    const known = this.knownHit?.(bookUrl);

    const book: NovelBook = {
      id: bookUrl,
      source: this.id,
      title: this.field(rules.name, res.url, scope) || known?.title || '',
      author: this.field(rules.author, res.url, scope) || known?.author || undefined,
      intro: this.field(rules.intro, res.url, scope) || known?.intro || undefined,
      kind: this.field(rules.kind, res.url, scope) || undefined,
      lastChapter: this.field(rules.lastChapter, res.url, scope) || undefined,
      coverUrl: absoluteUrl(this.field(rules.coverUrl, res.url, scope), res.url) || known?.coverUrl || undefined,
      url: bookUrl,
      wordCount: this.field(rules.wordCount, res.url, scope) || undefined,
      isNsfw: this.isNsfw,
      chapters: [],
      tocUrl,
    };

    book.chapters = await this.toc(tocUrl, book.id);
    return book;
  }

  // -------------------------------------------------------------------------------------------
  // Table of contents
  // -------------------------------------------------------------------------------------------

  async toc(tocUrl: string, bookId: string, maxPages = 20): Promise<NovelChapter[]> {
    const rules = this.json.ruleToc || {};
    const listRule = rules.chapterList;
    if (!listRule) return [];

    const chapters: NovelChapter[] = [];
    let next = tocUrl;
    let page = 0;

    while (next && page < maxPages) {
      page++;
      const res = await this.get(next);
      if (!res.body) break;
      const scope = makeScope(res.body, res.url);
      const items = evalList(listRule, this.env(res.url), scope);

      for (const item of items) {
        const title = this.field(rules.chapterName, res.url, item) || this.field(rules.chapterText, res.url, item);
        const urlRaw = this.field(rules.chapterUrl, res.url, item);
        const url = urlRaw ? absoluteUrl(urlRaw, res.url) : '';
        const isVip = this.field(rules.isVip, res.url, item);
        chapters.push({
          id: url || `${bookId}#${chapters.length}`,
          source: this.id,
          bookId,
          title: title || `第 ${chapters.length + 1} 章`,
          index: chapters.length,
          url: url || undefined,
          isVip: isVip ? /^(true|1|是|付费|vip)$/i.test(isVip.trim()) : undefined,
          updatedAt: this.field(rules.updateTime, res.url, item) || undefined,
        });
      }

      const nextRaw = this.field(rules.nextTocUrl, res.url, scope);
      const nextAbs = nextRaw ? absoluteUrl(nextRaw, res.url) : '';
      next = nextAbs && nextAbs !== next ? nextAbs : '';
    }
    return chapters;
  }

  // -------------------------------------------------------------------------------------------
  // Chapter text
  // -------------------------------------------------------------------------------------------

  async content(chapterUrl: string): Promise<NovelContent | null> {
    const res = await this.get(chapterUrl);
    if (!res.body) return null;
    const rules = this.json.ruleContent || {};
    const scope = makeScope(res.body, res.url);

    const raw = this.field(rules.content, res.url, scope);
    if (!raw) return null;

    let text = raw;
    // A content rule that ends on `html` gives markup; a rule that ends on `text` gives text.
    if (/<[a-zA-Z!/]/.test(text)) text = htmlToText(text);

    if (rules.replaceRegex) {
      try {
        const { evalRegex } = require('./rule') as typeof import('./rule');
        const { value } = evalRegex(rules.replaceRegex, scope);
        if (value) text = value;
      } catch {
        /* a rule that cannot run leaves the text as it was */
      }
    }

    const nextRaw = this.field(rules.nextContentUrl, res.url, scope);
    return {
      chapterId: chapterUrl,
      title: this.field(rules.title, res.url, scope) || undefined,
      text: text.trim(),
      nextUrl: nextRaw ? absoluteUrl(nextRaw, res.url) : undefined,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------------------------

  /**
   * The URL to search, from the source's `searchUrl`.
   *
   * Usually that is a template with `{{key}}` and `{{page}}` in it. Sometimes it is a JavaScript
   * rule that computes the URL -- the rule fetches the site's search page, reads a token out of it,
   * and builds both the address and the POST body from what it found. The rule's result is a URL
   * with the same `,{...}` options tail a template can carry, so the two are read the same way.
   */
  private searchUrlFrom(template: string, query: string, page: number): string {
    const trimmed = template.trim();
    if (!trimmed.startsWith('@js:') && !trimmed.startsWith('<js>')) return template;
    try {
      const ctx = {
        result: '',
        origin: this.baseUrl,
        groups: [],
        // Legado's own names for the two things the rule needs: the keyword and the page.
        vars: { key: query, page: String(page), bookName: query },
      };
      const value = evalJsRule(trimmed, this.rt, ctx);
      if (typeof value === 'string' && value.trim()) return value.trim();
      // A rule that returned an object with a URL in it.
      if (value && typeof value === 'object') {
        const url = (value as Record<string, unknown>).url;
        if (typeof url === 'string') return url;
      }
    } catch {
      /* a rule that cannot run leaves the template as it was */
    }
    return template;
  }

  /**
   * Everything about one search, for diagnosing a source that returns nothing.
   *
   * It goes through the SAME path a real search does -- the same URL computation, the same
   * JavaScript rules, the same character set -- so what it reports is what the source really did,
   * not what a separate script would have got by doing it slightly differently.
   */
  async debugSearch(query: string, page = 1): Promise<{
    url: string;
    computed: string;
    status: number;
    body: string;
    items: number;
    listRule: string;
    error?: string;
  }> {
    const template = this.json.searchUrl || '';
    const listRule = this.json.ruleSearch?.bookList || '';
    try {
      const computed = this.searchUrlFrom(template, query, page);
      const { url: rawUrl, options } = splitUrlOptions(computed);
      const url = this.buildUrl(rawUrl, { key: query, page: String(page) });
      if (options.charset) this.charset = options.charset;
      const res = await this.get(url, {
        method: options.method,
        body: options.body?.replace(/\{\{key\}\}/g, encodeURIComponent(query)).replace(/\{\{page\}\}/g, String(page)),
        headers: options.headers,
        charset: options.charset,
      });
      const scope = makeScope(res.body, res.url);
      const items = evalList(listRule, this.env(res.url), scope).length;
      return { url: res.url, computed: computed.slice(0, 400), status: res.status, body: res.body, items, listRule };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const computed = this.searchUrlFrom(template, query, page);
      return { url: '', computed: computed.slice(0, 400), status: 0, body: '', items: 0, listRule, error: message };
    }
  }

  /**
   * The books on one of the source's own shelves (its `exploreUrl` categories).
   *
   * A shelf page is a page like any other: it is fetched and read with the source's rules. The list
   * rule comes from `ruleExplore` when the source has one and from `ruleSearch` when it does not --
   * a site that lists its categories with the same markup as its search results is the common case,
   * and a source that says nothing about a shelf is still worth asking.
   */
  async searchShelf(url: string, limit = 60): Promise<NovelHit[]> {
    // A category URL is a template like any other: the collections write `{{page}}` into it, and
    // fetching it literally asks the site for a page called "{{page}}" -- which answers with an
    // error page, or with the first page, depending on the site. Page 1 is what a shelf means.
    const { url: rawUrl, options } = splitUrlOptions(url);
    const built = this.buildUrl(rawUrl, { page: '1', key: '' });
    const res = await this.get(built, {
      method: options.method,
      body: options.body?.replace(/\{\{key\}\}/g, '').replace(/\{\{page\}\}/g, '1'),
      headers: options.headers,
      charset: options.charset,
    });
    if (options.charset) this.charset = options.charset;
    if (!res.body) return [];
    const explore = this.json.ruleExplore || {};
    const search = this.json.ruleSearch || {};
    const listRule = explore.bookList || search.bookList || '';
    if (!listRule) return [];

    const scope = makeScope(res.body, res.url);
    const items = evalList(listRule, this.env(res.url), scope);
    const hits: NovelHit[] = [];

    for (const item of items) {
      const name = this.field(explore.name || search.name, res.url, item);
      if (!name) continue;
      const rawUrl = this.field(explore.bookUrl || search.bookUrl, res.url, item);
      const bookUrl = rawUrl ? absoluteUrl(rawUrl, res.url) : '';
      hits.push({
        id: bookUrl || `${this.id}:${name}`,
        source: this.id,
        title: name,
        author: this.field(explore.author || search.author, res.url, item) || undefined,
        intro: this.field(explore.intro || search.intro, res.url, item) || undefined,
        kind: this.field(explore.kind || search.kind, res.url, item) || undefined,
        lastChapter: this.field(explore.lastChapter || search.lastChapter, res.url, item) || undefined,
        coverUrl: absoluteUrl(this.field(explore.coverUrl || search.coverUrl, res.url, item), res.url) || undefined,
        url: bookUrl || undefined,
        wordCount: this.field(explore.wordCount || search.wordCount, res.url, item) || undefined,
        isNsfw: this.isNsfw,
      });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  /** Run one field rule and return its text. A rule that fails leaves the field empty. */
  private field(rule: string | undefined, pageUrl: string, scope: RuleScope): string {
    if (!rule || !rule.trim()) return '';
    try {
      return (evalField(rule, this.env(pageUrl), scope) || '').trim();
    } catch {
      return '';
    }
  }

  /** Fill a URL template's `{{...}}` placeholders. */
  private buildUrl(template: string, vars: Record<string, string>): string {
    let url = template.replace(/\{\{(\w+)\}\}/g, (_whole, key: string) => {
      if (key in vars) return vars[key];
      return '';
    });
    // A key that was not filled in is not a valid URL; the source meant something else.
    if (!/\{\{/.test(template)) return url;
    return url.replace(/\{\{[^}]*\}\}/g, '');
  }
}

export { innerHtmlOf, rawTextOf, textOf };
