// What the reader typed, and what they meant by it.
//
// A search box is a title box to most engines, so "帝尊 作者：宅猪" is looked up as a title called
// "帝尊 作者：宅猪" and finds nothing -- or, worse, finds the site's fuzzy leftovers: a list of
// books with 帝尊 in the name and a different author on each.
//
// People have always written it that way, and readers still do. So the query is read for the two
// things it may name, and the search is run for the title and the author separately, and a book that
// is by the author is the answer.
//
// The separators are the ones that are actually typed: a full-width colon (：) and a half-width one
// (:), with or without a space, in Chinese or English. "作者" and "作者名" and "author" all mean the
// same thing.

export interface ParsedQuery {
  /** What to look for in the title. */
  title: string;
  /** The author the reader named, when they named one. */
  author: string | null;
}

/** The words that introduce an author. A colon is required after them: "by" alone is a word that
 *  appears in English titles ("Alone by myself"), and a query is not worth guessing about. */
const AUTHOR_WORDS = ['作者名', '作者', 'author', 'author name'];

/**
 * Read a query for a title and, maybe, an author.
 *
 * "帝尊 作者：宅猪" → { title: '帝尊', author: '宅猪' }
 * "帝尊" → { title: '帝尊', author: null }
 *
 * The author is only taken when there is something before it: "作者：宅猪" on its own is a search
 * for the author alone, with no title to narrow it, and that is a legitimate thing to want.
 */
export function parseQuery(raw: string): ParsedQuery {
  const q = (raw || '').trim();
  if (!q) return { title: '', author: null };

  for (const word of AUTHOR_WORDS) {
    // The word, then a colon, then the author.
    const re = new RegExp(`^(.*?)\\s*${escapeRe(word)}\\s*[:：]\\s*(.+)$`, 'i');
    const m = re.exec(q);
    if (!m) continue;
    const title = m[1].trim();
    const author = m[2].trim();
    if (!author) continue;
    return { title, author };
  }
  return { title: q, author: null };
}

/**
 * An author's name, stripped of the ways sites decorate it.
 *
 * "宅猪", "宅 猪", "宅猪 著", "作者：宅猪", "宅猪（作者）" are the same person, and a site picks one
 * of them at random. So the comparison is made on the bare name: the spaces gone, the "作者：" and
 * "著" gone, the brackets gone.
 */
function bareName(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/[\s　]+/g, '')
    .replace(/^[（(【\[]*(作者|作着|著)[:：]?/, '')
    .replace(/(著|作者|作着|著作者)[）)】\]]*$/, '')
    .replace(/[（()【】\[\]]/g, '');
}

/** Does this book's author look like the author the reader asked for? */
export function authorMatches(bookAuthor: string | undefined | null, want: string): boolean {
  const a = bareName(bookAuthor || '');
  const w = bareName(want);
  if (!a || !w) return false;
  // Not "are they equal": a site may list an author as "宅猪 著" next to another as "宅 猪", and a
  // reader who typed one of them means the other.
  return a.includes(w) || w.includes(a);
}

/**
 * An author's name, without the way a site decorates it.
 *
 * One site puts "作者：宅猪" in its author field and another puts "宅猪 著". The reader wants to
 * see the name, not the site's punctuation around it.
 */
export function cleanAuthor(s: string | undefined | null): string {
  return (s || '')
    .trim()
    // The brackets first: "(作者：宅猪)" is a name in brackets, and the name is inside them.
    .replace(/^[（(【\[]*/, '')
    .replace(/[）)】\]]*$/, '')
    .replace(/^(作者|作着|著)[:：]?\s*/, '')
    .replace(/\s*(著|作者|作着)$/, '')
    .trim();
}

/**
 * A title, compared without the decoration a site puts around it.
 *
 * "【帝尊】", "帝尊（完结）" and "帝尊" are the same book, and a reader who typed one of them
 * means the other.
 */
function bareTitle(s: string): string {
  return (s || '')
    .trim()
    .toLowerCase()
    .replace(/[\s　]+/g, '')
    .replace(/^[【\[（(]+/, '')
    .replace(/[（(][^）)]*[）)]$/, '')
    .replace(/[】\]）)]+$/, '');
}

/**
 * How well a title answers the word that was typed.
 *
 * 0 -- the title IS the word: "帝尊" for the word "帝尊".
 * 1 -- the title begins with it: "帝尊归来".
 * 2 -- the title carries it somewhere: "神魔帝尊".
 * 3 -- it does not carry it at all.
 *
 * The order matters more than it looks. A search for "帝尊" on a site that indexes thousands of
 * books comes back with "万古帝尊", "神魔帝尊", "都市战龙帝尊" and a dozen more -- all of them
 * carrying the word -- and the one book that is CALLED 帝尊 is buried among them. Ranking the
 * exact title first is the difference between the answer and a list of lookalikes.
 */
export function titleRank(title: string | undefined | null, needle: string): number {
  const t = bareTitle(title || '');
  const n = bareTitle(needle);
  if (!t || !n) return 3;
  if (t === n) return 0;
  if (t.startsWith(n)) return 1;
  if (t.includes(n)) return 2;
  return 3;
}

/** Does this title carry the word at all? */
export function titleHas(title: string | undefined | null, needle: string): boolean {
  return titleRank(title, needle) < 3;
}

/**
 * Put the books whose title IS the word on top.
 *
 * Four buckets: the title is the word, the title begins with it, the title carries it somewhere,
 * and the title does not carry it at all. Nothing is dropped -- the lookalikes are all still there,
 * below the answer.
 */
export function rankByTitle<T extends { title?: string | null }>(items: T[], needle: string): T[] {
  if (!needle.trim()) return items;
  const buckets: T[][] = [[], [], [], []];
  for (const item of items) buckets[titleRank(item.title, needle)].push(item);
  return [...buckets[0], ...buckets[1], ...buckets[2], ...buckets[3]];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
