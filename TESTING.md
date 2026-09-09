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
