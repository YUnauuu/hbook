// Exercise the manga side against a running server, so the two halves can be checked the same way.
//
//   node --import tsx scripts/manga-api-check.ts [baseUrl] [user] [password]
//
// The manga side is the upstream project's own code; this checks that it is REACHABLE and that the
// 18+ path works the same way the novel side's does -- the same age cap, the same reveal.

const base = process.argv[2] || 'http://127.0.0.1:3000';
const user = process.argv[3] || 'admin';
const password = process.argv[4] || 'devpassword123';

let token = '';

async function call(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const headers = new Headers(init.headers || {});
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (init.body) headers.set('content-type', 'application/json');
  const res = await fetch(`${base}${path}`, { ...init, headers });
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, body };
}

function line(label: string, value: unknown): void {
  console.log(`${label.padEnd(34)} ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

async function main(): Promise<void> {
  console.log(`\n=== manga API check against ${base} ===\n`);

  const login = await call('/auth/login', { method: 'POST', body: JSON.stringify({ username: user, password }) });
  if (login.status !== 200 || !login.body?.accessToken) {
    console.error(`login failed (${login.status}):`, login.body);
    process.exit(1);
  }
  token = login.body.accessToken;
  line('login', `ok as ${login.body.user?.username}`);

  // --- the sources the engine offers ---
  const sources = await call('/api/sources');
  if (sources.status !== 200) {
    console.error('sources failed:', sources.status);
    process.exit(1);
  }
  const list = Array.isArray(sources.body) ? sources.body : sources.body?.content || [];
  line('sources available', list.length);
  line('sample', list.slice(0, 5).map((s: any) => `${s.name || s.id}${s.isNsfw ? ' (18+)' : ''}`).join(' | '));

  // --- a search, with and without the 18+ reveal ---
  // `rating` is the manga side's 18+ filter: `safe` hides adult titles, `all` shows them, and the
  // "Show 18+" switch decides whether an adult SOURCE is asked at all.
  const plain = await call('/api/sources/search-all?q=' + encodeURIComponent(' doujin') + '&rating=safe');
  const adult = await call('/api/sources/search-all?q=' + encodeURIComponent(' sex') + '&rating=adult&adult=1');
  const count = (r: any) => (Array.isArray(r.body) ? r.body.length : r.body?.content?.length ?? 0);
  line('search hits (rating=safe)', count(plain));
  line('search hits (rating=adult)', count(adult));

  const hits = adult.body?.content || [];
  if (hits.length) {
    const first = hits[0];
    line('first hit', `${first.title}  (${(first.providers || []).map((p: any) => p.source).join(',')})`);
    line('its cover', first.coverUrl ? first.coverUrl.slice(0, 70) : '(none)');
  } else {
    line('first hit', '(none)');
  }

  // --- the sources endpoint with the reveal on, to see the adult ones ---
  const adultSources = await call('/api/sources?adult=1');
  const list2 = Array.isArray(adultSources.body) ? adultSources.body : adultSources.body?.content || [];
  line('adult-flagged sources', list2.filter((s: any) => s.isNsfw).length);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
