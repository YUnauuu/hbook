'use client';
// The novel search: one box, searched across every book source the account may use.
//
// The sources are searched in parallel on the server and their answers are merged, so the page is a
// list of results from many sites at once -- the same shape as the manga search, with the source
// chips narrowed to the ones that actually answer for this query.
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { IcSearch, IcX, IcBook } from '@/components/icons';
import { t as tr } from '@/lib/i18n';
import { novelSources, searchNovels, novelCover, type NovelHit } from '@/lib/novels';

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function NovelsInner() {
  const params = useSearchParams();
  const router = useRouter();
  const initial = params.get('q') || '';
  const [q, setQ] = useState(initial);
  const [source, setSource] = useState<string>('');
  const debounced = useDebounced(q.trim(), 400);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!initial) inputRef.current?.focus();
  }, [initial]);

  const { data: sourceData } = useQuery({
    queryKey: ['novel-sources'],
    queryFn: novelSources,
    staleTime: 60_000,
  });

  const { data, isFetching, error } = useQuery({
    queryKey: ['novel-search', debounced, source],
    enabled: debounced.length >= 1,
    queryFn: () => searchNovels(debounced, { source: source || undefined, limit: 60 }),
    // The answer is worth keeping for a while: a book source is slow and the same title is often
    // searched for twice.
    staleTime: 120_000,
  });

  // Which sources actually answered, so the chips can say so rather than offering every source.
  const answering = useMemo(() => {
    const withHits = new Set<string>();
    for (const hit of data?.hits || []) withHits.add(hit.source);
    return withHits;
  }, [data]);

  const hits = data?.hits || [];

  return (
    <div className="min-h-screen-d">
      <header className="safe-top sticky top-0 z-30 bg-ink-950/85 px-4 pb-3 backdrop-blur-xl lg:static lg:bg-transparent lg:px-0 lg:pt-6 lg:backdrop-blur-none">
        <h1 className="mb-3 flex items-center gap-2 text-lg font-semibold text-fog-50">
          <IcBook width={20} height={20} />
          {tr('Novels')}
          <a href="/search" className="ml-auto text-xs font-normal text-fog-400 hover:text-accent">
            {tr('Manga')}
          </a>
        </h1>
        <div className="flex items-center gap-2 rounded-2xl border border-ink-600 bg-ink-850 px-3.5 py-3 focus-within:border-accent lg:max-w-xl">
          <IcSearch width={20} height={20} className="text-fog-500" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={tr('Search novels')}
            className="w-full bg-transparent text-base text-fog-50 outline-hidden placeholder:text-fog-500"
          />
          {q && (
            <button onClick={() => setQ('')} className="text-fog-500" aria-label={tr('Clear')}>
              <IcX width={18} height={18} />
            </button>
          )}
        </div>

        {sourceData && sourceData.sources.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            <button
              onClick={() => setSource('')}
              className={`rounded-full px-3 py-1 text-xs ${
                source === '' ? 'bg-accent text-ink-950' : 'bg-ink-800 text-fog-300'
              }`}
            >
              {tr('All ({n})', { n: sourceData.shown })}
            </button>
            {sourceData.sources.slice(0, 40).map((s) => (
              <button
                key={s.id}
                onClick={() => setSource(s.id === source ? '' : s.id)}
                title={s.baseUrl}
                className={`rounded-full px-3 py-1 text-xs ${
                  source === s.id ? 'bg-accent text-ink-950' : 'bg-ink-800 text-fog-300'
                } ${s.isNsfw ? 'ring-1 ring-rose-500/60' : ''}`}
              >
                {s.name}
                {answering.has(s.id) && <span className="ml-1 opacity-60">•</span>}
              </button>
            ))}
          </div>
        )}
      </header>

      <main className="px-4 pb-24 lg:px-0">
        {isFetching && hits.length === 0 && (
          <p className="py-10 text-center text-sm text-fog-500">{tr('Searching…')}</p>
        )}
        {error && (
          <p className="py-10 text-center text-sm text-rose-400">
            {tr('Search failed: {message}', { message: (error as Error).message })}
          </p>
        )}
        {!isFetching && debounced && hits.length === 0 && !error && (
          <p className="py-10 text-center text-sm text-fog-500">
            {tr('No results — try another source.')}
          </p>
        )}

        {hits.length > 0 && (
          <>
            <p className="mb-3 text-xs text-fog-500">
              {tr('{n} results', { n: hits.length })}
              {data?.truncated ? ` ${tr('(some sources timed out)')}` : ''}
            </p>
            <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
              {hits.map((hit) => (
                <NovelCard key={`${hit.source}:${hit.id}`} hit={hit} />
              ))}
            </ul>
          </>
        )}

        {data?.errors && data.errors.length > 0 && (
          <details className="mt-8 text-xs text-fog-500">
            <summary className="cursor-pointer">
              {data.errors.length === 1
                ? tr('1 source failed')
                : tr('{n} sources failed', { n: data.errors.length })}{' '}
              ({data.errors.map((e) => e.source).slice(0, 5).join(', ')}…)
            </summary>
            <ul className="mt-2 space-y-1">
              {data.errors.map((e) => (
                <li key={e.source}>
                  <span className="text-fog-400">{e.source}</span>: {e.error}
                </li>
              ))}
            </ul>
          </details>
        )}
      </main>
    </div>
  );
}

function NovelCard({ hit }: { hit: NovelHit }) {
  const router = useRouter();
  const open = () => {
    if (!hit.url) return;
    router.push(
      `/novels/book?source=${encodeURIComponent(hit.source)}&url=${encodeURIComponent(hit.url)}` +
      `&title=${encodeURIComponent(hit.title)}`,
    );
  };
  return (
    <li>
      <button onClick={open} className="group block w-full text-left">
        <div className="relative aspect-3/4 overflow-hidden rounded-lg bg-ink-800">
          {hit.coverUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={novelCover(hit.coverUrl)}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = 'none';
              }}
            />
          ) : (
            <span className="flex h-full items-center justify-center p-2 text-center text-xs text-fog-500">
              {hit.title.slice(0, 12)}
            </span>
          )}
          {hit.isNsfw && (
            <span className="absolute top-1 left-1 rounded bg-rose-600/90 px-1.5 py-0.5 text-[10px] font-medium text-white">
              18+
            </span>
          )}
        </div>
        <p className="mt-1.5 line-clamp-2 text-xs leading-snug text-fog-100 group-hover:text-accent">
          {hit.title}
        </p>
        {hit.author && <p className="mt-0.5 line-clamp-1 text-[11px] text-fog-500">{hit.author}</p>}
      </button>
    </li>
  );
}

export default function NovelsPage() {
  return (
    <Suspense fallback={<div className="min-h-screen-d" />}>
      <NovelsInner />
    </Suspense>
  );
}
