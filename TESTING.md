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
npm test                  # Vitest suite (Range, auth, URL safety, feeds, yt-dlp)
npm run build             # TypeScript build
npm run bootstrap:runtime # idempotent pinned yt-dlp install (+ SHA-256 verify)
```

Then start a server on a non-default port and exercise it locally:

```bash
PORT=3457 ACCESS_KEY=test-key SESSION_SECRET=test-secret-please-change \
  NODE_ENV=production node dist/index.js
```

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
| 1 | FAIL (freebuff_ingress / auth / runtime_missing / range_corruption) | an application-level defect — fix and re-run |
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
- [ ] Confirm a deep link `familytube://watch?v=<11-char-id>` opens the
      app and an injected/garbage id is ignored.
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
