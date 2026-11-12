'use client';
// A book's page: its details, and the table of contents.
//
// The book arrives from the source in one call -- details and chapters together -- because the
// source's own rules put the table of contents on the book's page, and asking for them separately
// would mean asking the site twice for the same page.
import { Suspense, useMemo, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { IcChevronLeft, IcSearch, IcLock } from '@/components/icons';
import { t as tr } from '@/lib/i18n';
import { novelBook, novelCover } from '@/lib/novels';

function BookInner() {
  const params = useSearchParams();
  const router = useRouter();
  const source = params.get('source') || '';
  const url = params.get('url') || '';
  // A source with no details page of its own shows only what its search knew, and the search result
  // is what the reader came from -- so the title travels in the URL as a fallback.
  const fallbackTitle = params.get('title') || '';
  const [filter, setFilter] = useState('');

  const { data: book, isLoading, error } = useQuery({
    queryKey: ['novel-book', source, url],
    enabled: Boolean(source && url),
    queryFn: () => novelBook(source, url),
    staleTime: 300_000,
  });

  const chapters = useMemo(() => {
    const list = book?.chapters || [];
    if (!filter.trim()) return list;
    const needle = filter.trim().toLowerCase();
    return list.filter((c) => c.title.toLowerCase().includes(needle));
  }, [book, filter]);

  if (isLoading) {
    return <div className="min-h-screen-d px-4 py-10 text-center text-sm text-fog-500">{tr('Loading…')}</div>;
  }
  if (error || !book) {
    return (
      <div className="min-h-screen-d px-4 py-10 text-center">
        <p className="text-sm text-rose-400">
          {tr('Could not open this book: {message}', { message: (error as Error)?.message || tr('not found') })}
        </p>
        <button onClick={() => router.back()} className="mt-4 text-sm text-accent">
          {tr('Back')}
        </button>
      </div>
    );
  }

  const open = (chapterUrl: string | undefined, title: string) => {
    if (!chapterUrl) return;
    router.push(
      `/novels/read?source=${encodeURIComponent(source)}&url=${encodeURIComponent(chapterUrl)}&title=${encodeURIComponent(title)}`,
    );
  };

  return (
    <div className="min-h-screen-d">
      <header className="safe-top sticky top-0 z-30 flex items-center gap-2 bg-ink-950/85 px-4 py-3 backdrop-blur-xl">
        <button onClick={() => router.back()} className="text-fog-400" aria-label={tr('Back')}>
          <IcChevronLeft width={22} height={22} />
        </button>
        <h1 className="line-clamp-1 text-sm font-medium text-fog-100">{book.title || fallbackTitle}</h1>
      </header>

      <main className="px-4 pb-24">
        <section className="flex gap-4 py-4">
          <div className="w-28 shrink-0 overflow-hidden rounded-lg bg-ink-800 sm:w-40">
            <div className="aspect-3/4">
              {book.coverUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={novelCover(book.coverUrl)} alt="" className="h-full w-full object-cover" />
              ) : null}
            </div>
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-xl font-semibold text-fog-50">{book.title || fallbackTitle}</h2>
            {book.author && <p className="mt-1 text-sm text-fog-400">{book.author}</p>}
            {book.kind && <p className="mt-1 text-xs text-fog-500">{book.kind}</p>}
            {book.wordCount && <p className="mt-1 text-xs text-fog-500">{book.wordCount}</p>}
            {book.lastChapter && (
              <p className="mt-2 text-xs text-fog-400">{tr('Latest: {title}', { title: book.lastChapter })}</p>
            )}
            {book.isNsfw && (
              <span className="mt-2 inline-block rounded bg-rose-600/90 px-2 py-0.5 text-[10px] font-medium text-white">
                18+
              </span>
            )}
          </div>
        </section>

        {book.intro && (
          <section className="mb-4 rounded-xl bg-ink-900/60 p-3 text-sm leading-relaxed text-fog-300">
            {book.intro}
          </section>
        )}

        <section>
          <div className="mb-3 flex items-center gap-2">
            <h3 className="text-sm font-medium text-fog-200">
              {tr('Table of contents ({n})', { n: book.chapters.length })}
            </h3>
            <div className="ml-auto flex items-center gap-2 rounded-lg border border-ink-600 bg-ink-850 px-2.5 py-1.5">
              <IcSearch width={14} height={14} className="text-fog-500" />
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={tr('Filter chapters')}
                className="w-28 bg-transparent text-xs text-fog-100 outline-hidden placeholder:text-fog-500"
              />
            </div>
          </div>

          {chapters.length === 0 ? (
            <p className="py-8 text-center text-sm text-fog-500">{tr('This source gave no table of contents.')}</p>
          ) : (
            <ul className="divide-y divide-ink-800 overflow-hidden rounded-xl bg-ink-900/40">
              {chapters.map((c) => (
                <li key={c.id}>
                  <button
                    onClick={() => open(c.url, c.title)}
                    className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-ink-800/60"
                  >
                    <span className="flex-1 truncate text-sm text-fog-200">{c.title}</span>
                    {c.isVip && <IcLock width={13} height={13} className="shrink-0 text-amber-400" />}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}

export default function BookPage() {
  return (
    <Suspense fallback={<div className="min-h-screen-d" />}>
      <BookInner />
    </Suspense>
  );
}
