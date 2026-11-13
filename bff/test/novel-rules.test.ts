// The rule engine, against fixtures written by hand.
//
// These fixtures are the engine's own test data, not a book source collection: they exercise one
// dialect feature each, so a failure names the feature that broke rather than "a site stopped
// working". The sources a real installation loads are probed separately (scripts/novel-probe.ts),
// because those are live sites whose behaviour changes.

import { test } from 'node:test';
import { existsSync } from 'node:fs';
import assert from 'node:assert/strict';

import { evalField, evalList, makeScope, splitOperators } from '../src/lib/novel/legado/rule';
import { htmlToText } from '../src/lib/novel/legado/source';
import { jsonPath } from '../src/lib/novel/legado/jsonpath';
import { selectXPath } from '../src/lib/novel/legado/xpath';
import { parseHtml, queryAll, textOf } from '../src/lib/novel/legado/html';
import { sourceDirCandidates, sourcesDir } from '../src/lib/novel/sources';

const env = { url: 'https://example.test/book/1', runtime: undefined as never, vars: {} };

const PAGE = `
<html><head>
  <meta property="og:novel:book_name" content="测试小说" />
  <meta property="og:novel:author" content="某作者" />
</head><body>
  <div class="book-list">
    <ul class="list">
      <li class="item"><a href="/book/11">第一本书</a><span class="author">作者甲</span><p class="intro">简介甲</p><img src="/c/11.jpg"></li>
      <li class="item"><a href="/book/22">第二本书</a><span class="author">作者乙</span><p class="intro">简介乙</p><img src="/c/22.jpg"></li>
      <li class="item"><a href="/book/33">第三本书</a><span class="author">作者丙</span><p class="intro">简介丙</p><img src="/c/33.jpg"></li>
    </ul>
  </div>
  <div id="content"><p>第一段。</p><p>第二段。</p></div>
</body></html>`;

test('the parser keeps the shape of the page', () => {
  const root = parseHtml(PAGE);
  assert.equal(queryAll(root, '.item').length, 3);
  assert.equal(textOf(queryAll(root, '.author')[0]), '作者甲');
  assert.equal(queryAll(root, 'meta[property="og:novel:author"]')[0].attrs.content, '某作者');
  // The XPath habit of writing `[@attr=...]` is tolerated rather than losing the whole selector.
  assert.equal(queryAll(root, 'meta[@property="og:novel:author"]').length, 1);
});

test('the parser survives the markup real sites ship', () => {
  const root = parseHtml('<div class=a><p>one<div>two<span>three</div><ul><li>x<li>y</ul></div>');
  assert.equal(queryAll(root, 'li').length, 2);
  assert.equal(queryAll(root, '.a').length, 1);
  // An unclosed <p> is closed by the <div> that follows it.
  assert.equal(queryAll(root, 'p').length, 1);
});

test('a CSS chain walks into each step', () => {
  const scope = makeScope(PAGE, 'https://example.test/');
  assert.equal(evalField('class.item@tag.a@text', env, scope), '第一本书\n第二本书\n第三本书');
});

test('.0 takes the first match only', () => {
  const scope = makeScope(PAGE, 'https://example.test/');
  assert.equal(evalField('class.item.0@tag.a@text', env, scope), '第一本书');
  assert.equal(evalField('class.item.1@tag.a@text', env, scope), '第二本书');
});

test('a negative index counts from the end', () => {
  const scope = makeScope(PAGE, 'https://example.test/');
  assert.equal(evalField('class.item.-1@tag.a@text', env, scope), '第三本书');
});

test('!0 drops the nth match', () => {
  const scope = makeScope(PAGE, 'https://example.test/');
  assert.equal(evalField('class.item@tag.a!0@text', env, scope), '第二本书\n第三本书');
});

test('an attribute step reads the attribute', () => {
  const scope = makeScope(PAGE, 'https://example.test/');
  assert.equal(evalField('class.item.0@tag.img@src', env, scope), '/c/11.jpg');
});

// The collections spell the same thing several ways. These are the spellings that are actually in
// use, taken from the rule collections -- each one is a rule that a real site ships, and each one
// used to fail for a different reason.

test('a tag named the way a person writes it', () => {
  const scope = makeScope(PAGE, 'https://example.test/');
  assert.equal(evalField('class.item.0@a@href', env, scope), '/book/11');
  assert.equal(evalField('class.item.0@img@src', env, scope), '/c/11.jpg');
  assert.equal(evalField('class.item.0@span@text', env, scope), '作者甲');
});

test('a raw CSS selector names a step', () => {
  const scope = makeScope(PAGE, 'https://example.test/');
  assert.equal(evalField('.item.0@a@text', env, scope), '第一本书');
  assert.equal(evalField('#content@p@text', env, scope), '第一段。\n第二段。');
  assert.equal(evalField('#content@p.0@text', env, scope), '第一段。');
  assert.equal(evalField('.item.0@.author@text', env, scope), '作者甲');
});

test('the child combinator means the direct child', () => {
  const scope = makeScope(PAGE, 'https://example.test/');
  assert.equal(evalField('#content > p@text', env, scope), '第一段。\n第二段。');
});

test('text. finds an element by its text', () => {
  const page = '<div id="nav"><a href="/p/2">下一页</a></div>';
  const scope = makeScope(page, 'https://example.test/');
  assert.equal(evalField('text.下一页@href', env, scope), '/p/2');
  // The text is often longer than the word: "下一页 >" still has to be found.
  const loose = makeScope('<div id="nav"><a href="/p/3">下一页 &gt;</a></div>', 'https://example.test/');
  assert.equal(evalField('text.下一页@href', env, loose), '/p/3');
});

test('css: takes a raw selector, with the jQuery index', () => {
  const page = '<table><tr><td>一</td></tr><tr><td>二</td></tr></table>';
  const scope = makeScope(page, 'https://example.test/');
  assert.equal(evalField('css:td:eq(1)@text', env, scope), '二');
  assert.equal(evalField('css:tr@td@text', env, scope), '一\n二');
});

test('the jQuery index picks the nth match', () => {
  const scope = makeScope(PAGE, 'https://example.test/');
  assert.equal(evalField('.item[1]@a@text', env, scope), '第二本书');
});

test('a list rule splits the page into items', () => {
  const scope = makeScope(PAGE, 'https://example.test/');
  const items = evalList('class.item', env, scope);
  assert.equal(items.length, 3);
  // Each item is its own scope, so the sibling rules read INSIDE it.
  assert.equal(evalField('tag.a@text', env, items[1]), '第二本书');
  assert.equal(evalField('class.author@text', env, items[1]), '作者乙');
});

test('a one-step field rule reads the item it is in', () => {
  // The shape most of the collections write their fields in: `text` for the title, `href` for the
  // address, with no selector in front of them, because the item IS the element.
  const scope = makeScope(PAGE, 'https://example.test/');
  const items = evalList('class.item', env, scope);
  assert.equal(evalField('text', env, items[0]), '第一本书作者甲简介甲');
  assert.equal(evalField('href', env, items[0]), '');        // the item is the <li>, not the link
  const links = evalList('class.item@tag.a', env, scope);
  assert.equal(evalField('text', env, links[2]), '第三本书');
  assert.equal(evalField('href', env, links[2]), '/book/33');
});

test('|| takes the first alternative that yields something', () => {
  const scope = makeScope(PAGE, 'https://example.test/');
  assert.equal(evalField('class.nothing@text || class.author.0@text', env, scope), '作者甲');
});

test('&& joins both', () => {
  const scope = makeScope(PAGE, 'https://example.test/');
  assert.equal(evalField('class.author.0@text && class.intro.0@text', env, scope), '作者甲\n简介甲');
});

test('a JSON path reads a JSON page', () => {
  const scope = makeScope('{"data":{"list":[{"name":"A"},{"name":"B"}]}}', 'https://example.test/');
  assert.equal(evalField('$.data.list[0].name', env, scope), 'A');
  assert.deepEqual(evalList('$.data.list[*]', env, scope).map((s) => evalField('name', env, s)), ['A', 'B']);
});

test('a recursive descent finds a key at any depth', () => {
  const scope = makeScope('{"a":{"b":{"c":[{"k":"deep"}]}}}', 'https://example.test/');
  assert.equal(evalField('$..c[0].k', env, scope), 'deep');
});

test('a template interpolates JSON paths into a string', () => {
  const scope = makeScope('{"volume":"第一卷","words":"1234"}', 'https://example.test/');
  assert.equal(evalField('{{$.volume}}•{{$.words}}字', env, scope), '第一卷•1234字');
});

test('an XPath reads meta tags', () => {
  const scope = makeScope(PAGE, 'https://example.test/');
  assert.equal(evalField("//meta[@property='og:novel:author']/@content", env, scope), '某作者');
});

test('an XPath reads a nested path', () => {
  const scope = makeScope(PAGE, 'https://example.test/');
  assert.equal(evalField('//div[@id="content"]/p/text()', env, scope), '第一段。');
});

test('a regex rule captures groups the next rule reads', () => {
  const scope = makeScope('data: "sS":1, "cN":"第一章", "id":42', 'https://example.test/');
  const items = evalList(':"sS":(\\d),.*?"cN":"(.*?)"', env, scope);
  assert.equal(items.length, 1);
  assert.equal(evalField('$2', env, items[0]), '第一章');
});

test('a ## rule replaces text', () => {
  const scope = makeScope('最新更新 2024年', 'https://example.test/');
  assert.equal(evalField('##最新更新 ##', env, scope), '2024年');
});

test('a ## suffix rewrites what the chain selected', () => {
  // The shape real sources use: a chain that selects, then a pattern that is REMOVED from it.
  const scope = makeScope(PAGE, 'https://example.test/');
  assert.equal(evalField('class.author.0@text##作者甲', env, scope), '');
  assert.equal(evalField('class.author.0@text##甲', env, scope), '作者');
});

test('a ## suffix with a replacement keeps the rest', () => {
  const scope = makeScope(PAGE, 'https://example.test/');
  assert.equal(evalField('class.author.0@text##作者(甲)##作者$1', env, scope), '作者甲');
});

test('operators split only at the top level', () => {
  const parts = splitOperators('a || b && c');
  assert.equal(parts.length, 3);
  assert.equal(parts[0].op, 'or');
  assert.equal(parts[1].op, 'or');
  // A `||` inside a JS block is not an operator.
  const js = splitOperators('<js>x = a || b</js>');
  assert.equal(js.length, 1);
});

test('html becomes readable text', () => {
  const text = htmlToText('<div id="c"><p>第一段。</p><p>第二段。</p><br><script>bad()</script></div>');
  assert.equal(text, '第一段。\n第二段。');
});

test('the JSON path parser handles the shapes sources use', () => {
  const data = { data: { list: [{ n: 1 }, { n: 2 }] }, other: 'x' };
  assert.equal(jsonPath('$.data.list[1].n', data), 2);
  assert.equal(jsonPath('$.other', data), 'x');
  assert.equal(jsonPath('$.data.list[*].n', data)?.length, 2);
});

/**
 * Where the book sources are looked for.
 *
 * ⚠️ The two layouts are not the same depth. From source, `novel-sources/` is a sibling of `bff/`
 * (four levels up from `bff/src/lib/novel/`). In an image the server is at `/app/dist/lib/novel`
 * and the sources were copied to `/app/novel-sources` (three levels up). Four levels up there is
 * `/`, and the reader found no novels at all — with nothing to say about it.
 *
 * Reintroduce by taking the first candidate only: in an image the sources are not found, and the
 * reader shows an empty 书库.
 */
test('the book sources are looked for where each layout puts them', () => {
  const fromSource = sourceDirCandidates('/srv/hbook/bff/src/lib/novel');
  assert.deepEqual(fromSource, ['/srv/hbook/novel-sources', '/srv/hbook/bff/novel-sources']);
  const fromImage = sourceDirCandidates('/app/dist/lib/novel');
  assert.deepEqual(fromImage, ['/novel-sources', '/app/novel-sources']);
  // And the one that wins is a directory that really exists.
  assert.ok(existsSync(sourcesDir()), `the sources directory does not exist: ${sourcesDir()}`);
});
