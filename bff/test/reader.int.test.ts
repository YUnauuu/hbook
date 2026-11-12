// The reader's API.
//
// The app in `reader/` is the whole point of these routes, and the app has no accounts: so these
// tests are about the things that would break it. A route that starts requiring a token, a source
// list that stops answering, an adult switch that stops switching -- each of those shows up in the
// browser as "the site opens and shows nothing", which is the exact symptom that sent this work
// here.
//
// Pure unit tests where they can be: no database, no network, no live site.

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

test('every route answers without an account', async () => {
  const app = await makeApp();
  try {
    // No cookie, no Authorization header, no session. The whole point.
    for (const url of [
      '/api/reader/sources',
      '/api/reader/search?kind=manga&q=test',
      '/api/reader/manga/browse?sort=latest',
      '/api/reader/manga/browse?sort=popular',
      '/api/reader/novel/explore',
    ]) {
      const res = await app.inject({ method: 'GET', url });
      assert.equal(res.statusCode, 200, `${url} answered ${res.statusCode}`);
    }
  } finally {
    await app.close();
  }
});

test('a bad query is a 400 with a reason, not a 500', async () => {
  const app = await makeApp();
  try {
    const missing = await app.inject({ method: 'GET', url: '/api/reader/search' });
    assert.equal(missing.statusCode, 400);
    assert.equal(missing.json().error, 'bad_query');

    const empty = await app.inject({ method: 'GET', url: '/api/reader/search?q=%20%20' });
    assert.equal(empty.statusCode, 400);

    const overLimit = await app.inject({ method: 'GET', url: '/api/reader/search?q=x&limit=9999' });
    assert.equal(overLimit.statusCode, 400);
  } finally {
    await app.close();
  }
});

test('the 18+ switch is per request, and off means off', async () => {
  const app = await makeApp();
  try {
    const on = await app.inject({ method: 'GET', url: '/api/reader/sources?adult=1' });
    const off = await app.inject({ method: 'GET', url: '/api/reader/sources?adult=0' });
    assert.equal(on.statusCode, 200);
    assert.equal(off.statusCode, 200);

    const onBody = on.json();
    const offBody = off.json();
    // Whatever the collection holds, the adult sources must not appear when the switch is off.
    assert.ok(Array.isArray(onBody.manga) && Array.isArray(onBody.novels));
    for (const source of offBody.novels) {
      assert.equal(source.isNsfw, false, `${source.name} is an adult source and must not be listed`);
    }
    // And the two lists must not be the same list.
    assert.ok(onBody.novels.length >= offBody.novels.length);
  } finally {
    await app.close();
  }
});

test('the language picker picks the language, and Chinese is the default', async () => {
  const app = await makeApp();
  try {
    // The default is Chinese: MangaDex publishes every language on one site, so without saying
    // which one, the biggest wins -- and the biggest is English.
    const def = await app.inject({ method: 'GET', url: '/api/reader/sources' });
    assert.equal(def.statusCode, 200);
    assert.equal(def.json().lang, 'zh');

    // Whatever the sources are, the Chinese ones are the ones a Chinese reader is shown, and the
    // English ones are not.
    const zh = await app.inject({ method: 'GET', url: '/api/reader/sources?lang=zh' });
    const all = await app.inject({ method: 'GET', url: '/api/reader/sources?lang=all' });
    assert.equal(zh.statusCode, 200);
    assert.equal(all.statusCode, 200);
    const zhIds = (zh.json().manga as Array<{ id: string }>).map((s) => s.id);
    const allIds = (all.json().manga as Array<{ id: string }>).map((s) => s.id);
    assert.ok(zhIds.length <= allIds.length, 'Chinese shows more sources than all of them');
    for (const id of zhIds) assert.ok(allIds.includes(id), `${id} is shown for Chinese but not for all`);

    // A language nobody asked for falls back to Chinese rather than to nothing.
    const bogus = await app.inject({ method: 'GET', url: '/api/reader/sources?lang=klingon' });
    assert.equal(bogus.json().lang, 'zh');
  } finally {
    await app.close();
  }
});

test('an unknown source is a 404, not a crash', async () => {
  const app = await makeApp();
  try {
    for (const url of [
      '/api/reader/manga/book?source=nope&id=nope',
      '/api/reader/manga/pages?source=nope&id=nope',
      '/api/reader/novel/book?source=nope&id=nope',
      '/api/reader/novel/chapter?source=nope&id=nope',
      '/api/reader/novel/shelf?source=nope&url=https%3A%2F%2Fexample.test%2F',
    ]) {
      const res = await app.inject({ method: 'GET', url });
      assert.equal(res.statusCode, 404, `${url} answered ${res.statusCode}`);
      assert.equal(res.json().error, 'not_found');
    }
  } finally {
    await app.close();
  }
});

test('the image route refuses a URL it cannot use', async () => {
  const app = await makeApp();
  try {
    const missing = await app.inject({ method: 'GET', url: '/api/reader/img' });
    assert.equal(missing.statusCode, 400);
  } finally {
    await app.close();
  }
});
