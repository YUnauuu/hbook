# Installing hbook

> 🌐 The same install as a guided walk-through, with the compose file explained line by line: [hbook.com/manga-server](https://hbook.com/manga-server).

The two-command quick start lives in the [README](../README.md). This page is everything else: the one-click
app stores, what each container is for, keeping it up to date, and putting it behind a domain.

> 💻 **Want it on your own Windows PC or Mac instead of a server?** That is **hbook Desktop (beta)**: an
> installer, no Docker. It also works the other way round: installed on a PC or Mac, it can **connect to the
> server** you set up here and show it in its own window. Everything about it — downloads, the first launch,
> both modes — is in **[the desktop guide](DESKTOP.md)**. The rest of this page is about the server.

## Other layouts

<details>
<summary>Prefer to run Postgres yourself?</summary>

Set `DATABASE_URL` on the app container and the same image talks to your database instead of starting its
own; that one variable is the whole switch (it is documented under *Database* in
[docs/CONFIGURATION.md](CONFIGURATION.md#environment-variables), and **Admin → Overview** says which one is in
use). [`deploy/docker-compose.external-db.yml`](../deploy/docker-compose.external-db.yml) is
that layout ready to use, with a Postgres container beside the app -- it is what the install instructions
used before v0.18.0, and an existing install keeps working on it unchanged. Moving between the two is a
dump and a restore, written down in both directions in **[docs/MIGRATING.md](MIGRATING.md)**.
</details>

<details>
<summary>Already running the older two-container layout?</summary>

hbook used to ship as `hbook-bff` + `hbook-web`, with a separate nginx serving the web app. That
layout is **deprecated but not dead**: it is still built, still published and still works, and nothing about
your install has stopped functioning. You are not required to move.

It is deprecated because the single container measured better on the same host — **275 MB on disk instead
of 409 MB** for the pair (98 MB to pull instead of 161 MB, measured at v0.40.0), less memory, one less
network hop on every API call, and no redirect on deep links — and because
the end-to-end tests only ever drive the single container, so it is the layout that is actually proven on
every commit.

Moving to the external-database layout is a compose swap, not a data migration: both use the **same named
volumes** and the same Postgres image. Four commands, in **[docs/MIGRATING.md](MIGRATING.md)**. The
file itself is still there as [`deploy/docker-compose.split.yml`](../deploy/docker-compose.split.yml).
</details>

## File ownership

To read a library you already have, point `LIBRARY_PATH` at it. By default hbook runs as its own user and
**cannot write to your files at all**; set `PUID`/`PGID` to your own ids (`id -u`, `id -g`) if you want it to
be able to rename folders and delete chapters:

```bash
echo "LIBRARY_PATH=/path/to/your/manga" > .env
docker compose up -d
```

## Volumes

hbook reads manga from two folders, and scans both:

| In the container | What it holds | In the shipped compose file |
|---|---|---|
| `/library` | the manga you already have | `${LIBRARY_PATH:-./library}:/library` |
| `/library-dl` | the chapters hbook downloads | the `hbook_downloads` volume |

Keep them **side by side**, each in a folder of its own: never the downloads folder inside the folder you mount
at `/library`, nor the other way round. With `LIBRARY_PATH=/data/manga` and the downloads mounted from
`/data/manga/hbook`, every downloaded chapter is scanned twice, once in a series with its source and once in a
series with none, and **Admin → Health** says so under *Folders scanned twice*. Mount the downloads from a folder
beside your manga instead:

```yaml
    volumes:
      - /data/manga:/library                 # the manga you already have
      - /data/hbook-downloads:/library-dl # what hbook downloads: NOT inside /data/manga
```

Move the downloaded chapters across, restart (`docker compose up -d`), and remove the copies that have no source.
The desktop app chooses its two folders itself, and will not start with one inside the other.

## One-click installs

**On CasaOS?** Use [`deploy/casaos/docker-compose.yml`](../deploy/casaos/docker-compose.yml) instead — import
it as a custom app and it appears with an icon like any store app. Two differences from the file above: it
runs Postgres as its own `hbook-db` container rather than inside the app, and it leaves out the extension
engine. For Mihon/Tachiyomi extensions, import the add-on
[`deploy/casaos/hbook-suwayomi.yml`](../deploy/casaos/hbook-suwayomi.yml) the same way (its tips give the
one folder command to run first), then set `SUWAYOMI_URL` to `http://hbook-suwayomi:4567` in hbook's
settings; then add an extension repository ([step by step](extensions.md#add-an-extension-repository--step-by-step)).
**Admin → Sources** shows these steps too while no engine is set up. Set `PUBLIC_ORIGIN` to the address you
actually open (the manifest defaults to `http://localhost:8080`) or logins will not stick.

**On Unraid?** hbook is in **Community Applications** — search for *hbook* on the **Apps** tab and
install it like anything else. One container, database included; set PUID/PGID to the owner of your library
so renames work. For Mihon/Tachiyomi extensions, install **hbook-suwayomi** from Apps as well
([`templates/hbook-suwayomi.xml`](../templates/hbook-suwayomi.xml): the extension engine, pinned and
memory-capped), choose the password it asks for, create its folder first (`mkdir -p /mnt/user/appdata/hbook-suwayomi
&& chown 1000:1000 /mnt/user/appdata/hbook-suwayomi` in the Unraid terminal), then set hbook's advanced
*SUWAYOMI_URL* to `http://YOUR-SERVER-IP:4567` and *SUWAYOMI_USERNAME* / *SUWAYOMI_PASSWORD* to the engine's user name
(`hbook` unless you changed it) and password. Admin → Sources walks through the same steps. An engine installed
before v0.73.0 has no password; [A password on the engine](extensions.md#a-password-on-the-engine) adds one.

The template behind that listing is [`templates/hbook.xml`](../templates/hbook.xml) in this
repository, which is laid out as a Community Applications template repository (`templates/` plus the
`ca_profile.xml` at the root). If you would rather install it by hand, copy that file to
`/boot/config/plugins/dockerMan/templates-user/` on the server, then *Docker → Add Container* and pick
*hbook* under **User templates**.

Unraid removed the *Template repositories* field in 6.10, and since 7.3 the file behind it is not read at
all, so pointing Unraid at a template repository URL no longer works on any current version — the template
file itself has to be on the server, or come through Community Applications. The
[`unraid-templates`](https://github.com/AngeloSha/unraid-templates) repository is kept only so old links
keep working; it points here.

**On Umbrel?** hbook is [submitted to the Umbrel App Store](https://github.com/getumbrel/umbrel-apps/pull/6055)
and the submission is still open. Until it is listed, install the package at
[`deploy/umbrel/hbook`](../deploy/umbrel/hbook) yourself — it is pinned by digest to the current release or
the one before it, so it may be ahead of the one in the pull request. It runs the database inside the container,
reads your library from *Downloads/manga* (on umbrelOS 2.0 you can pick another folder in the app's settings), and
includes the Cloudflare solver; the Mihon extension engine is not part of it.

## What each container is for

| Container | Role |
|---|---|
| `hbook` | the app: the API, the PWA it serves, and the embedded Postgres database |
| `hbook-trawl` | Cloudflare solver (trawl, a Camoufox browser) — **started automatically**; sources that need it use it with no config, and since v0.37.0 so does the extension engine. FlareSolverr or Byparr can take its place, and since v0.55.3 a second solver can stand by as a backup ([the Cloudflare solver](CONFIGURATION.md#the-cloudflare-solver)) |
| `hbook-suwayomi` | the extension engine, so Mihon / Tachiyomi extensions work once you add an extension repository ([step by step](extensions.md#add-an-extension-repository--step-by-step)); the compose file points it at the solver above (`FLARESOLVERR_ENABLED` / `FLARESOLVERR_URL` on this container). Optional: `EXTENSION_ENGINE=0` in `.env` and `docker compose up -d` leave it out and keep its data ([turning it off](extensions.md#turning-it-off)) |

## On a small machine (2 GB of RAM)

The shipped files are sized for a small server: **trawl** instead of FlareSolverr (about 316 MB idle against
865), the extension engine's heap capped at 512 MB with a 1200 MB ceiling, the image cache at 8 GiB, and two
solves at a time. The whole stack then sits at roughly 1.5–1.7 GB.

```bash
# 1. Give the host 2 GB of swap. Without it, memory pressure makes the kernel kill Postgres mid-write,
#    which is a lost transaction rather than a slow page.
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# 2. Install and go.
curl -O https://raw.githubusercontent.com/YUnauuu/hbook/main/deploy/docker-compose.yml
docker compose up -d
```

Two knobs in `.env` if the machine is smaller still:

```bash
# The extension engine is the biggest single piece. This leaves the app, the database, the solver and
# the Mihon extensions out -- the sources that need no engine (MangaDex, the bundled Chinese sites, any
# site you add by URL) keep working, and the engine's data is kept for the day you turn it back on.
EXTENSION_ENGINE=0

# A bigger cache for the page images. The default is 8 GiB; on a 40 GB disk the library and the database
# want the room too, and the cache is safe to delete (it refills).
CACHE_MAX_BYTES=8589934592
```

Two things are not negotiated on a small box: the extension engine's ceiling must stay at least 1.25× its heap
([the engine's memory](CONFIGURATION.md#the-extension-engine)), and the solver's browser pool is one. Raise
either and the machine runs out of memory before the app does.

```bash
docker compose logs -f hbook  # watch it boot
```

Cloning the repo and want a CLI-seeded admin instead of the browser setup step? `bash scripts/setup.sh`
generates the secrets, creates the admin from a password you type, fixes volume ownership, and starts the
development stack — which builds the **same single container** the install ships, so what you run matches
what you would have deployed. It refuses to run in a checkout whose `docker-compose.override.yml` manages a
service it does not, so it cannot restart a server install.

Change the port with `WEB_PORT` in `.env` (default `8080`; e.g. `WEB_PORT=9000` → http://localhost:9000).


## Updating

```bash
docker compose pull
docker compose up -d
```

**`docker compose up -d` on its own is not enough.** The images are pinned to `:latest`, and Docker reuses a
tag it already has rather than checking for a newer one — so without the `pull` you stay on whatever version
you first installed, indefinitely, with nothing to tell you. Watch
[releases](https://github.com/YUnauuu/hbook/releases) to know when there is something to pull.

Upgrading in place is safe: accounts, reading progress, downloads and settings live in named volumes, and the
database migrates itself on boot.

The extension engine (`hbook-suwayomi`) is the exception: its image is pinned to the version a release was tested
with, so `pull` fetches the same one again. When a release moves it (its notes say so, and so does **Admin → Health**),
change that one `image:` line yourself, after backing up the engine's data:
[Updating the engine](extensions.md#updating-the-engine).

> The two upgrade warnings that used to sit here — empty backups on v0.9.0/v0.9.1, and volume ownership
> before v0.5.1 — are long past. They are in the [changelog](../CHANGELOG.md) with the same detail, which is
> where release history belongs.

## Behind a domain (HTTPS)

The compose file is **standalone**: it publishes the app on a local port and creates its own private networks,
so a fresh install just works. To put it on a public domain with TLS, front the app with any reverse proxy
(Caddy, Traefik, Nginx Proxy Manager, …) and set `PUBLIC_ORIGIN` in `.env` to your URL.

If your proxy reaches containers over a shared Docker network, drop a `docker-compose.override.yml` next to the
compose file — Compose loads it automatically:

```yaml
# docker-compose.override.yml  (server-specific; keep it out of git)
networks:
  proxy:
    external: true
services:
  hbook:
    networks: [hbook_app, proxy]   # keep hbook_app: it is how the app reaches the solver
```

Point the proxy at **`hbook` port 3000**. Once it reaches the app over a shared Docker network you no
longer need the published host port, and deleting the `ports:` entry stops the app also being served over
plain HTTP alongside your HTTPS domain.

**Reading from the desktop app.** hbook Desktop's *Connect to my server* opens this server in its own
window on a Windows PC or Mac ([how](DESKTOP.md#4-connect-to-your-own-server)). Give it the same address as
`PUBLIC_ORIGIN`, with no path: hbook has to be at the root of its address. A self-signed certificate works
(the app asks once and remembers it), and so do sign-in portals in front of the app (Authelia, Authentik…); a
proxy's own password prompt (HTTP Basic Auth) does not, yet.

> Using the development stack from a clone instead? Its services are named `hbook-*`, with networks
> `hbook_app` and `hbook_internal`.

## Single sign-on

hbook signs people in through any OpenID Connect provider (Authentik, Authelia, Keycloak, Pocket ID…), beside its
own accounts or, for a server on the internet, instead of them. With Authentik:

1. **Applications → Providers → Create → OAuth2/OpenID Provider**: client type *Confidential*, redirect URI
   `https://manga.example.com/auth/oidc/callback` (your `PUBLIC_ORIGIN` followed by `/auth/oidc/callback`), and the
   default scopes `openid`, `profile` and `email` (`profile` carries the `groups` claim).
2. **Applications → Create**, with that provider, slug `hbook`. Under its **Policy / Group / User Bindings**, bind
   the group whose members may read here: Authentik then turns everyone else away before hbook sees them.
3. In `.env`:

```dotenv
OIDC_ISSUER=https://auth.example.com/application/o/hbook/
OIDC_CLIENT_ID=…
OIDC_CLIENT_SECRET=…
OIDC_NAME=Authentik
OIDC_ADMIN_GROUP=hbook-admins   # members of this group are admins here
OIDC_ALLOW_SIGNUP=true              # a person the provider lets in gets an account at their first sign-in
```

An account made this way starts with the new-member defaults in **Admin → Members**: which libraries it can open, an
age limit and downloads. Set them before you let people in; until then a new account opens every library.

**SSO-only.** Add `AUTH_MODE=oidc-only` and the server stops offering passwords at all: no setup form, no password
sign-in, no sign-up. A new server's first admin is the first person in `OIDC_ADMIN_GROUP` to sign in, or the subject
`OIDC_BOOTSTRAP_ADMIN_SUB` names. Accounts that already exist need linking first (*Link to Authentik* in **Profile → Account**), and `AUTH_RESCUE_ADMIN` is the way back in if the provider is ever down. The whole reference, with every
setting: [Single sign-on (OIDC)](api.md#single-sign-on-oidc).
