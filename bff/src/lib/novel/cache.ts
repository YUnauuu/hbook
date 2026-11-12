// A small in-memory cache with a time to live.
//
// The novel side fetches the same pages over and over: a book's details when its page is opened, its
// chapter list every time the reader goes back to the table of contents, a chapter's text every time
// the reader scrolls back up. The sites are slow and the rules are cheap, so caching the ANSWER --
// not the rules -- is what makes the app feel like an app.
//
// Two rules keep this honest:
//   - a cached value is never served past its TTL, because these pages change,
//   - a failed lookup is not cached at all, so a source that was down a minute ago is retried now.

export class TtlCache<T> {
  private readonly entries = new Map<string, { value: T; at: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 500,
  ) {}

  get(key: string): T | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: T): void {
    if (this.entries.size >= this.maxEntries) {
      // Drop the oldest entry. The map preserves insertion order, so the first key is the oldest.
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, { value, at: Date.now() });
  }

  /** The cached value, or the value a loader produces -- which is then cached. */
  async through(key: string, loader: () => Promise<T>): Promise<T> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const value = await loader();
    this.set(key, value);
    return value;
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
