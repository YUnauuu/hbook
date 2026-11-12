'use client';
// The novel reader.
//
// A chapter is text, so this is a page of text: a measure that is comfortable to read, a size the
// reader chooses, and a theme that follows the app's own. The controls are remembered per browser,
// because a reader who has set the text to 20px does not want to do it again on every chapter.
//
// The next and previous chapters come from the book's own table of contents, which the reader loads
// once per book: the source's `nextContentUrl` only ever says what comes NEXT, so going back needs
// the list.
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { IcChevronLeft, IcChevronRight, IcSettings, IcLock } from '@/components/icons';
import { t as tr } from '@/lib/i18n';
import { novelBook, novelChapter } from '@/lib/novels';

const SIZE_KEY = 'hbook_novel_size';
const THEME_KEY = 'hbook_novel_theme';
const PROGRESS_KEY = 'hbook_novel_progress';

const SIZES = [15, 17, 19, 21, 24, 28];
const THEMES = ['ink', 'paper', 'sepia'] as const;
type Theme = (typeof THEMES)[number];

const THEME_CLASS: Record<Theme, string> = {
  ink: 'bg-ink-950 text-fog-100',
  paper: 'bg-[#f6f2e8] text-[#26221c]',
  sepia: 'bg-[#f2e6d0] text-[#3a2f21]',
};

function ReaderInner() {
  const params = useSearchParams();
  const router = useRouter();
  const source = params.get('source') || '';
  const url = params.get('url') || '';
  const title = params.get('title') || '';
  const bookUrl = params.get('book') || '';

  const [size, setSize] = useState(19);
  const [theme, setTheme] = useState<Theme>('ink');
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    try {
      const s = Number(localStorage.getItem(SIZE_KEY));
      if (s >= 12 && s <= 40) setSize(s);
      const t = localStorage.getItem(THEME_KEY) as Theme | null;
      if (t && THEMES.includes(t)) setTheme(t);
    } catch {
      /* a browser that will not say what it remembers */
    }
  }, []);

  const { data: content, isLoading, error } = useQuery({
    queryKey: ['novel-chapter', source, url],
    enabled: Boolean(source && url),
    queryFn: () => novelChapter(source, url),
    staleTime: 10 * 60_000,
  });

  // The table of contents, for the previous chapter and for the chapter list.
  const { data: book } = useQuery({
    queryKey: ['novel-book', source, bookUrl],
    enabled: Boolean(source && bookUrl),
    queryFn: () => novelBook(source, bookUrl),
    staleTime: 300_000,
  });

  const position = useMemo(() => {
    if (!book || !url) return null;
    const i = book.chapters.findIndex((c) => c.url === url);
    if (i === -1) return null;
    return {
      index: i,
      total: book.chapters.length,
      previous: book.chapters[i - 1]?.url,
      next: book.chapters[i + 1]?.url,
      previousTitle: book.chapters[i - 1]?.title,
      nextTitle: book.chapters[i + 1]?.title,
    };
  }, [book, url]);

  // Where the reader stopped, so the next visit can offer to continue.
  useEffect(() => {
    if (!url) return;
    try {
      const raw = JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}');
      raw[source] = { url, title, bookUrl, at: Date.now() };
      localStorage.setItem(PROGRESS_KEY, JSON.stringify(raw));
    } catch {
      /* private mode */
    }
  }, [source, url, title, bookUrl]);

  const go = (nextUrl: string | undefined, nextTitle: string | undefined) => {
    if (!nextUrl) return;
    router.push(
      `/novels/read?source=${encodeURIComponent(source)}&url=${encodeURIComponent(nextUrl)}` +
      `&title=${encodeURIComponent(nextTitle || '')}&book=${encodeURIComponent(bookUrl)}`,
    );
    if (typeof window !== 'undefined') window.scrollTo({ top: 0 });
  };

  const changeSize = (next: number) => {
    setSize(next);
    try { localStorage.setItem(SIZE_KEY, String(next)); } catch { /* ignore */ }
  };

  const changeTheme = (next: Theme) => {
    setTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch { /* ignore */ }
  };

  const paragraphs = (content?.text || '').split(/\n{1,}/).filter((p) => p.trim().length > 0);

  return (
    <div className={`min-h-screen-d ${THEME_CLASS[theme]}`}>
      <header className="safe-top sticky top-0 z-30 flex items-center gap-2 border-b border-black/10 px-4 py-2.5 backdrop-blur-xl">
        <button onClick={() => router.back()} className="opacity-70" aria-label={tr('Back')}>
          <IcChevronLeft width={22} height={22} />
        </button>
        <div className="min-w-0 flex-1">
          <p className="line-clamp-1 text-xs opacity-60">{book?.title || tr('Novels')}</p>
          <p className="line-clamp-1 text-sm font-medium">{content?.title || title}</p>
        </div>
        {position && (
          <span className="shrink-0 text-xs opacity-50">
            {position.index + 1}/{position.total}
          </span>
        )}
        <button onClick={() => setShowSettings((v) => !v)} className="opacity-70" aria-label={tr('Settings')}>
          <IcSettings width={19} height={19} />
        </button>
      </header>

      {showSettings && (
        <div className="sticky top-13 z-20 flex flex-wrap items-center gap-3 border-b border-black/10 px-4 py-2.5 text-sm">
          <div className="flex items-center gap-1">
            {SIZES.map((s) => (
              <button
                key={s}
                onClick={() => changeSize(s)}
                className={`rounded px-2 py-1 text-xs ${s === size ? 'bg-accent text-ink-950' : 'opacity-60'}`}
              >
                {s}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            {THEMES.map((t) => (
              <button
                key={t}
                onClick={() => changeTheme(t)}
                className={`rounded px-2 py-1 text-xs ${t === theme ? 'bg-accent text-ink-950' : 'opacity-60'}`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
      )}

      <main className="mx-auto max-w-2xl px-5 py-8">
        {isLoading && <p className="py-10 text-center text-sm opacity-60">{tr('Loading…')}</p>}
        {error && (
          <p className="py-10 text-center text-sm text-rose-400">
            {tr('Could not load the chapter: {message}', { message: (error as Error).message })}
          </p>
        )}
        {content && paragraphs.length === 0 && (
          <p className="py-10 text-center text-sm opacity-60">{tr('This chapter has no content.')}</p>
        )}

        {paragraphs.map((p, i) => (
          <p
            key={i}
            style={{ fontSize: `${size}px`, lineHeight: 1.9 }}
            className="mb-4 indent-8 tracking-[0.01em] whitespace-pre-wrap"
          >
            {p}
          </p>
        ))}

        {content?.nextUrl && !position?.next && (
          <button
            onClick={() => go(content.nextUrl, undefined)}
            className="mt-6 w-full rounded-xl border border-black/15 py-3 text-sm opacity-80"
          >
            {tr('Next page')} →
          </button>
        )}

        {position && (
          <nav className="mt-10 flex items-center gap-3 border-t border-black/10 pt-5 text-sm">
            <button
              onClick={() => go(position.previous, position.previousTitle)}
              disabled={!position.previous}
              className="flex min-w-0 flex-1 items-center gap-1 rounded-lg border border-black/15 px-3 py-2.5 disabled:opacity-30"
            >
              <IcChevronLeft width={16} height={16} />
              <span className="truncate">{position.previousTitle || tr('Previous chapter')}</span>
            </button>
            <button
              onClick={() => go(position.next, position.nextTitle)}
              disabled={!position.next}
              className="flex min-w-0 flex-1 items-center justify-end gap-1 rounded-lg border border-black/15 px-3 py-2.5 disabled:opacity-30"
            >
              <span className="truncate">{position.nextTitle || tr('Next chapter')}</span>
              <IcChevronRight width={16} height={16} />
            </button>
          </nav>
        )}
      </main>
    </div>
  );
}

export default function ReaderPage() {
  return (
    <Suspense fallback={<div className="min-h-screen-d" />}>
      <ReaderInner />
    </Suspense>
  );
}
