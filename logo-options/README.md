# hbook's logo

hbook's mark is a lower-case **h**, drawn in one stroke and coloured blue at the top to teal at the
bottom, on the OLED-dark square the app uses everywhere.

- `hbook-mark.svg` — **the mark**, and the source of every shipped icon.
- `make-icons.mjs` — cuts the mark into the icons the app ships.

```bash
node logo-options/make-icons.mjs      # needs sharp: cd bff && npm i
```

It writes `web/public/icons/`:

| File | Size | Where it is used |
|---|---|---|
| `favicon.png` | 32 | the browser tab |
| `apple-touch-icon.png` | 180 | the iOS home screen |
| `icon-192.png`, `icon-512.png` | 192, 512 | the web manifest (installable app) |
| `maskable-512.png` | 512 | the manifest's maskable icon: the background fills the square and the mark sits inside the safe zone, because a phone may crop the edges |
| `hbook-mark.png` | 1024 | the wordmark's mark in the nav bar |

The reader app (`reader/`) carries the same mark as an inline SVG data URI in `reader/index.html`,
so it needs no file of its own.

`previous/` holds the marks this project was forked from, kept in case a switch is ever wanted.
