// The shapes the novel side of the app speaks.
//
// They mirror the manga side's `SourceSeries` / `SourceChapter` (bff/src/lib/sources/types.ts)
// closely enough that the front end can treat "a comic" and "a novel" as two kinds of the same
// thing, and differently enough that a novel can carry the things a comic cannot: a chapter's text
// rather than its pages, and a table of contents that is a list of chapters rather than a list of
// downloaded files.

/** One search result. */
export interface NovelHit {
  /** The source's id for the book -- its URL inside the source's own catalogue. */
  id: string;
  /** The source's id (see the source registry). */
  source: string;
  title: string;
  author?: string;
  intro?: string;
  kind?: string;
  lastChapter?: string;
  coverUrl?: string;
  /** The book's page on the site. */
  url?: string;
  wordCount?: string;
  /** True when the source says the book is adult. */
  isNsfw?: boolean;
}

/** A book, with its chapters. */
export interface NovelBook {
  id: string;
  source: string;
  title: string;
  author?: string;
  intro?: string;
  kind?: string;
  lastChapter?: string;
  coverUrl?: string;
  url?: string;
  wordCount?: string;
  isNsfw?: boolean;
  chapters: NovelChapter[];
  /** Where the table of contents was found, for a second attempt at a partial page. */
  tocUrl?: string;
}

/** One chapter. */
export interface NovelChapter {
  /** The source's id for the chapter -- its URL inside the source's own catalogue. */
  id: string;
  source: string;
  /** The book this chapter belongs to. */
  bookId: string;
  title: string;
  /** The chapter's order in the table of contents. */
  index: number;
  url?: string;
  /** True when the source marks the chapter as paid/locked. */
  isVip?: boolean;
  /** The release date, when the source gives one. */
  updatedAt?: string;
}

/** A chapter's text. */
export interface NovelContent {
  chapterId: string;
  title?: string;
  /** The body, as text with paragraphs separated by blank lines. */
  text: string;
  /** The next chapter's URL, when the source says what follows. */
  nextUrl?: string;
}

/** A source the reader can search. */
export interface NovelSourceInfo {
  id: string;
  name: string;
  /** The site's address. */
  baseUrl: string;
  /** True when the source is adult. */
  isNsfw?: boolean;
  /** Whether the source can browse (it publishes an explore list). */
  canExplore?: boolean;
  /** The source's language, when it says. */
  lang?: string;
  /** When the source was last checked and what happened. */
  lastCheckedAt?: string;
  status?: 'unknown' | 'ok' | 'broken';
}
