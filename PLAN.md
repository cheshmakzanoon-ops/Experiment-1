# Experiment-1 — Working Plan & Status

**What this is:** a private, single-household YouTube client shell for very slow
(1–2 Mbps) internet in Iran. Persian (Farsi), RTL, modeled on the official
YouTube Android app, with all YouTube traffic proxied through our own Node
backend so clients never touch YouTube hosts directly.

**Stack:** Node 20 + Hono (ESM/TS) backend, `yt-dlp` + `ffmpeg` for extraction,
plain HTML/CSS/JS frontend (no framework), Docker deploy. An Android WebView
wrapper (`android/`, Phase 5) turns the web app into an installable app.

## Status — Phase 1 (foundation) ✅ implemented

- Backend: Hono server, env config, in-memory TTL cache, sliding-window rate
  limiter, error/not-found handlers, zod-free typed routes.
  - `GET /api/health`, `/api/health/ready`
  - `GET /api/search?q=&max=` (yt-dlp `ytsearchN:`), thumbnails rewritten to proxy
  - `GET /api/video/:id[?quality=]` (metadata, cached 2 h)
  - `GET /api/video/:id/thumbnail` (i.ytimg.com relay, cached 24 h)
- Frontend shell: static Persian RTL UI with YouTube dark theme.
- Infra: Dockerfile (installs yt-dlp/ffmpeg), docker-compose, .gitignore.

## Status — Phase 2 (byte-relaying stream proxy) ✅ implemented

- `GET /api/stream/:id[?quality=]` now **relays video bytes** from YouTube
  through this server — clients never touch googlevideo.com. Supports
  Range/206 seeking, HEAD preflight, cache invalidation + one re-extraction
  on upstream 403/429, and abort/timeout handling (never buffers whole files).
  - `GET /api/stream/:id/probe` — cheap availability check.
  - `GET /api/stream/stats` — stream-cache statistics.
- Extraction hardened in `src/utils/ytDlp.ts`: exponential-backoff retries,
  error classification (404/private/age/geo/DRM vs bot-wall/rate-limit/timeout),
  player-client rotation (`default → android → mweb`) to dodge datacenter
  bot-blocks, optional PO-token passthrough via `YT_PO_TOKEN`/
  `YT_VISITOR_DATA`, and single-URL format selection: highest MP4/WebM
  audio+video ≤ requested height, else smallest above (usually 360p MP4),
  legacy containers only as fallback, silent DASH as last resort.
- Stream URLs cached 2 h (URLs live ~6 h) with per-quality keys, LRU
  eviction + stats in `src/middleware/streamCache.ts`; `/api/video/:id`
  seeds that cache so the player's first stream request is a cache hit.
  `/api/video/:id` cached responses are sanitized (no direct URL leaked).
- Frontend watch page probes the proxy (Range `bytes=0-0`) and plays on
  2xx; failure/error notices are now generic Persian copy instead of the
  “added in a later phase” 501 message.

## Status — Phase 3 (home feed + search + library) ✅ implemented

- **Trending feeds** (`src/services/youtube/trendingService.ts`): categories
  with Persian labels, a 30-minute feed cache, and yt-dlp searches that
  simulate trending/home content (mixed across categories for the home
  feed). Endpoints: `/api/feed/home`, `/api/feed/category/:id`,
  `/api/feed/categories`, `/api/feed/stats`. Thumbnails are proxied.
- **Home tab** now loads trending videos automatically (no more
  “برای شروع، جستجو کنید”), with dynamic Persian category chips, skeleton
  loading, infinite scroll, per-category caching, and graceful error/retry
  states. The UI only calls the proxy — no direct YouTube hosts.
- **Search** keeps recent searches in localStorage (suggestions + clear
  button), shows combined recent/common Persian suggestions while typing,
  and debounces into `/api/search`.
- **Subscriptions & Library** are localStorage-based (no YouTube account):
  subscribe/unsubscribe from the watch page, watch history, watch later
  (from the ⋮ menu), liked videos, and “not interested” (removes cards
  from the home feed). Bottom-sheet action menus + Persian toasts.

## Status — Phase 4 (offline & low-bandwidth) ✅ implemented

- **Service worker** (`src/frontend/sw.js`, registered best-effort from
  `js/app.js`): app shell (HTML/CSS/JS) is network-first with cache
  fallback (fresh code after every deploy, still works offline once
  visited); thumbnails and feed/search/metadata responses are
  stale-while-revalidate (served instantly offline/on slow links,
  refreshed in the background). Video streams are never touched by the
  service worker (Range/206 + large files) — real offline files live in
  the download manager instead.
- **Watch-later offline downloads** (`js/services/offlineService.js`):
  «دانلود برای تماشای آفلاین» in the ⋮ menu and on the watch page pulls
  the same low-bandwidth `/api/stream/:id?quality=240` stream and stores
  it in IndexedDB (metadata + Blob in separate stores so the Library list
  never loads video bytes into memory). Progress + cancel supported;
  finished files play from a Blob URL with zero connection. Storage
  persistence is requested via `navigator.storage.persist()`.
- **Library «آفلاین» section**: live rows with progress bars (in-place
  updates via DOM events), cancel while downloading, play/delete once
  ready.
- Home-tab category chips are now seeded instantly from the built-in list
  (works offline / before the first fetch) and refreshed from the server;
  the stale hardcoded chip markup (incl. a bogus «مختلط» chip) was removed
  from `index.html`.

## Status — Phase 5 (Android WebView wrapper) ✅ implemented

- **`android/` Gradle project** (Kotlin, AGP 8.2.2/Gradle 8.5, API 26+
  min / 34 target, ~3 MB APK, no Android Studio needed): full-screen
  WebView host with portrait lock, screen-on while watching, back-button
  WebView history + «خروج از برنامه؟» exit dialog, top progress line,
  swipe-to-refresh, JS dialogs via native AlertDialogs.
- **Persian offline page**: main-frame network errors show a «اینترنت قطع
  است» fallback whose retry button calls the bridge; `NetworkMonitor`
  re-registers on Wi-Fi/cellular and auto-reloads the app on reconnect
  (double-registration guarded).
- **JS bridge** (`window.AndroidBridge`, proguard-kept): toasts, network
  status, `navigator.storage.persist()` equivalent, storage info, native
  share sheet, cache clear, DownloadManager hook (class ready, downloads
  still in-app via IndexedDB). Wrapper is detected in the page through
  `window.AndroidWrapper` + `android-wrapper-ready`;
  `src/frontend/js/utils/nativeApp.js` exposes `isNativeApp()`,
  `getNativeBridge()`, `onAndroidReady()`, `requestPersistentStorage()`,
  `shareVideo()` — the ⋮-menu share now opens the native sheet inside the
  wrapper and degrades to Web Share/clipboard in a browser.
- **WebView reality check (documented in android/README.md):** Android
  WebView cannot run service workers, so `sw.js` shell caching is inactive
  there; IndexedDB offline downloads keep working. cleartext preview/dev
  hosts are allow-listed in the network security config; HTTPS is default.
- Network/`WRITE_EXTERNAL_STORAGE(≤28)` permissions, adaptive red-play
  launcher icon («ویدیو» label in `values-fa`), build docs incl. the
  `-PWEBAPP_URL=…` bake-in and optional release signing.

## Status — Phase 6 (live testing, diagnosis & deployment prep) ✅ tooling built — not yet run

- **Diagnostic endpoints** (`src/routes/diagnosticRoutes.ts`, mounted at
  `/api`): `/api/diag/pipeline` (full yt-dlp → URL selection →
  googlevideo.com range-test), `/api/diag/ip` (egress IP + datacenter
  detection), `/api/diag/ytdlp-verbose` (raw yt-dlp log + bot-wall
  indicators), `/api/diag/stream-test` (round-trip through our own
  `/api/stream`), `/api/diag/report` (combined verdict),
  `/api/diag/blocking-status` + `/api/diag/workaround-extract` (run the
  workaround ladder over HTTP).
- **Blocking workarounds** (`src/services/youtube/blockingWorkaround.ts`):
  block-type detection (bot-wall / rate-limit / IP-block) and an explicit
  default → android → mweb extraction ladder (normal extraction already
  rotates clients internally; this is the fallback on top). Cloudflare WARP
  was removed in Phase 7 — the image does not install `warp-cli`.
- **PO token support** (`src/services/potoken/generator.ts`): boot-time
  auto-generation + 4-hour refresh via the bgutil provider when installed
  (see Phase 7).
- **FreeBuff sandbox support** (`src/config/freebuff.ts`): keepalive that
  self-pings `/api/health` every 4 min (started in `src/index.ts`),
  bandwidth monitor + slow-request logging middleware, and
  `/api/diag/sandbox` health assessment.
- **Deployment prep**: `build-apk.sh` (root, executable) builds the debug
  APK with `-PWEBAPP_URL="$1"`; `android/README.md` documents it;
  **`TESTING.md`** is the step-by-step validation guide (Canada-first),
  incl. Plan B (Oracle free tier / Cloudflare hybrid / home server) when the
  sandbox IP stays blocked by YouTube.

**Status: code compiles; diagnostics have NOT yet been run against real
YouTube from a live deployment.** Running `TESTING.md` Step 2
(`/api/diag/pipeline`) against the preview is the next gate — it decides
whether to proceed with the APK + Iran rollout or pivot to Plan B.

## Status — Phase 7 (security hardening & production fixes) ✅ implemented

- **API-key authentication** (`src/middleware/auth.ts`): every `/api/*`
  request needs `API_KEY` (query param, `X-API-Key`, or `Bearer` header),
  compared in constant time. Public only: `/api/health`, `/api/health/ready`,
  `/api/config` (frontend bootstrap) and `/api/video/:id/thumbnail`
  (`<img>` tags cannot send headers). Unset `API_KEY` = warned, insecure
  dev mode. Frontend (`js/api.js` + services) sends the key automatically,
  streams get it in the URL, and unauthorized requests show a Persian key
  prompt (`/api/config` auto-provisions the key when configured).
- **PO token setup** (`src/services/potoken/generator.ts` + POTOKEN.md):
  boot-time spawn of the bgutil HTTP provider, auto-generated token pair
  refreshed every 4 h into `YT_PO_TOKEN`/`YT_VISITOR_DATA` (legacy
  extractor-arg path), plus the yt-dlp plugin path for modern yt-dlp.
  Graceful: no provider → warn and extract without a token.
  `/api/diag/potoken` reports mode/status/token preview.
- **WARP dead code removed** (`blockingWorkaround.ts`): Cloudflare WARP was
  unreachable (image has no `warp-cli`); ladder is now
  default rotation → android → mweb, with a comment on re-enabling WARP.
- **Accurate stream bandwidth** (`src/middleware/streamByteCounter.ts`):
  `/api/stream/*` bodies are wrapped and counted as bytes actually flow
  (chunked relays + early disconnects included); generic middleware counts
  Content-Length responses; `/api/diag/sandbox` now reports MB + GB.
- **Keepalive external ping** (`src/config/freebuff.ts`): pings both
  `/api/health` (loopback) and an external host (default api.ipify.org,
  override `KEEPALIVE_EXTERNAL_URL`) so idle detection that measures egress
  traffic sees real activity. Status incl. per-ping counters in
  `/api/diag/sandbox`. README documents UptimeRobot/cron-job.org
  alternatives for hosts where self-pings do not count.
- **Stream read timeout** (`streamProxy.ts`): relayed bodies error out after
  30 s without a chunk (no more infinite buffering); client disconnect
  still cancels upstream reads. Frontend adds a 15 s stall detector with a
  Persian error message.
- **Quality selector UI** (`js/components/qualitySelector.js` + watch-page
  gear button): 144/240(recommended)/360/480p, preference stored in
  localStorage, video reloads at the chosen quality.
- **Diagnostic endpoints protected** — all `/api/diag/*` are behind auth;
  only health/config/thumbnails are public (see the Security section in
  README.md).

### Next steps
- [ ] Run the pipeline test from a live deployment (TESTING.md) — Canada first
- [ ] Test from Iran on the real household links
- [ ] Build the APK against the production URL (`./build-apk.sh …`) and
      install on the parents' phones
- [ ] Configure `API_KEY` in production env; decide PO-token strategy
      (auto-provider vs manual env pair) after the first live bot-wall test

## Remaining work (next phases)

1. **Run Phase 6/7 live:** execute `TESTING.md` steps against the deployed
   preview; record `/api/diag/pipeline` + `/api/diag/ip` results. If the
   sandbox IP is blocked, add a PO token (POTOKEN.md) or move the backend to
   Plan B egress and re-test.
2. **Optional:** subscriptions with real upload feeds need a backend (or
   YouTube channel scraping) instead of local-only storage.
3. **Optional:** chunked IndexedDB writes for very large offline files
   (currently a finished download is assembled as one Blob before being
   stored).
4. **Optional:** real-device Android checklist (install the debug APK,
   verify back/offline/share/downloads on the target phone) — the wrapper
   code builds from Gradle but hasn't been run on hardware yet.

### Streaming-phase follow-ups (only if playback proves unreliable)

- Residential egress / authenticated cookies when datacenter IPs stay blocked
  (PO tokens alone do not guarantee a bypass).
- Redis-backed stream cache if the server ever runs multi-instance.

### Notes on the keepalive

The keepalive only matters on hosts that idle-suspend (FreeBuff dev
sandboxes); it now pings both loopback `/api/health` and an external host.
On a real always-on VPS (Plan B) it is harmless — disable it there if you
dislike the log noise (remove `keepalive.start(4)` in `src/index.ts`). If
self-pings (even external ones) do not keep a given sandbox awake, use an
outside monitor instead:

- **UptimeRobot** (free tier): HTTP monitor on
  `https://your-freebuff-url.app/api/health`, 5-minute interval.
- **cron-job.org** (free): cron job every 5 minutes hitting the same URL.

## Notes / guardrails

- Re-serving YouTube content may violate YouTube ToS → keep private,
  household-only, never public.
- Server must run where YouTube is reachable (outside Iran); datacenter IPs
  may be blocked by YouTube ("Sign in to confirm you're not a bot") — may
  need residential egress or authenticated yt-dlp cookies.
- This Freebuff workspace blocks writing `.env*` files (including
  `.env.example`); env vars are managed via the platform's env UI instead.
  All variables are documented in README.md.
