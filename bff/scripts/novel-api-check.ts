// Exercise the novel API against a running server, end to end.
//
//   node --import tsx scripts/novel-api-check.ts [baseUrl] [user] [password]
//
// It logs in, lists the sources, searches, opens a book and reads a chapter -- and reports what
// worked. It is the check that says whether the novel side is actually usable, rather than whether
// it compiles.

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
  console.log(`\n=== novel API check against ${base} ===\n`);

  const login = await call('/auth/login', { method: 'POST', body: JSON.stringify({ username: user, password }) });
  if (login.status !== 200 || !login.body?.accessToken) {
    console.error(`login failed (${login.status}):`, login.body);
    process.exit(1);
  }
  token = login.body.accessToken;
  line('login', `ok as ${login.body.user?.username} (${login.body.user?.role})`);

  // --- the sources, and the 18+ switch ---
  const plain = await call('/api/novels/sources');
  const adult = await call('/api/novels/sources?adult=1');
  if (plain.status !== 200) {
    console.error('sources failed:', plain.status, plain.body);
    process.exit(1);
  }
  line('sources total', plain.body.total);
  line('sources shown (18+ hidden)', plain.body.shown);
  line('sources shown (18+ revealed)', adult.body.shown);
  line('adult sources among them', adult.body.sources.filter((s: any) => s.isNsfw).length);
  line('sample', plain.body.sources.slice(0, 4).map((s: any) => s.name).join(' | '));

  // --- a search ---
  const search = await call('/api/novels/search?q=' + encodeURIComponent('修仙') + '&limit=20');
  if (search.status !== 200) {
    console.error('search failed:', search.status, search.body);
    process.exit(1);
  }
  line('search hits', search.body.hits?.length);
  line('search errors', search.body.errors?.length);
  line('search truncated', search.body.truncated);
  for (const hit of (search.body.hits || []).slice(0, 5)) {
    console.log(`   - ${hit.title}  [${hit.source}]${hit.author ? ' by ' + hit.author : ''}`);
  }

  if (!search.body.hits?.length) {
    console.log('\nno hits: nothing further to check.');
    return;
  }

  // --- a book ---
  const hit = search.body.hits.find((h: any) => h.url) || search.body.hits[0];
  const book = await call(`/api/novels/book?source=${encodeURIComponent(hit.source)}&url=${encodeURIComponent(hit.url || '')}`);
  if (book.status !== 200) {
    console.log(`\nbook failed (${book.status}):`, book.body?.error || book.body?.message);
    return;
  }
  line('book title', book.body.title);
  line('book author', book.body.author);
  line('book chapters', book.body.chapters?.length);
  line('first chapter', book.body.chapters?.[0]?.title);

  // --- a chapter ---
  const chapter = book.body.chapters?.find((c: any) => c.url);
  if (!chapter) {
    console.log('\nno chapter with a URL: the table of contents is not usable.');
    return;
  }
  const text = await call(`/api/novels/chapter?source=${encodeURIComponent(book.body.source)}&url=${encodeURIComponent(chapter.url)}`);
  if (text.status !== 200) {
    console.log(`\nchapter failed (${text.status}):`, text.body?.error || text.body?.message);
    return;
  }
  const body = text.body.text || '';
  line('chapter title', text.body.title);
  line('chapter chars', body.length);
  line('chapter first line', body.split('\n')[0]?.slice(0, 60));
  line('chapter paragraphs', body.split(/\n+/).filter((p: string) => p.trim()).length);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
