// What the reader typed, and what it meant.
//
// "帝尊 作者：宅猪" is how people have always written it, and a search box is a title box to every
// engine: the whole string would be looked up as a title, find nothing, and offer the site's fuzzy
// leftovers instead -- a list of books with 帝尊 in the name and a different author on each.
//
// So the query is read for the two things it may name.
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseQuery, authorMatches, cleanAuthor, rankByTitle, titleRank } from '../src/lib/readerQuery';

test('a plain query is a title', () => {
  assert.deepEqual(parseQuery('帝尊'), { title: '帝尊', author: null });
  assert.deepEqual(parseQuery('  海贼王  '), { title: '海贼王', author: null });
});

test('an author is read out of the query', () => {
  assert.deepEqual(parseQuery('帝尊 作者：宅猪'), { title: '帝尊', author: '宅猪' });
  assert.deepEqual(parseQuery('帝尊作者：宅猪'), { title: '帝尊', author: '宅猪' });
  assert.deepEqual(parseQuery('帝尊 作者: 宅猪'), { title: '帝尊', author: '宅猪' });
  assert.deepEqual(parseQuery('帝尊 author：宅猪'), { title: '帝尊', author: '宅猪' });
  assert.deepEqual(parseQuery('帝尊 作者名：宅猪'), { title: '帝尊', author: '宅猪' });
});

test('an author on its own is a search for the author', () => {
  assert.deepEqual(parseQuery('作者：宅猪'), { title: '', author: '宅猪' });
});

test('a colon that is not an author is left in the title', () => {
  // "by" without a colon is a word that appears in English titles, so it is not read as an author.
  assert.deepEqual(parseQuery('Alone by myself'), { title: 'Alone by myself', author: null });
  // "咒术回战：死灭行" is a title with a colon in it.
  assert.deepEqual(parseQuery('咒术回战：死灭行'), { title: '咒术回战：死灭行', author: null });
  assert.deepEqual(parseQuery('时间为证'), { title: '时间为证', author: null });
});

test('an author is matched loosely, because sites spell it loosely', () => {
  assert.equal(authorMatches('宅猪', '宅猪'), true);
  assert.equal(authorMatches('宅 猪', '宅猪'), true);
  assert.equal(authorMatches('宅猪 著', '宅猪'), true);
  assert.equal(authorMatches('作者：宅猪', '宅猪'), true);
  assert.equal(authorMatches('宅猪', '作者：宅猪'), true);
  assert.equal(authorMatches('扶水刃心', '宅猪'), false);
  assert.equal(authorMatches('', '宅猪'), false);
  assert.equal(authorMatches(undefined, '宅猪'), false);
});

test('the name the reader sees is the name, without the site\'s punctuation', () => {
  assert.equal(cleanAuthor('作者：宅猪'), '宅猪');
  assert.equal(cleanAuthor('宅猪 著'), '宅猪');
  assert.equal(cleanAuthor('宅猪'), '宅猪');
  assert.equal(cleanAuthor('（作者：宅猪）'), '宅猪');
  assert.equal(cleanAuthor(''), '');
  assert.equal(cleanAuthor(undefined), '');
});

test('a title that IS the word beats a title that carries it', () => {
  // The whole reason the search was missing the book: a site indexes thousands of books with 帝尊
  // in the name, and the one that is CALLED 帝尊 was at the bottom of the list.
  assert.equal(titleRank('帝尊', '帝尊'), 0);
  assert.equal(titleRank('【帝尊】', '帝尊'), 0);
  assert.equal(titleRank('帝尊（宅猪）', '帝尊'), 0);
  assert.equal(titleRank('帝尊归来', '帝尊'), 1);
  assert.equal(titleRank('神魔帝尊', '帝尊'), 2);
  assert.equal(titleRank('都市战龙帝尊', '帝尊'), 2);
  assert.equal(titleRank('海贼王', '帝尊'), 3);
  assert.equal(titleRank('', '帝尊'), 3);
  assert.equal(titleRank(undefined, '帝尊'), 3);
});

test('the books are put in order, and none of them is dropped', () => {
  const books = [
    { title: '神魔帝尊' },
    { title: '海贼王' },
    { title: '帝尊' },
    { title: '帝尊归来' },
  ];
  assert.deepEqual(rankByTitle(books, '帝尊').map((b) => b.title), ['帝尊', '帝尊归来', '神魔帝尊', '海贼王']);
  // The word in a different case, and with spaces around it, is the same word.
  assert.deepEqual(rankByTitle([{ title: 'DIZUN' }], 'dizun').map((b) => b.title), ['DIZUN']);
  // Nothing is lost when the word is empty.
  assert.equal(rankByTitle(books, '  ').length, 4);
});
