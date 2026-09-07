# Experiment-1

A YouTube **client shell** for a family in Iran with slow (1–2 Mbps) internet:
a Persian (Farsi), RTL, YouTube-Android-look-alike web app whose backend
proxies YouTube metadata, thumbnails, and video streams (byte-relayed through
the server, with Range/seek support) so the family can watch YouTube without
YouTube being reachable from their network.

> **Honest caveats before you build on this:**
> - Re-serving YouTube content through your own proxy can violate
>   [YouTube's Terms of Service](https://www.youtube.com/t/terms). Keep this a
>   private tool for your own household — do not host it publicly or for
>   third parties, and never re-distribute/downloaded content.
> - The **server must run on a host with unrestricted access to YouTube**
>   (e.g. a cheap VPS outside Iran). Iranian ISPs block YouTube, so a server
>   hosted in Iran cannot fetch anything.
> - YouTube actively blocks datacenter IP ranges. If metadata extraction
>   starts failing with `Sign in to confirm you're not a bot`, you may need a
>   residential egress or authenticated yt-dlp cookies.
> - `ffmpeg` + `yt-dlp` are required on the server (the Dockerfile installs
>   both). This repo intentionally calls `yt-dlp` as a **system binary**, not
>   an npm package.

## Stack

- **Backend:** Node.js 20+, [Hono](https://hono.dev), TypeScript (ESM, NodeNext)
- **Extraction:** `yt-dlp` (system binary) + `ffmpeg`
- **Frontend:** static HTML/CSS/JS (no framework) — Persian, RTL, YouTube dark theme
- **Deploy:** Docker / docker-compose
- **Offline:** service worker (app shell + thumbnails/feeds/search) plus
  IndexedDB-backed «دانلود برای تماشای آفلاین» downloads; see PLAN.md
- **Android:** Gradle-built WebView wrapper (API 26+, no Android Studio) that
  loads this app as a full-screen «ویدیو» app — back-button history, Persian
  offline page, native share, JS bridge; see `android/README.md`

## Project structure

```
├── src/
│   ├── index.ts                 # Hono server entry
│   ├── config.ts                # env-driven config
│   ├── types/                   # video + api types
│   ├── middleware/              # cache / streamCache / rateLimit / errorHandler
│   ├── services/
│   │   ├── youtube/             # extractor, searchService, streamProxy
│   │   └── cache/               # in-memory TTL cache singleton
│   ├── routes/                  # video, search, stream, health + aggregator
│   ├── utils/                   # ytDlp, httpUtils, logger, urlValidator
│   └── frontend/                # Persian RTL UI (HTML/CSS/JS)
├── android/                     # native Android WebView wrapper (see android/README.md)
├── Dockerfile / docker-compose.yml
└── .env.example                 # see "Environment" below
```

## Quick start

### With Docker (recommended — installs yt-dlp + ffmpeg)

```bash
cp .env.example .env      # create once, tune settings
docker compose up --build
# http://localhost:3000  → Persian UI
# http://localhost:3000/api/health
```

### Local development

Requires Node 20+ and `yt-dlp` + `ffmpeg` on PATH.

```bash
npm install
npm run dev        # tsx watch → http://localhost:3000
# or:
npm run build && npm start
```

Verify: `GET /api/health` returns `200 {"status":"ok",...}` and `GET /`
serves the RTL Persian UI. `GET /api/health/ready` reports whether yt-dlp is
installed.

## API

| Endpoint | Description |
| --- | --- |
| `GET /api/health` | liveness + memory (**public**) |
| `GET /api/health/ready` | readiness incl. yt-dlp check (**public**) |
| `GET /api/config` | bootstrap config — hands the frontend its API key (**public**) |
| `GET /api/search?q=...&max=8` | search results (yt-dlp `ytsearch`) |
| `GET /api/video/:id?quality=240` | video metadata (cached 2 h) |
| `GET /api/video/:id/thumbnail` | proxied thumbnail (i.ytimg.com relay; **public** — `<img>` tags can't send a key header) |
| `GET /api/stream/:id?quality=240` | **byte-relayed video stream** (Range/206, HEAD) |
| `GET /api/stream/:id/probe` | lightweight availability check |
| `GET /api/stream/stats` | stream-cache statistics |
| `GET /api/feed/home?page=&limit=` | mixed trending home feed |
| `GET /api/feed/category/:id?page=&limit=` | category feed (music, news, …) |
| `GET /api/feed/categories` | category list with Persian labels |
| `GET /api/feed/stats` | feed-cache statistics |
| `GET /api/diag/pipeline` | full yt-dlp → googlevideo.com → relay pipeline test |
| `GET /api/diag/ip` | egress IP + datacenter detection |
| `GET /api/diag/ytdlp-verbose` | raw verbose yt-dlp log (bot-wall diagnosis) |
| `GET /api/diag/stream-test` | round-trip through `/api/stream` |
| `GET /api/diag/blocking-status` | active YouTube block type |
| `GET /api/diag/workaround-extract` | workaround ladder for one video |
| `GET /api/diag/potoken` | PO-token provider status + token preview |
| `GET /api/diag/report` | combined diagnostic report + verdict |
| `GET /api/diag/sandbox` | keepalive / bandwidth / sandbox health |

Home/category feeds are yt-dlp searches cached for 30 minutes (there is no
real “trending” endpoint without the YouTube API), and their thumbnails go
through the same proxy route as search results. The Home tab, category
chips, infinite scroll, search history, subscriptions and the library
(history / watch-later / liked / offline downloads) are all driven by this
API plus localStorage/IndexedDB — see PLAN.md for the phase-by-phase
status.

All traffic to YouTube (metadata, thumbnails, streams) goes through the
backend, so Iranian clients never touch YouTube hosts directly. The stream
endpoint relays bytes from googlevideo.com: seeking is supported (Range
requests pass through → `206 Partial Content`), direct URLs are cached for
2 hours and never exposed to clients, and a blocked/expired URL triggers one
cache-invalidating re-extraction before failing.

The server also runs a keepalive every 4 minutes — an internal `/api/health`
self-ping **and** an external ping (`api.ipify.org`, overridable with
`KEEPALIVE_EXTERNAL_URL`) that generates real egress traffic so idle
FreeBuff-style sandboxes stay awake — and tracks bandwidth/slow requests;
snapshot them at `/api/diag/sandbox`. See “Security” below and the keepalive
alternatives in `PLAN.md` for always-on VPS deployments.

## Security

### API key authentication

Every `/api/*` endpoint except the small public set (liveness/readiness,
`/api/config`, and proxied thumbnails) requires an API key. Set it via
environment variable:

```bash
export API_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
```

The key may be sent as `X-API-Key: <key>`, `Authorization: Bearer <key>`, or
`?key=<key>` (the `<video>` element uses the query param). The frontend
fetches the key from `/api/config` on first load or shows a Persian prompt
when a request is unauthorized — no manual header configuration needed.

- **Without `API_KEY` set the server warns once and runs in insecure dev
  mode** (auth disabled) so local/preview work is frictionless. Set the key
  in the platform env UI before serving real users.
- **Protected:** video proxy (`/api/stream`), search/feed/video metadata,
  and **all `/api/diag/*` endpoints** — these expose server infrastructure
  details (IP, hosting provider, bandwidth, PO-token state) and must never
  be reachable without a key.
- **Public by design:** `/api/health`, `/api/health/ready`, `/api/config`
  (frontend bootstrap), and `/api/video/:id/thumbnail` (rendered by `<img>`
  tags, which cannot send headers).

### PO token

For datacenter-IP deployments, PO tokens are often the difference between
extraction working and `Sign in to confirm you're not a bot`. The image
includes the bgutil provider + plugin and the app auto-generates/refreshes
tokens; see **[POTOKEN.md](POTOKEN.md)** for setup and troubleshooting.

### Quality selector

The watch page gear button lets viewers pick 144p / 240p (recommended) /
360p / 480p; the choice is remembered per device and the video reloads at
the new quality immediately.

### Live testing & failure diagnosis

Before trusting this in front of the family, validate the deployment against
real YouTube: follow **`TESTING.md`** top to bottom. The `/api/diag/*`
endpoints (see the API table) isolate exactly where the pipeline breaks —
extraction blocked (bot-wall/429/403), video-CDN blocked, or network — and
`/api/diag/workaround-extract` runs the fallback ladder — client rotation
→ explicit android/mweb attempts (`src/services/youtube/blockingWorkaround.ts`;
Cloudflare WARP was removed because the image does not install `warp-cli`).
Expect YouTube to block plain datacenter IPs; that is the #1 known failure
mode for FreeBuff-style hosting — see POTOKEN.md before falling back to
Plan B egress.

`quality` is a *maximum*: the extractor picks the highest combined
(audio+video) MP4/WebM ≤ that height, or the smallest one above it when
nothing lower exists (YouTube rarely serves combined files under 360p, so
requests for 144/240p usually stream 360p MP4 — ideal for 1–2 Mbps links).
Valid values: `144`, `240`, `360`, `480`.

## Environment

`.env.example` (create `.env` from it; never commit real `.env`):

```ini
# Server Configuration
PORT=3000
NODE_ENV=production

# Critical Security — generate with:
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Unset = insecure dev mode (auth disabled + startup warning).
API_KEY=

# Cache Settings
CACHE_TTL_VIDEO=7200000
CACHE_TTL_SEARCH=30000
CACHE_MAX_VIDEO=200
CACHE_MAX_SEARCH=100

# Rate Limiting
RATE_LIMIT_WINDOW=60000
RATE_LIMIT_MAX_REQUESTS=30

# Video Quality Settings
DEFAULT_VIDEO_HEIGHT=240
MAX_VIDEO_HEIGHT=480

# Logging
LOG_LEVEL=info

# CORS
CORS_ORIGIN=*

# PO tokens (Proof of Origin) to bypass YouTube's datacenter-IP bot-wall.
# Preferred: leave empty — the bgutil provider auto-generates (POTOKEN.md).
# Manual override pair:
YT_PO_TOKEN=
YT_VISITOR_DATA=
# bgutil HTTP provider URL (auto-spawned at 127.0.0.1:4416 when default).
YT_PO_PROVIDER_URL=http://127.0.0.1:4416

# Keepalive external ping target (egress traffic for idle sandboxes).
KEEPALIVE_EXTERNAL_URL=https://api.ipify.org
```

`.env.example` cannot be committed in this workspace; the platform env UI
accepts the same keys.

## Offline / low bandwidth

- A **service worker** (`src/frontend/sw.js`) is registered automatically
  (best-effort — unsupported browsers/webviews simply stay online-only). It
  makes the app shell usable offline after the first visit and serves
  already-seen thumbnails and feed/search results instantly from cache
  while refreshing them in the background. Video streams are never stored
  by the service worker (Range/206 + large files).
- **Watch-later downloads**: the ⋮ menu of any video (and the watch-page
  «دانلود» button) offers «دانلود برای تماشای آفلاین», which downloads the
  same 240p-max stream the player uses and stores it in IndexedDB. Progress
  is shown in the Library → «آفلاین» section, downloads can be cancelled,
  and finished videos play fully offline from a local Blob.
- Service workers require a secure context (`https://`, or localhost).

## Android app (native wrapper)

`android/` is a small Gradle project (Kotlin, API 26+, ~3 MB APK) wrapping
this web app in a full-screen WebView — a real home-screen app for
non-technical family members instead of a browser bookmark. It is built from
the command line (no Android Studio) and only needs a JDK 17 + Android SDK:

```bash
cd android
./gradlew assembleDebug -PWEBAPP_URL="https://your-server.example"
# → android/app/build/outputs/apk/debug/app-debug.apk  (installable)
```

- The **web app URL is baked into the APK** at build time via the
  `WEBAPP_URL` Gradle property (point it at the public deployment, not a
  dev preview).
- Back button walks the WebView history; offline shows a Persian
  «اینترنت قطع است» page that retries and auto-reloads on reconnect.
- The page detects the wrapper through `window.AndroidWrapper` +
  `android-wrapper-ready` (`src/frontend/js/utils/nativeApp.js`) and shares
  via the native sheet.
- Caveat: Android WebView does **not** support service workers, so `sw.js`
  shell caching is inactive there — IndexedDB offline downloads still work.

Full build/signing/install/update instructions: [`android/README.md`](android/README.md).

## UI notes

- Persian UI strings and RTL layout are baked into `src/frontend/`
  (`index.html`, `styles/rtl.css`, `js/utils/persianUtils.js`).
- Persian numerals: durations, view/subscriber counts and timestamps render as
  `۰۱۲۳…`.
- Fonts currently load from Google Fonts; for Iran, self-host Vazirmatn
  (see `src/frontend/assets/fonts/README.md`).
- Design tokens mirror YouTube's Android dark theme
  (`styles/youtube-theme.css`).
