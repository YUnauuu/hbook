// The novel side of the API.
//
// Four things: which book sources there are, a search across them, a book's details and chapters,
// and a chapter's text. The rules that make any of that work live in lib/novel/.
//
// The adult filter is applied HERE, at the boundary, rather than deeper in: an adult book source is
// not searched at all for a caller who may not see it. Searching it and then dropping its results
// would still have asked the adult site for them, and an adult site's COVERS are exactly what the
// filter exists to keep off the screen.
//
// The sources are searched concurrently but each one independently, so one slow or dead site cannot
// hold up a search. That is also why the search has a deadline: with hundreds of sources loaded, a
// single unresponsive one would otherwise keep the request open for the sum of all of them.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import { authenticate, userIdOf, roleOf } from '../lib/auth';
import { hideAdult, sourceBrowsableFor, viewCtxFor, type ViewCtx } from '../lib/visibility';
import { TtlCache } from '../lib/novel/cache';
import {
  getNovelSource, listNovelSources, loadNovelSources, novelSourceCount, reloadNovelSources,
  searchNovelSources,
} from '../lib/novel/sources';
import { NovelBook, NovelContent } from '../lib/novel/types';

/** How long a search may take before the slow sources are left out of the answer. */
const SEARCH_DEADLINE_MS = 25_000;
/** How long a book's details stay fresh. */
const BOOK_TTL_MS = 5 * 60_000;
/** A chapter's text does not change, so it stays cached longer. */
const CHAPTER_TTL_MS = 30 * 60_000;

const books = new TtlCache<NovelBook>(BOOK_TTL_MS, 300);
const chapters = new TtlCache<NovelContent>(CHAPTER_TTL_MS, 500);

const searchQuery = z.object({
  q: z.string().trim().min(1).max(120),
  source: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).max(50).optional(),
});

const sourceQuery = z.object({
  source: z.string().trim().min(1).max(200),
  url: z.string().trim().min(1).max(2000),
});

export default async function novelRoutes(app: FastifyInstance) {
  if (!app.hasDecorator('createRateLimit')) await app.register(rateLimit, { global: false });
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', async (req) => {
    (req as any).viewCtx = await viewCtxFor(userIdOf(req), roleOf(req), { hideAdult: hideAdult(req) });
  });
  const vc = (req: FastifyRequest): ViewCtx => (req as any).viewCtx as ViewCtx;

  /** The sources this caller may search, as the visibility module sees them. */
  const allowed = (req: FastifyRequest) => (source: { id: string; isNsfw?: boolean }) =>
    sourceBrowsableFor(source, vc(req));

  /**
   * A source named in a query must be one the caller may use. Answering "not found" for a source that
   * exists but is off limits says the same thing as for one that does not exist, so the list of adult
   * sources is not leaked by their absence.
   */
  const sourceFor = (req: FastifyRequest, id: string) => {
    const source = getNovelSource(id);
    if (!source) return null;
    if (!allowed(req)({ id: source.id, isNsfw: source.isNsfw })) return null;
    return source;
  };

  app.get('/api/novels/sources', async (req) => {
    loadNovelSources();
    const ctx = vc(req);
    const all = listNovelSources();
    return {
      total: novelSourceCount(),
      shown: all.filter((s) => sourceBrowsableFor({ id: s.id, isNsfw: s.isNsfw }, ctx)).length,
      sources: all.filter((s) => sourceBrowsableFor({ id: s.id, isNsfw: s.isNsfw }, ctx)),
    };
  });

  app.get('/api/novels/search', async (req, reply) => {
    const parsed = searchQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_query', detail: parsed.error.issues });
    const { q, source, limit, page } = parsed.data;

    const sourceIds = source
      ? source.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;

    // A source named in the query that the caller may not use is dropped, not reported.
    const permitted = sourceIds
      ? sourceIds.filter((id) => allowed(req)({ id, isNsfw: getNovelSource(id)?.isNsfw }))
      : undefined;

    const deadline = Date.now() + SEARCH_DEADLINE_MS;
    const { hits, errors } = await searchNovelSources(q, {
      sourceIds: permitted,
      limit: limit ?? 40,
      page: page ?? 1,
      allow: (s) => allowed(req)({ id: s.id, isNsfw: s.isNsfw }),
    });

    return {
      query: q,
      hits,
      errors: errors.slice(0, 20),
      // Whether the search was cut short by the deadline -- the answer is complete only when it is false.
      truncated: Date.now() >= deadline,
    };
  });

  app.get('/api/novels/book', async (req, reply) => {
    const parsed = sourceQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_query', detail: parsed.error.issues });
    const source = sourceFor(req, parsed.data.source);
    if (!source) return reply.code(404).send({ error: 'not_found' });

    const key = `${source.id}::${parsed.data.url}`;
    try {
      const book = await books.through(key, async () => {
        const found = await source.info(parsed.data.url);
        if (!found) throw new Error('not found');
        return found;
      });
      return book;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === 'not found') return reply.code(404).send({ error: 'not_found' });
      return reply.code(502).send({ error: 'source_failed', message });
    }
  });

  app.get('/api/novels/chapter', async (req, reply) => {
    const parsed = sourceQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_query', detail: parsed.error.issues });
    const source = sourceFor(req, parsed.data.source);
    if (!source) return reply.code(404).send({ error: 'not_found' });

    const key = `${source.id}::${parsed.data.url}`;
    try {
      const content = await chapters.through(key, async () => {
        const found = await source.content(parsed.data.url);
        if (!found) throw new Error('not found');
        return found;
      });
      return content;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === 'not found') return reply.code(404).send({ error: 'not_found' });
      return reply.code(502).send({ error: 'source_failed', message });
    }
  });

  /** Re-read the sources directory. Cheap enough to call after dropping a file in it. */
  app.post('/api/novels/sources/reload', async (req) => {
    const added = reloadNovelSources();
    return { ok: true, total: novelSourceCount(), added };
  });

  /** The cache is per-process; the routes that own it should be able to say so. */
  app.get('/api/novels/health', async () => ({
    ok: true,
    sources: novelSourceCount(),
    cachedBooks: books.size,
    cachedChapters: chapters.size,
  }));
}
