// The title a MangaDex adapter shows is the title in ITS language.
//
// MangaDex keeps the ORIGINAL name in `attributes.title` -- the Japanese romanisation for a Japanese
// work, the English name for an English one -- and every TRANSLATED name in `attributes.altTitles`,
// as one single-language map per alternative. The Chinese name of Berserk (烙印勇士, 劍風傳奇) is in
// `altTitles` and nowhere else.
//
// The adapter read `title` and stopped there, so a Chinese reader asking MangaDex for Chinese
// chapters was shown "Berserk". The chapters were Chinese; the name was not. That is the whole bug.
//
// These are unit tests against a stubbed API: the fixtures are MangaDex's own shapes, and the names
// are the ones MangaDex actually holds for these works.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeMangadex, _setMangadexPacing, _resetMangadexLimiter } from '../src/lib/sources/mangadex';

const realFetch = globalThis.fetch;

/** A MangaDex entry, with the original title and the alternatives MangaDex keeps. */
function entry(attributes: Record<string, unknown>): unknown {
  return {
    id: 'series-1',
    type: 'manga',
    attributes: {
      status: 'ongoing',
      originalLanguage: 'ja',
      contentRating: 'safe',
      ...attributes,
    },
    relationships: [
      { id: 'cover-1', type: 'cover_art', attributes: { fileName: 'cover.jpg' } },
      { id: 'author-1', type: 'author', attributes: { name: 'Someone' } },
    ],
  };
}

/**
 * Serve one manga entry, whatever is asked for.
 *
 * The single-title endpoint answers with an OBJECT (`data` is the entity itself), and the list
 * endpoints answer with an array. These tests ask for one title, so it is the object shape.
 */
function stub(attributes: Record<string, unknown>) {
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ result: 'ok', response: 'entity', data: entry(attributes) }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )) as typeof fetch;
}

before(() => _setMangadexPacing({ apiGapMs: 0, atHomeGapMs: 0 }));
after(() => _setMangadexPacing(null));
test.afterEach(() => { globalThis.fetch = realFetch; _resetMangadexLimiter(); });

test('a Chinese adapter names the title in Chinese', async () => {
  // Berserk, as MangaDex holds it: the original name in `title`, the Chinese ones in `altTitles`.
  stub({
    title: { 'ja-ro': 'Berserk' },
    altTitles: [
      { ja: 'ベルセルク' },
      { ko: '베르세르크' },
      { zh: '烙印勇士' },
      { 'zh-hk': '劍風傳奇' },
      { en: 'Berserk' },
    ],
  });

  const simplified = await makeMangadex('zh-Hans').getSeries('series-1');
  assert.equal(simplified?.title, '烙印勇士', 'the simplified adapter did not use the simplified name');

  const traditional = await makeMangadex('zh-Hant').getSeries('series-1');
  assert.equal(traditional?.title, '劍風傳奇', 'the traditional adapter did not use the traditional name');
});

test('the two Chinese variants are each other’s fallback', async () => {
  // A work translated only into traditional Chinese is still Chinese: the reader can read it, and
  // an empty name is worse than the other variant.
  stub({ title: { 'ja-ro': 'Berserk' }, altTitles: [{ 'zh-hk': '劍風傳奇' }] });
  const simplified = await makeMangadex('zh-Hans').getSeries('series-1');
  assert.equal(simplified?.title, '劍風傳奇');
});

test('a title with no Chinese name falls back to English, not to nothing', async () => {
  // MangaDex holds no Chinese name for this one. It is still a Chinese-readable work -- the
  // chapters are Chinese -- so the name it does have is the one to show.
  stub({
    title: { 'ja-ro': 'The Eminence in Shadow' },
    altTitles: [{ ja: '陰の実力者になりたくて！' }, { en: 'The Eminence in Shadow' }],
  });
  const zh = await makeMangadex('zh-Hans').getSeries('series-1');
  assert.equal(zh?.title, 'The Eminence in Shadow', 'a work with no Chinese name still has a name');

  // The Japanese adapter shows the Japanese name -- it has one, so there is no reason to reach
  // for the romanisation.
  const ja = await makeMangadex('ja').getSeries('series-1');
  assert.equal(ja?.title, '陰の実力者になりたくて！');
});

test('with no name in any language the romanisation is the last resort', async () => {
  // Only the romanisation, and nothing else: the row is never nameless.
  stub({ title: { 'ja-ro': 'Kage no Jitsuryokusha ni Naritakute!' }, altTitles: [] });
  const zh = await makeMangadex('zh-Hans').getSeries('series-1');
  assert.equal(zh?.title, 'Kage no Jitsuryokusha ni Naritakute!');
});

test('a Japanese adapter names the title in Japanese', async () => {
  stub({
    title: { 'ja-ro': 'Kage no Jitsuryokusha ni Naritakute!' },
    altTitles: [{ ja: '陰の実力者になりたくて！' }, { en: 'The Eminence in Shadow' }],
  });
  const ja = await makeMangadex('ja').getSeries('series-1');
  assert.equal(ja?.title, '陰の実力者になりたくて！');
});

test('the images are fetched as a reader, not as a browser', () => {
  // MangaDex's image CDN runs a bot challenge, and it answers 403 -- "Bot challenge not passed,
  // refresh this page." -- to anything that CLAIMS to be a browser. A Chrome user-agent with no
  // browser behind it is the shape of a scraper, and the challenge is built to tell them apart:
  // the same request with a plain, honest user-agent is served (measured 2026-11-11 on
  // uploads.mangadex.org -- every "Mozilla/..." user-agent was refused, every other one served).
  //
  // So the adapter's own user-agent is what gets the pictures. Without it every cover was a
  // placeholder and every page of every chapter was blank.
  const headers = makeMangadex('en').imageHeaders as Record<string, string>;
  const ua = headers?.['user-agent'] ?? '';
  assert.ok(ua, 'the MangaDex adapter sends no user-agent of its own');
  assert.ok(!ua.startsWith('Mozilla/'), `a browser user-agent is refused by the image CDN: ${ua}`);
  assert.ok(ua.includes('hbook'), `the user-agent should say who it is: ${ua}`);
});

test('the description is in the same language as the name', async () => {
  stub({
    title: { 'ja-ro': 'Berserk' },
    altTitles: [{ zh: '烙印勇士' }],
    description: { en: 'A dark fantasy epic.', zh: '一部黑暗幻想史诗。' },
  });
  const zh = await makeMangadex('zh-Hans').getSeries('series-1');
  assert.equal(zh?.summary, '一部黑暗幻想史诗。');

  const en = await makeMangadex('en').getSeries('series-1');
  assert.equal(en?.summary, 'A dark fantasy epic.');
});
