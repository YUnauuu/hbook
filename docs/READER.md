# The reader app

The app in `reader/` is a **second front end** for this server: six things, no accounts.

| | |
|---|---|
| 漫画库 | the manga shelves, newest first |
| 书库 | the novel shelves, by the categories the book sources publish |
| 最新更新 | what came out today |
| 热门排行 | what everybody is reading |
| 搜索 | one box for both kinds of thing |
| 历史记录 | what you read, kept in your own browser |

It is a plain HTML/CSS/JS app -- three files, no build step -- that talks to the API in
`bff/src/routes/reader.ts`.

Two switches sit in the header:

- **18+** -- on by default here. With no account there is no age cap, so the switch is the
  request's own `adult` parameter: `adult=1` asks for the adult sources, and without it they are
  not asked at all.
- **Language** -- 中文 by default. MangaDex publishes every language on one site, so without
  saying which one, the biggest wins -- and the biggest is English. The picker sends `lang=zh`,
  `ja`, `ko`, `en` or `all`, and the server asks only the sources in that language.

The title a manga is shown under is the one in that language too. MangaDex keeps the original name
in `attributes.title` -- the romanisation for a Japanese work -- and every translated name in
`attributes.altTitles`, so the Chinese name of Berserk (烙印勇士) is in `altTitles` and nowhere
else. A Chinese adapter reading only `title` showed "Berserk" over Chinese chapters.

## Searching by title AND author

`帝尊 作者：宅猪` is how people have always written it, and a search box is a title box to every
engine: the whole string would be looked up as a title, find nothing, and offer the site's fuzzy
leftovers instead -- a list of books with 帝尊 in the name and a different author on each.

So the query is read for the two things it may name:

- the **title** is searched as a title;
- the **author** is searched as an author as well, and the books that ARE by that author come
  first. Most Chinese novel sites index their authors as well as their titles, so the second
  search finds the book the title search missed.

The author's name is compared loosely -- "宅猪", "宅 猪", "宅猪 著" and "作者：宅猪" are one person --
and the answer says what it read, so the reader can see that "帝尊 · 作者：宅猪" was understood as
two things and not as one long title.

Manga sources that know how to search by creator are asked by creator: MangaDex has the author's own
catalogue, which is a better answer than a title search guessing which of the books with that title is
the one.

## Searching by title alone

The author does not have to be typed. A search for **帝尊** puts 宅猪's 帝尊 first, because the
books are put in order by how well their title answers the word:

| | |
|---|---|
| the title **is** the word | 帝尊 |
| the title begins with it | 帝尊归来 |
| the title carries it somewhere | 神魔帝尊 |
| the title does not carry it | 万古帝尊妃 |

Before this, every title that merely carried the word ranked above the one that was called 帝尊 --
and a site that indexes thousands of books has a great many of those -- so the book the reader
wanted was on the page, and not on the screen. Nothing is dropped: the lookalikes are all still
there, below the answer.

The name shown next to a book is the name and not the site's punctuation: a site whose author field
says "作者：宅猪" shows as 宅猪.

## A manga that MangaDex knows in another language

MangaDex answers a search with the titles that have chapters **in the language asked for**. That is
right for the downloader -- a title without a chapter is a dead end -- and wrong for a reader: a
Chinese reader who types 我独自升级 wants to see that the book is there, and MangaDex holds that
name as an alternative title of a series whose chapters are in other languages.

So the reader app asks again without the language filter, and only when the ordinary search found
nothing. The downloader's own search is not changed: it still asks for the language alone.

A request whose socket is reset is asked again too. On a filtered or a busy network one request in
three comes back as ECONNRESET while the same URL answers fine a second later, and a source that
failed on a reset socket has not been asked at all.

## The Chinese manga sites

MangaDex publishes every language on one site, so its Chinese shelves are what its Chinese
translations amount to -- a few dozen titles. The rest comes from the Chinese sites themselves, and
the app ships with a list of them (`bff/manga-sites.json`): 拷贝漫画, 包子漫画, 漫画人, 漫踪,
MANGAMOL, 咚漫, 漫窝, 禁漫天堂, and thirty more.

Their engine is written as `auto`: the app reads the site's own homepage once, works out which of
the three themes it runs (Madara, Manganato, MangaThemesia), and keeps the one that answers with
books. A site whose theme has changed under it is therefore not a site that has to be re-added --
it is a site that finds itself again.

The operator's own list (`/config/sites.json`, written by Admin → Providers → Add a site) is read
**after** the bundled one, so a site in both is the operator's version.

> **A note on reachability.** The list is a list of addresses; whether a site answers depends on the
> network it is asked from. Some of them are unreachable from a filtered network, and a site that
> does not answer contributes nothing to a shelf -- it does not break the ones that do.
>
> A site that cannot be **resolved** is a site that is not there for this machine: no amount of
> asking will bring it, and the server remembers that for a while rather than trying again on every
> shelf. A site that resolves and answers with a challenge is a different case -- that one wants a
> browser, and FlareSolverr is the browser.

### Most of these sites need the Cloudflare solver

包子漫画, 禁漫天堂 and their neighbours put a **challenge** in front of their pages: a plain GET
answers with `{"error":"challenge_required"}` and no books in it. A challenge is answered by a
browser, so these sites need **FlareSolverr** running:

```bash
docker run -d --name flaresolverr -p 8191:8191 ghcr.io/flaresolverr/flaresolverr:latest
# and point the app at it
FLARESOLVERR_URL=http://127.0.0.1:8191
```

Without it, the sites that answer a plain GET still work and the ones behind a challenge do not --
which is most of the Chinese ones, and it is the difference between a shelf of two dozen books and
a shelf of thousands.

The sites that do answer a plain GET are read with the details they need: the redirects are followed
hop by hop (half of them answer `301` to their `www` name, and a fetch that refuses to follow the
redirect sees nginx's error page instead of the site), and a page that says it is written in GB2312
is read as GB2312 (read as UTF-8 it is a page of mojibake, and every parser finds nothing in it).

Both of those are the **direct fetch** -- `SOURCE_DIRECT_FETCH=1`, which the start script and the
compose file set. It is what a page is read with when the solver is not there to read it, and it is
off by default in the upstream app because it changes what a solver's failure means.

For the largest catalogue of all, the Mihon/Keiyoushi extension engine is the answer: the compose
file runs it, and its extensions cover hundreds of Chinese manga sites. The reader app uses the
engine's sources the same way it uses any other.

## The shelves are collected, not answered

A search can stop as soon as it has an answer -- the reader is waiting for one book. A shelf is the
opposite: it is supposed to be the whole of what the sources have, and stopping after the first
source that answered leaves the reader looking at one site out of thirty-seven and concluding,
wrongly, that this is all there is.

So a shelf is **collected**. The server keeps what the sources have said so far, asks the ones that
have not answered yet in the background, and says whether more is coming (`pending` in the answer).
The app asks again a moment later and the shelf has grown. It is not a slow shelf that empties and
fills: it is a shelf that starts with the sources that answer quickly and ends up with all of them.

Two things make that possible:

- **A source that does not answer is remembered.** It is not asked again for a few minutes. Asking a
  source that is not there again does not make it answer -- it costs a connection and a slot, and a
  fan-out that keeps asking thirty unreachable sites holds the connections the working ones need.
  The symptom of getting this wrong is a shelf that comes back empty while every dead site is still
  hanging on to something.
- **A source gets a budget.** Each one is given a deadline and a signal, so the socket it holds is
  closed when the time is up instead of hanging on until the end of its own timeout.

### How deep a shelf goes

A shelf asks each source for **ten pages**, not one. MangaDex answers a page with twenty-four
series and has hundreds of pages of Chinese series behind them, so one page is the front of a
library, not a library: with one page the shelf held forty-seven books, with ten it holds four
hundred.

The pages of one source are asked one after the other, in that source's own slot, and a source that
answers with an empty page -- or that fails -- is not asked for the pages after it. That is what
keeps the depth free: a site with twelve books costs one request, and a site that is not there
costs one.

The reader watches it fill: the first answer is on the screen in a few seconds, and the rest
arrives as it is collected.

### The sites that cannot be reached

A site that is not there stays not there: the same network asks it again tomorrow and gets the
same nothing. So the sources that could not be reached are **written down** and left out of the
next answer -- which is what keeps a search from spending its whole wait on thirty-six sites that
have nothing to say. The list is a file beside the operator's own site list
(`manga-dead.json`), and it survives a restart, so the search does not have to learn the lesson
again every time the server comes up.

Two rules keep that list honest:

- **A source that has answered before is never written off.** A reset socket is the network's bad
  moment, and a source that has given us four hundred books is not "unreachable". It comes back
  out of the list the moment it answers again.
- **A failure on the first page says more than a failure on the fourth.** A source that answered
  page one and then ran out of time on page four is alive and having a bad minute.

The operator can delete the file to make the server try those sites again.

### The reader's search comes first

The shelf pass and the search share the sources' rate limits -- MangaDex's, four requests a
second -- and the pass asks for hundreds of books. The search is the one the reader is waiting
for, so the pass stops taking new work while a search is running.

## Why there are two front ends

The app this project grew into is a household's library: accounts, collections, comments, trackers,
an admin panel. That is a lot of machinery for one person who wants to read. And it is worse than
that for the reader app's purpose, because **every route in it hangs off an account** -- so a
browser that has not logged in gets `401` on the search, on the shelves, on everything. The site
opens and shows nothing.

The reader app drops all of it: no user, no session, no permission. Reading history lives in the
browser's own `localStorage`, so there is nothing here to log in to and nothing here to log out of.

## What "no login" costs, stated plainly

With no account there is no age cap, no per-household access list and no server-side history.

- **The 18+ switch is per request.** `?adult=1` asks for the adult sources; without it they are not
  asked at all. The switch in the header sends the parameter on every call, so the screen and the
  server always agree about what is on.
- **The history does not follow you.** It is the browser's `localStorage`, so it stays in that
  browser. Clearing site data clears the history. It is not synced, not backed up and not visible
  to the server.
- **Anyone who can reach the server can read everything it can reach.** There is no second factor
  and no user list. This is a reader for one household on a private network -- not something to put
  on the open internet.

The upstream app, with its accounts, is still in the image and still works. See "Which front end"
below.

## Which front end

Both are in the single-container image:

| | Path | What it is |
|---|---|---|
| the reader app | `/app/reader` | six features, no accounts -- **the default** |
| the full app | `/app/web` | accounts, collections, comments, an admin |

`WEB_ROOT` chooses which one the server serves:

```yaml
# docker-compose.yml
environment:
  WEB_ROOT: ${WEB_ROOT:-/app/reader}    # the reader app
  # WEB_ROOT: /app/web                   # the full app, with accounts
```

Run it locally without Docker:

```bash
cd bff
WEB_ROOT=../reader \
NOVEL_SOURCES_PATH=../novel-sources \
DATABASE_URL=postgres://hbook:hbook@127.0.0.1:5432/hbook \
npm run dev
```

Then open <http://127.0.0.1:3000>.

The two-container (`--profile split`) layout is the upstream one: nginx serves the full app's static
export and the API sits behind it. The reader app is meant for the single container.

## The API it uses

All of it is under `/api/reader/`, and none of it needs a token:

| Route | What it does |
|---|---|
| `GET /api/reader/sources` | the manga sources and the book sources, and whether the 18+ switch is on |
| `GET /api/reader/search?kind=manga\|novel&q=&source=&limit=` | one search box, two kinds of thing |
| `GET /api/reader/manga/browse?sort=latest\|popular&page=` | the manga shelves |
| `GET /api/reader/manga/book?source=&id=` | a manga's details and its chapters |
| `GET /api/reader/manga/pages?source=&id=` | a chapter's image URLs, in order |
| `GET /api/reader/novel/explore` | the book sources' categories |
| `GET /api/reader/novel/shelf?source=&url=` | the books on one of those categories |
| `GET /api/reader/novel/book?source=&id=` | a book's details and its table of contents |
| `GET /api/reader/novel/chapter?source=&id=` | a chapter's text |
| `GET /api/reader/img?u=` | an image, fetched here rather than by the browser |

The image route is there because the sources' own servers refuse a hot-linked request from another
host, and the browser may not reach them at all. It takes the **source** as well as the URL, because
the referer is a property of the source (`https://mangadex.org/`) and not of the picture -- and
MangaDex's image CDN runs a bot challenge that answers 403 to anything claiming to be a browser: a
Chrome user-agent with no browser behind it is the shape of a scraper, so the adapter sends an
honest one instead ("hbook-manga/1 …"), and the CDN serves it. Without that, every cover was a
placeholder and every page of every chapter was blank.

## Why a search answers before every source has answered

The sources do not answer at the same speed. MangaDex paces its API at four requests a second, so
fourteen languages take seconds to answer together, and waiting for all of them makes the page feel
broken. So the answer goes out as soon as there is enough of it -- a moment after the first source
with results, or when the hard budget runs out, whichever is first. What has not answered by then is
simply not in the answer.

A source that is slow must not hold up the others, and a source that is down must not fail the
search: every source is asked on its own, and its failure is kept beside its answer.
