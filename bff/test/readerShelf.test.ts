// The reader's shelves, and the sources that do not answer.
//
// Two things are tested here, and both of them are about what happens when a source is DOWN:
//
//   1. A source that fails is remembered, and is not asked again for a while. Asking a source that
//      is not there again costs a connection and a slot, and a fan-out that keeps asking thirty
//      unreachable sites holds the connections the working ones need -- the symptom being a shelf
//      that comes back empty while every dead site is still hanging on to something.
//
//   2. The shelf is collected, not answered: what the sources have said so far is kept, and the
//      reader is told that more is coming. A shelf that answers with one source's books is not a
//      shelf.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL
  || 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';

async function makeApp() {
  const Fastify = (await import('fastify')).default;
  const app = Fastify();
  const readerRoutes = (await import('../src/routes/reader')).default;
  await app.register(readerRoutes);
  await app.ready();
  return app;
}

test('a source that does not answer is remembered, and left alone for a while', async () => {
  const loader = await import('../src/lib/sources/loader');
  const reader = await import('../src/routes/reader');
  // A source that is down: it answers with an error, every time.
  loader.registerAdapter({
    id: 'test-dead-source',
    name: 'Dead source',
    lang: 'zh-Hans',
    base: 'https://dead.example',
    async search() { throw new Error('the site is not there'); },
    async latest() { throw new Error('the site is not there'); },
    async popular() { throw new Error('the site is not there'); },
    async getSeries() { throw new Error('the site is not there'); },
    async listChapters() { throw new Error('the site is not there'); },
    async getPageUrls() { throw new Error('the site is not there'); },
  });

  const app = await makeApp();
  try {
    const before = reader._coolingSources();
    const res = await app.inject({ method: 'GET', url: '/api/reader/manga/browse?sort=latest&source=test-dead-source' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().hits.length, 0, 'a source that is down has no books');
    assert.ok(res.json().errors.length > 0, 'and the failure is said out loud');

    // It is remembered: the next answer does not spend a slot on it.
    assert.ok(reader._coolingSources() > before, 'the failure is remembered');
    const list = await app.inject({ method: 'GET', url: '/api/reader/sources?adult=1' });
    const dead = (list.json().manga as Array<{ id: string; cooling: boolean }>).find((s) => s.id === 'test-dead-source');
    assert.ok(dead, 'the source is still in the list');
    assert.equal(dead!.cooling, true, 'and it is marked as one that is not answering');
  } finally {
    await app.close();
    loader.unregisterAdapter('test-dead-source');
  }
});

test('the shelf says whether it is still being filled', async () => {
  const app = await makeApp();
  try {
    const res = await app.inject({ method: 'GET', url: '/api/reader/manga/browse?sort=popular' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.sort, 'popular');
    assert.ok(Array.isArray(body.hits));
    // Whether more is coming is a fact the app needs: it asks again while it is true.
    assert.equal(typeof body.pending, 'boolean');
  } finally {
    await app.close();
  }
});

test('a shelf asks for pages, and stops at the first empty one', async () => {
  const loader = await import('../src/lib/sources/loader');
  const asked: number[] = [];
  loader.registerAdapter({
    id: 'test-paged-source',
    name: 'Paged source',
    lang: 'zh-Hans',
    base: 'https://paged.example',
    async search() { return []; },
    async latest(page = 1) {
      asked.push(page);
      if (page === 1) return [{ sourceId: 'a', title: 'A' }];
      if (page === 2) return [{ sourceId: 'b', title: 'B' }];
      return [];
    },
    async popular(page = 1) { return this.latest(page); },
    async getSeries() { return null; },
    async listChapters() { return []; },
    async getPageUrls() { return []; },
  } as any);

  const app = await makeApp();
  try {
    const res = await app.inject({ method: 'GET', url: '/api/reader/manga/browse?sort=latest&source=test-paged-source' });
    assert.equal(res.statusCode, 200);
    const titles = (res.json().hits as Array<{ title: string }>).map((h) => h.title);
    // Both pages, in order: one page is the front of a shelf, not a shelf.
    assert.deepEqual(titles, ['A', 'B']);
    // And the page after the empty one is never asked for: the site has nothing more.
    assert.deepEqual(asked, [1, 2, 3]);
  } finally {
    await app.close();
    loader.unregisterAdapter('test-paged-source');
  }
});
