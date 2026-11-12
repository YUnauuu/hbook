// A site whose engine is not known yet.
//
// The three generic engines read three different families of WordPress/PHP manga themes, and the
// sites that use them are constantly re-skinning: the same site changes its markup, a mirror is a
// different build, and a new clone of a clone runs something nobody has seen before. An operator
// adding such a site by address has three choices -- guess the engine and be wrong, read the page
// and work out the family by hand, or let the app try them.
//
// This is the third one. The site's own homepage is read ONCE, the engine is worked out from it,
// and that engine is used from then on.
//
// The homepage is read first on purpose. A site that does not answer costs one timed-out request,
// not three: asking three engines at a site that is not there means three connections held open for
// the length of the timeout, and a dozen dead sites can hold the good ones' connections hostage -- the
// symptom being a source that works on its own and fails right after the fan-out has been round.
//
// The engine that worked is remembered for the life of the process, so the second search does not
// read the homepage again.
import type { SourceAdapter, SourceChapter, SourceSeries } from '../types';
import { makeMadara } from './madara';
import { makeManganato } from './manganato';
import { makeMangaThemesia } from './mangathemesia';
import { engineOf } from '../detect';
import { fetchPublicHop } from '../../publicConnection';
import { currentStopSignal, deadlineRemaining } from '../flaresolverr';

export type AutoEngine = 'madara' | 'manganato' | 'mangathemesia';

/** The engines, in the order they are tried. Madara first: it is the most common by a wide margin. */
const MAKERS: Record<AutoEngine, (cfg: { id: string; name: string; base: string; order?: number; lang?: string }) => SourceAdapter> = {
  madara: makeMadara,
  manganato: makeManganato,
  mangathemesia: makeMangaThemesia,
};

const ORDER: AutoEngine[] = ['madara', 'manganato', 'mangathemesia'];

/**
 * A site that is asked at address, with the engine worked out by reading it.
 *
 * `cfg` is the same shape the admin's Add-a-site form produces.
 */
export function makeAutoSite(cfg: { id: string; name: string; base: string; order?: number; lang?: string }): SourceAdapter {
  const base = cfg.base.replace(/\/$/, '');
  const built = new Map<AutoEngine, SourceAdapter>();
  /** The engine that answered, once one has. */
  let winner: SourceAdapter | null = null;
  /** The engine the homepage said, once it has said. */
  let guessed: AutoEngine | null = null;
  /** Whether the homepage has been read yet. */
  let read = false;

  const forEngine = (engine: AutoEngine): SourceAdapter => {
    let a = built.get(engine);
    if (!a) {
      a = MAKERS[engine](cfg);
      built.set(engine, a);
    }
    return a;
  };

  /** Read the homepage and work out which family of theme the site runs. */
  const detect = async (): Promise<AutoEngine | null> => {
    if (read) return guessed;
    read = true;
    try {
      // The homepage is a bonus read -- it works out which of the three themes the site runs -- so
      // it must not cost more than the page we are actually after, and it must not outlive the
      // caller's deadline: a site that is down holds its socket for the whole timeout, and thirty
      // of them hold the connections a working site needs.
      const budget = Math.min(8000, deadlineRemaining());
      if (!(budget > 0)) return null;
      const own = AbortSignal.timeout(budget);
      const stop = currentStopSignal();
      const r = await fetchPublicHop(new URL(base + '/'), {
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          accept: 'text/html,application/xhtml+xml',
          'accept-language': 'zh-CN,zh;q=0.9',
        },
        signal: stop ? AbortSignal.any([own, stop]) : own,
      });
      if (!r.ok) return null;
      const html = await r.text();
      const which = engineOf(html);
      if (which === 'madara' || which === 'manganato' || which === 'mangathemesia') {
        guessed = which;
        return which;
      }
      return null;
    } catch {
      return null;
    }
  };

  /**
   * Ask the engine that works, or try them until one answers with books.
   *
   * An engine that throws is skipped: a Madara site asked as Manganato throws ("the search answered
   * with a page that is not a listing"), which is exactly the answer we want from a wrong guess.
   */
  const ask = async <T>(run: (a: SourceAdapter) => Promise<T>): Promise<T> => {
    if (winner) return run(winner);
    // The site's own word about itself first: one request, and the answer is right.
    const said = await detect();
    const order = said ? [said, ...ORDER.filter((e) => e !== said)] : ORDER;
    let last: unknown;
    for (const engine of order) {
      try {
        const value = await run(forEngine(engine));
        // A method that answers with nothing has not proved it is the right engine: a Madara site's
        // search for a word it has never heard of answers with an empty listing, and so does a
        // Manganato site's. Only a real answer settles it.
        if (Array.isArray(value) && value.length === 0) { last = value; continue; }
        winner = forEngine(engine);
        return value;
      } catch (err) {
        last = err;
      }
    }
    if (last instanceof Error) throw last;
    return last as T;
  };

  /**
   * The same, for a LISTING: the site's newest books or its most-read ones.
   *
   * A listing is answered with a list, so an engine that answers with an empty one has proved
   * nothing: a Madara site's newest list is never empty, but a Manganato site's answer to a
   * Madara URL is. So the engines are tried until one answers with books, and the one that did
   * becomes the site's engine.
   */
  const askListing = async (what: 'latest' | 'popular', page: number): Promise<SourceSeries[]> => {
    if (winner) {
      try {
        const value = await winner[what]!(page);
        if (value.length) return value;
      } catch { /* the engine that worked for the search does not work for the listing */ }
    }
    const said = await detect();
    const order = said ? [said, ...ORDER.filter((e) => e !== said)] : ORDER;
    let last: unknown;
    for (const engine of order) {
      try {
        const value = await forEngine(engine)[what]!(page);
        if (value.length) { winner = forEngine(engine); return value; }
        last = value;
      } catch (err) {
        last = err;
      }
    }
    if (last instanceof Error) throw last;
    return (last as SourceSeries[]) ?? [];
  };

  return {
    id: cfg.id,
    name: cfg.name,
    ...(cfg.lang ? { lang: cfg.lang } : {}),
    base,
    preferredOrder: cfg.order,
    imageReferer: `${base}/`,

    async search(query: string): Promise<SourceSeries[]> {
      return ask((a) => a.search(query));
    },
    /**
     * The site's own newest books.
     *
     * Without this the site is a search box and nothing else: it can answer "do you have 帝尊?" but
     * it cannot put a shelf on the page, and the shelves are half of what a reader opens the app
     * for. All three engines have a listing of their own, so the one that was worked out is asked.
     */
    async latest(page = 1): Promise<SourceSeries[]> {
      return askListing('latest', page);
    },
    /** The site's own most-read books: the same listing under another sort key. */
    async popular(page = 1): Promise<SourceSeries[]> {
      return askListing('popular', page);
    },
    async getSeries(id: string): Promise<SourceSeries | null> {
      return ask((a) => a.getSeries(id));
    },
    async listChapters(seriesId: string): Promise<SourceChapter[]> {
      return ask((a) => a.listChapters(seriesId));
    },
    async getPageUrls(chapterId: string): Promise<string[]> {
      return ask((a) => a.getPageUrls(chapterId));
    },
  };
}
