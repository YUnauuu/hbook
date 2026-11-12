# The novel side

hbook reads comics. This is the other half: novels, from the sites that publish them, read in the
browser next to the comics.

Nothing about the comic side changed. The manga sources are still the Mihon/Tachiyomi extensions the
extension engine runs, plus MangaDex, plus the sites an operator adds by address -- with the same 18+
shelf, the same age caps and the same "Show 18+" switch. This document is about what was added.

## What it is

A **book source** is a small JSON file that says how to read one site: which CSS selector holds the
title, which holds the chapter list, how to pull the text out of a chapter page. The format is the
one the Legado reader uses, so a collection that works there works here.

```
novel-sources/
  legado-verified.json   266 sources, each checked to search, open a table of contents and read a chapter
  adult.json             37 sources that carry 18+ material
  status.json            written by the probe: which sources answered, and why the others did not
```

Drop a collection in that directory and it is picked up on the next restart, or on the next
`POST /api/novels/sources/reload`.

## The rule dialect

A rule is a string. Which dialect it is written in is decided by the rule's own shape, and -- for
the rules other than the list rule -- by the stage it belongs to.

| Shape | Meaning |
|---|---|
| `class.book-mid-list@tag.li@text` | a CSS chain: the elements with that class, then `li` inside each, then their text |
| `a@href` | the link's address -- a tag named the way a person writes it |
| `img@src` | the image's source |
| `.item@tag.a@text` | a raw CSS selector as a step |
| `class.item.0` | the **first** match only; no index means "all of them" |
| `class.item.1` | the second match; a negative count takes from the end |
| `tag.a!0` | all of them **except** the first |
| `.ablum_read[0]` | the jQuery spelling of the same index |
| `class.author@tag.a@text` | a chain runs **inside every** element the previous step found |
| `text.下一页@href` | the element whose **text** is 下一页 -- the site gives that link no class to name |
| `css:td:eq(1)@text` | a raw CSS selector, with the jQuery index |
| `id.main@li!0` | `>` is a child step: `h3 > a` is the link inside the heading, not any link below it |
| `$.data.list[0].name` | a JSON path |
| `$..book_data[0]` | a JSON path with a recursive descent |
| `{{$.volume}}•{{$.words}}字` | a template: JSON paths interpolated into a string |
| `//meta[@property='og:novel:author']/@content` | an XPath |
| `:"sS":(\d),.*?"cN":"(.*?)"` | a regex over the page; `$1`/`$2` then read its groups |
| `##pattern##replacement` | replace every match of the pattern |
| `@js:result.replace(...)` | a JavaScript expression |
| `@js:url='...'; value=java.ajax(url); url+value` | a JavaScript **sequence of statements** |
| `<js> ... </js>` | a JavaScript block |
| `a \|\| b` | the first alternative that yields something |
| `a && b` | both, joined |

The rule type is decided **per stage**, not per rule. A source that says `$.data.list[*]` once for
the list and then writes `name`, `author`, `coverUrl` is writing JSON keys, not CSS selectors, and
the stage inherits its list rule's dialect.

### A step is read by what it looks like

The collections use several spellings for the same thing, and they mix them in one collection. So a
step is not read by "which dialect is this rule in" but by what the step itself looks like:

- `class.`, `id.` and `tag.` are Legado's own prefixes, and they are one spelling of a selector.
- A step that is an HTML tag name is that tag: `a@href`, `img@src`, `span.1@text`.
- A step that starts with `.`, `#` or `[`, or that contains a space or a `>`, is a raw CSS selector.
- A step that is an attribute name is that attribute: `href`, `src`, `value`, `onclick`, `data-src`.
- A name that is neither -- `a`, `img`, `span` -- is a tag; a name that is neither a tag nor a known
  attribute is read as an attribute, which is what Legado does with it. An attribute the site does
  not have comes back empty, and loses that one field rather than the whole rule.

The words that are BOTH a tag and an attribute (`title`, `content`, `style`) are read as the
attribute, because that is how these rules use them. `span` is the exception: it is an attribute on
`<col>` and a tag everywhere else, and these rules mean the tag.

## How a source is read

```
search      searchUrl  →  ruleSearch.bookList  →  one item per hit
book        the book's page  →  ruleBookInfo  →  ruleToc.chapterList  →  one item per chapter
chapter     the chapter's page  →  ruleContent.content  →  the text
```

A source with no `ruleBookInfo` rules has no details page of its own -- the title it showed in the
search is the title it knows. The search remembers what it found, and the book page falls back to it.

`searchUrl` may be a JavaScript rule rather than a template: the rule fetches the site's search page,
reads a token out of it, and builds the URL (and usually the POST body) from what it found. The
result of such a rule is a URL with the same `,{...}` options tail a template can carry, so a source
can say `method: POST`, a request body, and the character set its pages are in:

```
https://example.com/search/,{"method":"POST","body":"key={{key}}","charset":"gbk"}
```

## The JavaScript sandbox

Rules may run JavaScript. It runs in a `vm` context with no `require`, no `process` and no
filesystem -- a rule can fetch a page, read its cookies and work with the elements of the last page,
and that is all.

The hard part is that a rule's JavaScript is **synchronous**: `a = java.ajax(u)` reads its result on
the next line. Node has no synchronous HTTP. The bridge is a worker thread with a shared buffer: the
main thread writes the request into the buffer, sets a flag and blocks on `Atomics.wait`; the worker
does the fetch, writes the answer back and sets another flag. From the rule's point of view
`java.ajax(u)` is an ordinary blocking call.

The cookie jar is **shared** between a rule's own requests and the source's requests. A rule that
fetches a page to read a token out of it opens a session, and the search that follows has to carry
that session -- two jars would mean the token is fetched with one session and spent with another.

## The API

| Route | What it does |
|---|---|
| `GET /api/novels/sources` | the book sources, and how many this account may use |
| `GET /api/novels/search?q=&source=&limit=&page=` | search across the sources, concurrently |
| `GET /api/novels/book?source=&url=` | a book's details and its table of contents |
| `GET /api/novels/chapter?source=&url=` | a chapter's text |
| `POST /api/novels/sources/reload` | re-read the sources directory |
| `GET /api/novels/health` | how many sources are loaded, how many answers are cached |

## The 18+ switch

The manga side's 18+ machinery is reused, not reimplemented: an adult book source is **not searched
at all** for a caller who may not see it. Searching it and dropping its results afterwards would
still have asked the adult site for them, and an adult site's covers are exactly what the switch
exists to keep off the screen.

The switch is the same one the comics use: a session cookie (`?adult=1` on the wire), the
admin's list of adult genres and sources, and the account's age cap. The admin's list is read as
source ids, and a book source's id is its URL without the scheme -- so an adult book source is named
in the admin's settings the same way a manga source is.

## Which sources actually work

A collection of rules is not a set of working sources. Rules rot, sites change, and a source that
returns nothing is indistinguishable from one that was never wired up. So every source is actually
searched, and the result is kept:

```
node --import tsx scripts/novel-probe.ts "修仙" [maxSources]
```

It writes `novel-sources/status.json` and separates the failures, because they call for opposite
decisions:

| | Meaning |
|---|---|
| `network` | this machine could not reach the site -- the rules may be fine |
| `blocked` | the site refused us (403 and friends) |
| `dead` | the site answered with an error page or nothing |
| `rules` | the page came back with content and the rules did not match it |

### The measured rate, and why it is lower than it looks

The last full probe of the 283 loaded sources found **132 working** -- the same probe that found 27
before the dialect work. The failures are broken down into four groups, and the two largest are not
the engine's fault:

| | Count | What it means |
|---|---|---|
| working | 132 | the source searched and returned results |
| network | 30 | this machine could not reach the site at all |
| blocked | 10 | the site refused us (403 and friends) |
| dead | 13 | the site answered with an error page or nothing |
| rules | 96 | the page came back with content and the rules did not match it |

Two things make the headline number a floor rather than a measurement of the engine:

1. **The probe ran from a sandbox whose egress is filtered.** 30 of the sources could not be
   reached, and the count moved by more than twenty between two runs minutes apart. On a normal
   network those are reachable, and the number would be higher by that much.
2. **Many of the rule failures had no trace of the keyword anywhere in the HTML.** Those sites
   fetch their results with JavaScript after the page loads -- the search page arrives empty of
   results. No rule can read what is not in the HTML. Legado itself needs a WebView
   (`java.webView`) for those, which is a browser rather than a rule engine, and this side has no
   browser. **This is the one group that cannot be fixed by a better rule engine.**

The remaining rule failures do have the keyword in the page: their rules are stale (the site
changed its markup) or use a dialect feature this engine does not implement yet. Those are the ones
a better engine would recover.

### The probe's list is an order, not a wall

The probe's answer says which sources worked **from the machine the probe ran on**. The reader's
machine is a different one, and a source that could not be reached from here may answer there --
half of the "network" group above is exactly that.

So the reader's search asks the sources the probe found working **first**, and the rest after them.
It does not leave the rest out: a book that only a source this machine could not reach carries is
still a book, and a search that says "no" because of where it was run is worse than a slow one.

The cost of asking everybody is time, so the search stops early once it has an answer -- and it
counts a book whose title **is** the word as an answer. A source that answers with "神魔帝尊" and
"万古帝尊" has not answered a search for "帝尊".

### What the dialect work was worth

The "rules" bucket above was mostly **one bug**, and fixing it took the collection from a handful of
sources to most of it. Measured again, the same way, over all 283:

| | Before | After |
|---|---|---|
| the source answers a search | 27 | **132** |
| the book opens with a table of contents | 12 | **95** |
| the chapter's text comes back | 11 | **85** |

Two rules did most of that, and both were in the "obvious" part of the engine:

- **A one-step field rule reads the item it is in.** `chapterName: "text"` and `chapterUrl: "href"`
  are how most of the collections write their fields -- the item IS the element, so there is no
  selector in front of them. The engine read them as "there is no earlier step, so there is no
  element", and answered with nothing. Every such source had a working chapter list and **blank
  titles and blank addresses**: the list worked, the fields did not, and the symptom looks like a
  site that changed rather than a rule that forgot where it was.
- **A chain step is read by its shape.** The collections write `a@href` and `img@src` as readily as
  `tag.a@href`, and `.item@tag.a` as readily as `class.item@tag.a`.

The 47 sources that still do not read are the honest remainder:

| | Count | Why |
|---|---|---|
| the site changed its markup | ~40 | the rule names a class the page no longer has |
| the rule needs `org.jsoup` | 2 | Legado's JavaScript environment exposes a DOM API this sandbox does not |
| the site needs a token the rule does not fetch | ~5 | a signed API URL |

The upshot: the sources that work, work well -- a search returns full results, and a book opens with
its whole table of contents and reads chapter by chapter. The collection's size is not the
collection's reach, and the probe is what tells the two apart.

## The engine's own tests

```
node --import tsx --test test/novel-rules.test.ts
```

Twenty-eight tests, one per dialect feature, against fixtures written by hand -- so a failure names
the feature that broke rather than "a site stopped working". The live sites are probed separately,
because those are live sites whose behaviour changes.

## The bug list, for whoever works on this next

The engine was written against real sources and against the rules they carry. These were the
findings, and they are the things most likely to bite again:

- **A `<p>` closes the element it may close, not an ancestor.** Getting the "optional end tag" rules
  backwards (treating "a `<p>` is closed by a `<div>`" as "a `<p>` closes a `<div>`") made the parser
  pop the nearest matching ancestor -- so `<ul><li><p>text` closed the `<ul>` and everything inside
  it was **silently dropped**. Half the page vanished and no rule reported an error.
- **A chain runs inside every match, not just the first.** `class.item@tag.a` means "the link inside
  each item".
- **The stage's dialect wins over the rule's shape.** A bare `name` in a JSON stage is a JSON key.
- **`@js:` may be statements, not an expression.** `(a=1; b=2)` is a SyntaxError, and treating every
  `@js:` rule as an expression silently threw away a third of the JavaScript rules.
- **A chain step is read by its SHAPE, not by its prefix.** The collections write `a@href` and
  `img@src` as readily as `tag.a@href`, and they write `.item@tag.a` as readily as `class.item@tag.a`.
  Splitting the chain on every `@` and then asking "what is this?" -- a tag? a class? an attribute?
  -- is the only thing that handles all of them. Deciding in advance that "@src is an attribute"
  breaks `tag.img@src`, and deciding that "@src is a selector" breaks `img@src`.
- **A one-step rule reads the scope it is in.** `text` and `href` are written as the whole field
  rule, because the item the list rule found IS the element. A chain with no earlier step has no
  earlier element -- and the one it is in is the answer. This is the bug that cost 70-odd sources
  their chapter text.
- **`text.` is a finder, not a reader.** `text.下一页` finds the element whose text is 下一页; the
  plain `text` reads the text of what the previous step found. Two different meanings for one word.
- **A category URL is a template too.** `exploreUrl` entries carry `{{page}}`; fetching one
  literally asks the site for a page called "{{page}}", and it answers with an error page. The
  shelf showed **zero** books across every category until this was filled in.
- **A source that ignores the keyword still answers.** A site with no result for the word serves a
  page that carries a "you might like this" list in the same markup the rule reads, so the rule
  finds books that have nothing to do with the question. Nothing is dropped -- the books whose title
  contains the word are put first, and the rest stay below them.
- **Ask a hundred sites at once and they stop answering.** The verified list has a hundred and
  thirty sources in it, and asking them all simultaneously is what earns "connection reset" from the
  sites that were answering. Six at a time, with a deadline, is the difference between a search
  that takes two seconds and one that takes two minutes.
- **The cookie jar must not be fed the page.** Storing a response body as a `set-cookie` line put a
  whole HTML document into the next request's `Cookie` header, and every request after the first one
  failed with an invalid header value. The symptom was "the first request works and the second one
  does not", which is not a symptom anyone would guess at.
- **A page's character set is not always UTF-8.** The source says which it is in its URL options;
  without that, a GBK site arrives as mojibake and every rule matches nothing -- which looks exactly
  like a broken rule.
- **A rule that throws leaves the field empty**, never a partial value. A source with one broken
  field still works for the others.
- **`##` is a post-processing step, not a rule in its own right.** `id.content@html##(ad)[\s\S]+`
  reads the element and then strips the advertisement from it. Reading the whole string as a regex
  rule applies the pattern to the PAGE and throws the content away. Two parts means the pattern is
  removed; three means it is replaced; a rule that is only `##pattern##replacement` applies to the
  page itself.
- **A rule's character set is not always UTF-8.** The source says which it is in its URL options;
  without that, a GBK site arrives as mojibake and every rule matches nothing -- which looks exactly
  like a broken rule.
