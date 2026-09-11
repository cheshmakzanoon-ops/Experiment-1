# Testing Guide — Validate Before Sending to Iran

Everything below assumes the code is checked out and, where noted, the
server is running (see README → Quick start). Two distinct phases:

1. **Local verification** — automated checks + a local server on a test
   port. Localhost proves the Node process works.
2. **External smoke test** — against the real Freebuff live-preview /
   deployed URL. Only this proves the ingress proxy, Range survival, real
   egress to YouTube, and that a phone in Iran can reach the host.

> 🔑 **Session auth:** the proxy now uses an HttpOnly same-origin session
> cookie. There is no `?key=…` and no `/api/config` key hand-out. The smoke
> script logs in with `FREEBUFF_SMOKE_KEY` (env var). Production refuses to
> start without `ACCESS_KEY` + `SESSION_SECRET`; `AUTH_DISABLED=true` is the
> explicit dev-only bypass.

---

## Experiment-1 reliability remediation — active packet

> Single durable execution ledger for the reliability-remediation
> assignment. Replace this packet's contents in place as stages complete;
> keep the active context around 800–1,200 words and put durable executed
> results in the table below the packet. Do not append repeated plans or
> full logs here.

**Baseline SHA and current branch:** `f898e3f7c12bd62b02609d1b50357c23093d9adb` on `main` (origin `https://github.com/cheshmakzanoon-ops/Experiment-1.git`, single worktree at repo root, HEAD == audit SHA at assignment start).

**Baseline gate results (executed, before any production edit):**
`npm ci --include=dev` exit 0 · `npm run lint` exit 0 · `npm run typecheck` exit 0 · `npm run build` exit 0 (prebuild regenerated `src/frontend/js/shell-manifest.js`, diff reviewed, no unintended content change) · `npm test` exit 0 — **17 files / 204 tests passed**. Node v22.23.1, npm 10.9.8. Pre-existing dirty paths: none (clean `git status --short` before any work).

**Pre-existing dirty paths that must remain untouched:** none at start; verify with `git status --short` before every commit and stage only files named in the current repair.

**Current stage and issue IDs:** Stage 4 (A01/A02) and Stage 5 (A04) COMPLETE — red→green executed, full gates green, results table updated. Stage 3 (A03/A05/A10) committed as `3d2b75e`; its real-browser tier has been executed in this sandbox (see results table).

**Current invariant being repaired:** done this stage — (A01) rate-limit identity can never be client-choosable: strict-rightmost X-Forwarded-For entry (the only proxy-added, non-client-controlled position) with bare-IP-literal validation; junk/ported entries fail closed to the socket address or the shared `anon` bucket. (A02) the public POST /api/session endpoint no longer buffers an unbounded body: a bounded JSON reader rejects oversized bodies with a controlled 413 (declared Content-Length refused before reading; streaming bodies cancelled at the cap). (A04) bounded extraction/relay: the thumbnail relay caps the upstream body read at 2 MiB (cancel + 502, huge declared Content-Length refused before reading), and the yt-dlp runner no longer appends stdout chunks after the cap is hit (post-cap bytes are counted, not stored, so an oversized-output child that ignores SIGTERM cannot drain memory while dying).

**Files/functions actually inspected (with line ranges as of inspection):**
- `src/frontend/js/services/offlineService.js` — `openDb` (L18–34), `transaction` helper (L36–49), `requestChunk` (L410–560), `runDownload` (L560–700), `operations` in-memory map (L15), DB `yt-offline-db` v2, stores `videos`/`chunks`, upgrade deletes `blobs` (L25).
- `src/frontend/js/api.js` — `buildGate` (L15–40), `fetchSessionState` (L45–70), `ensureAuthenticatedOnce` (L75–110), `waitForGateOrAbort` (L115–140), `apiFetch` (L150–200), `apiGetJson` (L205–235).
- `src/frontend/sw.js` — `installShell` (L8–45), `fetchWithTimeout` (L50–75), `networkFirst` (L90–120), `activateGeneration` (L150–180).
- `src/frontend/js/app.js` — `registerServiceWorker` (L20–60), `navigateToPage` (L80–120), `runSearch` (L300–340).
- `src/services/ytdlp/runYtDlp.ts` — `spawnYtDlpProcess` (L60–220), `terminateAllChildren` (L240–280); `src/services/ytdlp/queue.ts` — `startFlight`/`finishFlight`/`cancelWaiter` (L40–180); `src/middleware/session.ts` — `verifySessionToken`/`issueSessionToken`/`revokeSessionToken` (L20–160); `src/services/sessionStore.ts` — `initialize`/`add`/`remove`/`persistSnapshot` (L30–260); `src/services/youtube/extractor.ts` — `selectBestStream`/`toSelectedStream`/`extractRawInfo` (L80–400); `src/services/youtube/trendingService.ts` — `loadHomeBatch`/`getHomeFeed`/`loadBatchForQuery` (L40–260); `src/frontend/js/components/homeFeed.js` (full); `src/frontend/js/components/videoPlayer.js` — `openVideoPlayer`/`handleStreamError`/`classifyStreamFailure`/`retryCurrentStream` (L60–400); `src/services/youtube/streamProxy.ts`, `src/utils/net.ts`, `src/middleware/streamCache.ts`, `src/services/diagnostics.ts` + diagnostic/stream/session routes, `src/middleware/rateLimit.ts`, `src/index.ts` (composition + shutdown), `android/*` listed in stage 13, `scripts/build-shell-manifest.mjs`, `src/frontend/index.html`, `scripts/bootstrap-runtime.mjs`, `scripts/ensure-runtime.mjs`, `Dockerfile`, `docker-compose.yml`, `build-apk.sh`.

**Last verified checkpoint:** baseline commit `f898e3f` (all five gates green: lint 0 problems, typecheck clean, build ok, 17 files/204 tests passed); Stage 4/5 working tree: lint 0 problems, typecheck clean, **21 files / 235 tests passed**.

**Current failing regression:** none — Stage 4/5 red regressions all green (9 red initially, 18 cases now in the suite).

**Last executed command / exit status:** `npm test` exit 0 — **21 files / 235 tests passed** (117 s). Preceded by `npm run lint` exit 0 and `npm run typecheck` exit 0.

**Decisions already made and alternatives rejected:**
- Use one additive IndexedDB `operations` store (v2→v3) for durable ownership/fencing rather than requiring BroadcastChannel/Web Locks for correctness; those remain notifications/optimizations only.
- Shared bounded JSON body-deadline helper in `api.js` (`apiGetJson`) instead of post-hoc `.json()` in feed/search services; raw media responses keep their separate deadlines (never read a movie to time an API call).
- Browser regression coverage via `@playwright/test` (pinned version recorded when installed) with real HTTP fixture servers; no fetch mocks for worker-owned requests; keep `.spec.mjs` files outside Vitest's `*.test.*` glob.
- No FFmpeg merger, no HLS/DASH architecture (A09 stays on progressive combined-format contract); unsupported content gets explicit `FORMAT_UNAVAILABLE` outcomes.
- Docker is secondary; Freebuff remains primary; no destructive cache/DB resets as repairs.

**Schema/API/worker message changes already introduced:** `yt-offline-db` v2→v3: additive `operations` store (`videoId: "owner:<id>"` keyPath, heartbeat-fenced ownership records). The v2 upgrade-handler deletion of the legacy `blobs` store was REMOVED — the store is preserved (A05).

**Pending migrations and compatibility readers:** shipped this stage — legacy v1 monolithic-Blob compatibility reader (`getLegacyDownload`/`isValidLegacyRow`/`legacyRecord`/`playLegacyBlobUrl`); legacy rows surface in `getDownload`/`getDownloads` and remain byte-playable via `offlinePlayUrl`; only explicit user cancel/remove deletes a legacy row (`deleteLegacyBlobRecord`). No automatic migration of legacy rows into chunks (not needed for correctness; original preserved).

**Owned test processes, temp dirs, cleanup obligations:** none open. Test-owned artifact rules: fixtures only under `tests/` or `.runtime`-ignored paths; no generated media, binaries, profiles or node_modules committed; remove only task-created temp dirs at stage end.

**Next three concrete actions:** (1) commit Stage 4/5 with only the files it touched; (2) remaining audit-ID tiers (A06–A17) triaged into future stages per the assignment's ordered stages; (3) external tiers (Phase-2 smoke, Android device, Docker) stay BLOCKED with the exact conditions already recorded.

**Blockers and evidence needed to remove each:**
- No external YouTube egress / real deployment URL available in this sandbox → real-egress phases (Phase 2 smoke, Gate D real-YouTube items) stay externally BLOCKED; recorded as such rather than fabricated.
- No Android emulator/device/SDK (probed 2026-09-11: no `sdkmanager`/`adb`, no `/opt/android*` or `/usr/lib/android-sdk`) → A17 instrumentation tier stays unverified; JVM tests + browser navigation/offline tests are the local evidence tier.
- Docker daemon unavailable (probed 2026-09-11: no `docker` binary) → A16 image build stays BLOCKED with that exact condition; Dockerfile/compose remain the secondary route documented in README.

### Durable executed results (append-only, newest last per ID)

- **2026-09-11 Post-commit verification sweep (commit `96098a2`):** all remaining local tiers re-executed green after the Stage-4/5 commit: `npm run test:browser` exit 0 (5/5, Playwright 1.49.1 headless Chromium) and targeted Vitest re-run — `smoke`, `sw-policy`, `offline-ownership`, `offline-download`, `runtime-bootstrap`, `shutdown`, `stream-range-order` — **7 files / 99 tests passed** (110 s). No regression outside the Stage-4/5 repairs.
- **2026-09-11 Stage 4 (A01/A02) + Stage 5 (A04) committed as `96098a2`:** Red→green executed. RED: 9 new tests failed exactly as predicted (leftmost-IP spoof accepted; 32 KiB login body buffered; thumbnail relay stalled unbounded on an infinite upstream; huge Content-Length accepted). GREEN after repairs: `npm run lint` ✓ 0 problems · `npm run typecheck` ✓ · `npm test` ✓ **21 files / 235 tests** (117 s). Production changes: `src/middleware/rateLimit.ts` (strict-rightmost XFF + `isPlainIpLiteral` validation, fail-closed to socket/`anon`), `src/middleware/boundedBody.ts` (new `readBoundedJson`, 8 KiB cap, 413 `PAYLOAD_TOO_LARGE`), `src/routes/sessionRoutes.ts` (login uses the bounded reader), `src/routes/videoRoutes.ts` (`readBoundedThumbnail`, 2 MiB cap, cancel+502), `src/services/ytdlp/runYtDlp.ts` (post-cap stdout chunks counted, not appended; escalation re-arm). New tests: `tests/rate-limit.test.ts` (10), `tests/session-body-limit.test.ts` (5), `tests/thumbnail-bound.test.ts` (3).
- **2026-09-11 A03/A05/A10 real-browser tier re-executed in sandbox (commit `3d2b75e`):** `npm run test:browser` exit 0 — **5/5 passed** (Playwright 1.49.1, headless Chromium 1148, real IndexedDB + CacheStorage) against the real HTTP fixture server serving the shipped `src/frontend` tree verbatim. The previously-blocked display-server condition did not apply; the tier is now executed evidence, not pending.
- **2026-09-09 baseline (commit `f898e3f`, main):** `npm ci --include=dev` ✓ · lint ✓ (0 problems) · typecheck ✓ · build ✓ · `npm test` ✓ **17 files / 204 tests**. Node v22.23.1, npm 10.9.8.
- **2026-09-10 A03/A05/A10 real-browser tier (working tree, not yet committed):** `npm run test:browser` (Playwright 1.49.1, headless Chromium 1148, real IndexedDB + CacheStorage) — **5/5 passed** in `tests/browser/offlineOwnership.spec.mjs` against a real HTTP fixture server (`tests/browser/fixtureServer.mjs`) serving the SHIPPED `src/frontend` tree verbatim: (1) a download completing in page A releases its durable ownership row and is byte-complete; (2) a second page observes a live foreign download (`ownedByOtherContext`) and never spawns a rival writer, and resumes to `ready` after the claim releases with data intact; (3) cancel/remove refuse to delete data under a LIVE foreign claim, and proceed once the claim expires; (4) a startDownload over a live foreign claim reports the foreign state, an expired claim is re-claimed; (5) a v1 profile upgrades to v3 keeping `blobs` readable/playable/deletable with a corrupt row invisible. Debug evidence of the fixture harness: no re-download on resume (single chunk row), ownership row absent after settlement.
- **2026-09-09 A03/A05/A10 stage (working tree, not yet committed):** Production changes all in `src/frontend/js/services/offlineService.js`: DB v3 additive `operations` store (upgrade no longer deletes `blobs`); durable heartbeat-fenced ownership (`readOwnership`/`claimOwnership`/`releaseOwnership`, 4 s heartbeat / 15 s liveness); fenced chunk commits (`writeOwnedChunkTransaction`), fenced representation restart (`resetForNewRepresentation`), atomic liveness-aware fenced delete (`deleteVideoDataFenced`); startDownload registers a deferred settlement promise synchronously (cancel-vs-start race closed; a racing cancel always awaits real settlement before delete) and refuses to spawn a rival writer when a live foreign owner holds the claim; cancel/remove refuse to tear down a live foreign owner's data; legacy compat reader + playback + explicit-user-only legacy deletion (A05). New tests: `tests/offline-ownership.test.js` (13 cases: store preservation, legacy list/play/delete/corrupt-row, live-foreign start/cancel/remove refusal, expired-claim re-claim/resume/deletable, heartbeat refresh, fenced writes). Harness: `tests/helpers/offlineHarness.mjs`; `tests/offline-download.test.js` raw opens made versionless. `npm run lint` ✓ 0 problems · `npx vitest run` ✓ **18 files / 217 tests** (117 s). Shell generation regenerated (`sh-c9c6c9d4c2d7af4e`) after service content change; `tests/sw-policy.test.mjs` ✓ 9/9.

---

## Phase 1 — Local verification (automated)

From the project root:

```bash
npm ci
npm run lint              # frontend ESLint (catches undefined identifiers)
npm run typecheck         # tsc -b --noEmit
npm test                  # Vitest suite — 17 files / ~200 tests
npm run build             # TypeScript build
npm run bootstrap:runtime # idempotent pinned yt-dlp install (+ SHA-256 verify)
node scripts/ensure-runtime.mjs   # idempotent: re-hash against the receipt; run twice to
node scripts/ensure-runtime.mjs   # prove the second invocation downloads nothing
```

The Vitest suite covers: fail-closed configuration + strict `AUTH_DISABLED`
parsing (`config-failclosed`, `auth-disabled`), session auth incl. the
persistent session store (`session-auth`, `session-ttl`, `session-store` —
restart survival, epoch rotation, corruption fail-closed, capacity 503,
write-failure unavailability, revoked-cookie replay after restart),
the offline downloader contract on `fake-indexeddb` (`offline-download`),
single-flight cancellation with independent waiters + a real
SIGTERM-ignoring child fixture (`ytdlp-cancellation`), ordered shutdown
fencing (`shutdown`), the pinned-runtime installer with mocked network
(`runtime-bootstrap`), the smoke acceptance gates (`smoke`), and the
service-worker namespace-scoped cache policy (`sw-policy`).

Then start a server on a non-default port and exercise it locally
(credentials must meet the minimums: `ACCESS_KEY` ≥ 16 chars,
`SESSION_SECRET` ≥ 32 UTF-8 bytes):

```bash
PORT=3457 ACCESS_KEY=test-key-16chars-ok SESSION_SECRET=test-secret-please-change-32bytes \
  NODE_ENV=production node dist/index.js
```

Sessions persist to `.runtime/auth/sessions.json` (override:
`SESSION_STORE_PATH`). To verify restart survival: log in, stop the
server, start it again with the same `SESSION_SECRET`, and confirm the old
cookie still authenticates. Deleting that file (or a fresh Freebuff
rebuild that resets ephemeral storage) rotates the store epoch — every old
cookie is then invalid and exactly one fresh login is required. A
corrupted/malformed store file fails startup; it is never silently
replaced.

```bash
curl -s http://127.0.0.1:3457/api/health/live     # 200 {"status":"ok"}
curl -s http://127.0.0.1:3457/api/health/ready    # 200 {"status":"ready"}
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3457/api/feed/categories  # 401
# login → cookie jar → authenticated call:
curl -s -c /tmp/yt-jar -H 'content-type: application/json' \
  -d '{"key":"test-key"}' http://127.0.0.1:3457/api/session
curl -s -b /tmp/yt-jar http://127.0.0.1:3457/api/feed/categories  # 200
```

Run the smoke script against this local instance as a dry run
(`FREEBUFF_SMOKE_KEY` env var):

```bash
FREEBUFF_SMOKE_KEY=test-key node scripts/smoke.mjs http://127.0.0.1:3457
```

If YouTube is reachable from this machine it will pass end-to-end;
otherwise it reports the YouTube-egress block distinctly (see below).

### Reliability-repair verification record (this working tree)

Recorded from the F01–F31 reliability repair pass on this checkout
(Node v22.23.1, yt-dlp pinned 2026.08.19 verified by SHA-256, JS runtime
`node`). Evidence, in the order run:

| Gate | Command | Result |
| --- | --- | --- |
| Deps | `npm ci --include=dev` | clean install from lockfile |
| Lint | `npm run lint` | 0 errors (0 warnings; `--max-warnings=0`) |
| Types | `npm run typecheck` | pass (`tsc -b --noEmit`) |
| Unit/contract suite | `npm test` | **17 files / 204 tests passed** |
| Build | `npm run build` | pass (prebuild regenerates the content-derived shell manifest) |
| Runtime ensure ×2 | `node scripts/ensure-runtime.mjs` (twice) | idempotent — no re-download |
| Live boot | `PORT=3457 HOST=127.0.0.1 NODE_ENV=production ACCESS_KEY=… SESSION_SECRET=… SESSION_STORE_PATH=/tmp/test-sessions.json node dist/index.js` | session store ready, runtime verified, listening |
| Live checks | curl: `/api/health/live` · `/api/health/ready` · anonymous `/api/feed/categories` · login → authed call · `/` · `/js/shell-manifest.js` · malformed multi-range `Range: bytes=0-1,5-9` on `/api/stream/:id` | 200 · ready (yt-dlp 2026.08.19, jsRuntime node) · 401 · `{authenticated:true}` then 200 · 200 · 200 · **416** |
| Smoke (dry run) | `FREEBUFF_SMOKE_KEY=… node scripts/smoke.mjs http://127.0.0.1:3457` | **VERDICT: PASS — 16 passed, exit 0** (incl. 206 first/mid/suffix ranges, 416 malformed + unsatisfiable `bytes */TOTAL`, no signed-URL leakage, diagnostics off) |

Repair-specific regressions now covered by the suite (beyond the earlier
baseline):

- **Content-derived shell manifest (F01/F02):** generated manifest covers the
  complete executable shell (every importable module, stylesheet, self-hosted
  font, document, the worker itself — 30+ paths), every listed path exists on
  disk, and the generation id changes when shell content changes
  (`tests/sw-policy.test.mjs`).
- **Strict SW install/activate (F03):** a failed required precache rejects
  installation (no swallowed addAll), staging-cache-only cleanup, namespace-
  scoped retirement only after activation (`tests/sw-policy.test.mjs`).
- **Strict offline body reads (F07):** a read error on the EOF-confirmation
  read propagates (never fabricated `done:true`); a genuinely stalled body
  (open stream, pending pull) pauses with `timeout` through the documented
  3-attempt transient retry budget instead of hanging; cancellation during
  the EOF read still cleans up (`tests/offline-download.test.js` F07 block).

What this record does **not** prove (external by design): Freebuff ingress
Range survival, phone/Iran reachability, and YouTube's opinion of the egress
IP — run Phase 2 against the real deployed URL for those.

**What localhost proves:** the Node process boots, honors `$PORT`, serves
the UI, enforces the session, resolves ranges correctly against real
YouTube (when egress works) and the code quality gates are green.

**What localhost does NOT prove:** the external preview proxy, Range
survival through the Freebuff ingress, long-stream stability, phone/Iran
reachability, or YouTube’s opinion of the Freebuff egress IP.

---

## Phase 2 — External smoke test (the acceptance gate)

Run against the actual Freebuff URL that browsers and the Android wrapper
will use:

```bash
FREEBUFF_SMOKE_KEY="<household access key>" node scripts/smoke.mjs "https://….freebuff.app"
```

The script verifies, in order:

1. root HTML serves,
2. `/api/health/live` succeeds,
3. `/api/health/ready` succeeds (runtime prerequisites — cached, no
   extraction),
4. protected API rejects anonymous access, login issues an HttpOnly
   session cookie, the cookie authenticates,
5. authenticated search works,
6. metadata works and leaks no signed media URL,
7. thumbnail relay returns image bytes,
8. `Range: bytes=0-1023` → 206 with matching `Content-Range`,
9. a later non-zero range works,
10. suffix `bytes=-1024` works,
11. malformed Range → 416 (never a full download) and an unsatisfiable
    range → 416 `bytes */TOTAL`,
12. no response body contains `googlevideo.com`/`videoplayback`,
13. `/api/diag/*` is unavailable when `ENABLE_DIAGNOSTICS` is off.

All stream probes request tiny slices and are torn down immediately — the
smoke test never downloads a whole video.

### Reading the verdict

| Exit | Verdict | Meaning / action |
| --- | --- | --- |
| 0 | PASS | app healthy over the real ingress |
| 1 | FAIL (freebuff_ingress / auth / runtime_missing / version_mismatch / shutting_down / range_corruption) | an application-level defect — fix and re-run |
| 2 | APPLICATION HEALTHY — YouTube/EGRESS blocked | external: Freebuff’s egress IP is rejected by YouTube (or the CDN). Retries won’t fix it; a controlled proxy (`YT_PROXY_URL`) or different host is required |

`runtime_missing` means the pinned yt-dlp runtime was not established on
the deployed host — run `npm run bootstrap:runtime` there and redeploy. It
is distinct from `extraction_blocked` (YouTube rejecting the IP), which is
distinct from the client being unable to reach Freebuff at all (the script
cannot even start then).

### Failure isolation

- **Freebuff ingress unavailable** → the URL itself does not answer.
  Check the deployment/preview status and logs.
- **extraction blocked** (`Sign in to confirm you’re not a bot`, 429/403
  on `/api/search` or `/api/video/...`) → YouTube rejects the egress IP.
  This is an infrastructure property, not an app bug. Options: run on a
  host YouTube accepts, or route egress through `YT_PROXY_URL`. Confirm
  with the script’s report and move on.
- **CDN blocked** → metadata works but stream bytes fail upstream. Same
  external-egress class, reported separately by the script.
- **Range/proxy corruption through the ingress** → 206 semantics break
  only when going through the Freebuff reverse proxy even though localhost
  worked. That is a platform ingress limitation to report; the app cannot
  override behavior imposed after Node produced the response.

---

## Phase 3 — Real-device / Iran checklist (manual)

- [ ] Open the Freebuff URL in a browser and on a phone on the household
      link; confirm the Persian UI renders with **no external font/icon
      requests** (DevTools network: only same-origin + proxied media).
- [ ] Play a video; seek several times (exercises mid-file and suffix
      ranges through the ingress).
- [ ] Kill the connection mid-download of an offline video (Library →
      آفلاین), reconnect, resume — progress must continue from the last
      completed chunk, never restart from zero.
- [ ] Install the debug APK (`./build-apk.sh "https://…"`), verify
      playback, back button, offline page, and the native share sheet.
- [ ] Service-worker upgrade check in an ALREADY-USED profile (do not clear
      IndexedDB): load the app with the previous shell cached, deploy this
      release (cache generation v2 → v3), reload — the worker must update
      and the repaired JS must run. Go offline and reload (offline playback
      from existing IndexedDB chunks must still work), then restore the
      network and confirm login + a fresh download use the new
      implementation. Expect exactly one fresh login after the deployment
      (the session-store epoch is new on a rebuilt host).
- [ ] Confirm a deep link `familytube://watch?v=<11-char-id>` opens the
      app and an injected/garbage id is ignored.
- [ ] Slow-network behavior: throttle the client, start an offline download,
      drop it mid-chunk, resume — progress continues from the last
      committed chunk; a source change (re-extraction of a different
      representation) restarts at most once and then pauses with an
      explicit `SOURCE_CHANGED` error in the UI.
- [ ] Final release build: `./gradlew assembleRelease -PWEBAPP_URL="https://…"`
      — must fail when the URL is missing/HTTP/localhost (validated in
      `android/app/build.gradle`).

---

## What to record after Phase 2

Keep the smoke output plus: the deployed URL, the Node version, the
yt-dlp version (`node dist/…` readiness reports it), and the JS/EJS
runtime status. If YouTube extraction from the Freebuff egress fails,
record that as an external limitation — do not report the application as
broken (it is not) and do not “fix” it with more retries.
