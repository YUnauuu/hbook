// The novel side's client: the types the API answers with, and the calls that fetch them.
//
// The shapes mirror the backend's (bff/src/lib/novel/types.ts) exactly. A novel is a "series" in the
// manga app's vocabulary and a "book" here, and the reader pages treat them as their own thing --
// a chapter is text, not pages -- but the URLs, the auth and the 18+ reveal are the app's, so they
// come from the same client and the same cookie.

import { api } from './api';

/** One search result. */
export interface NovelHit {
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
  tocUrl?: string;
}

/** One chapter. */
export interface NovelChapter {
  id: string;
  source: string;
  bookId: string;
  title: string;
  index: number;
  url?: string;
  isVip?: boolean;
  updatedAt?: string;
}

/** A chapter's text. */
export interface NovelContent {
  chapterId: string;
  title?: string;
  text: string;
  nextUrl?: string;
}

/** A source the reader can search. */
export interface NovelSourceInfo {
  id: string;
  name: string;
  baseUrl: string;
  isNsfw?: boolean;
  canExplore?: boolean;
  lastCheckedAt?: string;
  status?: 'unknown' | 'ok' | 'broken';
}

export interface NovelSearchResult {
  query: string;
  hits: NovelHit[];
  errors: Array<{ source: string; error: string }>;
  truncated: boolean;
}

/** The book sources, and how many of them this account may use. */
export async function novelSources(): Promise<{ total: number; shown: number; sources: NovelSourceInfo[] }> {
  return api('/api/novels/sources');
}

/** Search across the book sources. */
export async function searchNovels(
  query: string,
  options: { source?: string; limit?: number; page?: number } = {},
): Promise<NovelSearchResult> {
  const params = new URLSearchParams({ q: query });
  if (options.source) params.set('source', options.source);
  if (options.limit) params.set('limit', String(options.limit));
  if (options.page) params.set('page', String(options.page));
  return api(`/api/novels/search?${params.toString()}`);
}

/** A book's details and its table of contents. */
export async function novelBook(source: string, url: string): Promise<NovelBook> {
  return api(`/api/novels/book?source=${encodeURIComponent(source)}&url=${encodeURIComponent(url)}`);
}

/** A chapter's text. */
export async function novelChapter(source: string, url: string): Promise<NovelContent> {
  return api(`/api/novels/chapter?source=${encodeURIComponent(source)}&url=${encodeURIComponent(url)}`);
}

/**
 * A cover image, proxied.
 *
 * The covers live on the source's own servers, which the browser cannot always reach -- and which
 * certainly should not be asked for directly from a page on another host. So they go through the
 * app's own cover route, which fetches them server-side with browser-ish headers, resizes them and
 * caches the result.
 */
export function novelCover(url: string | undefined): string {
  if (!url) return '';
  return `/img/sources/cover?u=${encodeURIComponent(url)}`;
}
