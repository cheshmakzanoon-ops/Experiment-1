# Testing Guide — Validate Before Sending to Iran

Everything below assumes the **server is running** (open the FreeBuff preview
so the Node server is up) and uses `https://your-freebuff-url.app` as a
stand-in for your real preview URL.

> 🔑 **API key (Phase 7):** if `API_KEY` is configured, every request below
> needs it — for `curl` add `-H "X-API-Key: YOUR_KEY"`, and when opening an
> endpoint in a browser append `?key=YOUR_KEY`. Only `/api/health`,
> `/api/health/ready`, `/api/config` and `/api/video/*/thumbnail` are public.
> While `API_KEY` is unset the server logs a warning and runs open (dev mode).

> ⚠️ **Test in this exact order.** Each step isolates a different component,
> and the steps get progressively slower/riskier. Do **not** jump straight to
> "play a video" — if it fails you will not know which layer broke.

---

## Step 1 — Check the preview loads (2 minutes)

**What this tests:** can you reach the server at all?

1. Open your FreeBuff Cloud project and find the **Live Preview** URL
   (something like `https://….freebuff.app`).
2. Open it in a browser on your computer.

**Expected:** the Persian YouTube-style UI loads (dark theme, bottom nav).

**If it fails:**
- The server may have a compile/startup error — check the preview logs.
- The keepalive self-ping (`[keepalive] Ping ok …` in logs every 4 min) tells
  you the server process is alive.

---

## Step 2 — Pipeline diagnostic (2–10 minutes, THE critical test)

**What this tests:** the full yt-dlp → googlevideo.com → relay chain in one shot.Open in your browser (or `curl`):
```
https://your-freebuff-url.app/api/diag/pipeline?key=YOUR_KEY
```

**Expected:** JSON ending with
`"verdict": "FULL PIPELINE WORKS — the app should function correctly"`.

The response is a step-by-step trace. Read it like this:

| Step shows | Meaning | What to do |
| --- | --- | --- |
| `ytdlpInstalled: success:false` | yt-dlp missing from the container | Fix the image/Dockerfile (`pip install yt-dlp`) |
| `youtubeReachable: success:false` | cannot reach YouTube at all | Network/DNS issue in the sandbox — retry later |
| `extraction: success:false` + "bot"/429/403 | YouTube blocks extraction from this IP | **Critical failure** → Step 2b |
| `extraction: success:true` but `googlevideoAccessible: success:false` + 403/429 | Extraction works but video-stream CDN blocks us | **Critical failure** → Step 2b |
| everything true | Pipeline works | Continue to Step 3 |

### Step 2b — If YouTube is blocking

Find out what kind of block and what IP you are on:

```
https://your-freebuff-url.app/api/diag/blocking-status?key=YOUR_KEY
https://your-freebuff-url.app/api/diag/ip?key=YOUR_KEY
https://your-freebuff-url.app/api/diag/ytdlp-verbose?v=dQw4w9WgXcQ&key=YOUR_KEY
https://your-freebuff-url.app/api/diag/potoken?key=YOUR_KEY
```

- `blocking-status` names the block type and the workarounds available.
- `ip` shows the egress IP and flags cloud-provider ranges (AWS/GCP/Oracle…)
  — YouTube blocks those most aggressively.
- `ytdlp-verbose` shows the raw yt-dlp log for one video (look for
  "Sign in to confirm you're not a bot", HTTP 429/403).

**Workarounds to try, in order:**
1. `/api/diag/workaround-extract?v=dQw4w9WgXcQ&quality=240&key=YOUR_KEY` —
   runs the workaround ladder (client rotation → explicit android/mweb).
2. Check `/api/diag/potoken` — since Phase 7 the app auto-generates PO
   tokens when the bgutil provider is installed (see POTOKEN.md); otherwise
   set a **manual token pair** (`YT_PO_TOKEN` + `YT_VISITOR_DATA`) via the
   FreeBuff env/keys UI.
3. Re-run `/api/diag/pipeline` after a few minutes (rate limits often expire).
4. If all of that fails you are IP-blocked for real → **Plan B** at the bottom.

---

## Step 3 — Search (1 minute)

```
https://your-freebuff-url.app/api/search?q=music
```

**Expected:** JSON with `results: [...]` (titles + 11-char ids).

**If it fails:** YouTube is likely blocking search too — see Step 2b.

---

## Step 4 — Streaming round-trip (2–10 minutes)

**What this tests:** our own `/api/stream` endpoint actually delivering bytes
(the thing the video player uses). This is a self-test — the server fetches
its own URL, so it also proves the server can serve concurrent requests.

```
https://your-freebuff-url.app/api/diag/stream-test
```

**Expected:**
```json
"status": 206,
"assessment": "Stream is working — the app should be able to play videos"
```

**If it fails with 429/403:** YouTube is blocking stream access from this IP.

---

## Step 5 — Playback in the UI (5 minutes)

1. Open `https://your-freebuff-url.app` in your browser.
2. Search for something Persian (e.g. `آشپزی`) or scroll the home feed.
3. Open a video. Does the player appear? Does it start after buffering?
4. Try seeking (drag the progress bar) — a 206/`Content-Range` relay means
   seeks work.

**If it doesn't play:** check the browser console; then run
`/api/diag/pipeline` again and compare. A working pipeline + failing player
means a frontend bug, not a YouTube block.

---

## Step 6 — Phone test on WiFi (5 minutes, from Canada)

1. Open the same URL on your phone (Canada, on WiFi).
2. Search + play a video. Confirm it still works on a slower mobile browser.

---

## Step 7 — Test from Iran (when your parents are awake)

Send a short message, e.g.:

> "Mom, open this website in Chrome on your phone: [URL]. Can you search for
> a video? Can you play it?"

**What may fail from Iran (not server bugs):**
- The FreeBuff URL itself may be blocked by Iranian ISPs (this project
  assumes the household already reaches the deployment — if not, the domain
  needs to be one that is reachable).
- A slow/saturated link (this app targets 1–2 Mbps — 240p streams are small).
- googlevideo.com being blocked — that is exactly why **everything** is
  proxied through this server, so it should not matter.

---

## Step 8 — Build the APK (only after the web version works from Iran)

```bash
./build-apk.sh "https://your-freebuff-url.app"
# → android/app/build/outputs/apk/debug/app-debug.apk
```

Copy that APK to the phone, enable "install from unknown sources", install.
Full build/signing notes: `android/README.md`.

> **Important:** the URL is baked in at build time. If the preview URL ever
> changes you must rebuild the APK with the new URL. For a long-lived APK,
> point `WEBAPP_URL` at a stable HTTPS deployment, not a dev preview.

---

## Quick reference: diagnostic endpoints

| Endpoint | Purpose |
| --- | --- |
| `/api/diag/pipeline` | full pipeline test — run this first |
| `/api/diag/ip` | egress IP + datacenter detection |
| `/api/diag/ytdlp-verbose` | raw verbose yt-dlp log for one video |
| `/api/diag/stream-test` | round-trip through our own `/api/stream` |
| `/api/diag/blocking-status` | which YouTube block type is active |
| `/api/diag/workaround-extract` | run the workaround ladder for one video |
| `/api/diag/potoken` | PO-token provider status + token preview |
| `/api/diag/report` | everything above combined into one verdict |
| `/api/diag/sandbox` | keepalive / bandwidth / sandbox health |
| `/api/health` | basic liveness |
| `/api/search?q=X` | search |
| `/api/stream/VIDEO_ID` | stream a video (what the player calls) |

`/api/diag/report` can take up to ~2.5 minutes when YouTube is throttling —
give it time before refreshing.

---

## Plan B — if FreeBuff's IP stays blocked

If `/api/diag/pipeline` keeps failing with bot/403 blocks after all
workarounds, the sandbox IP is the problem, not the code. Options:

### Option 1 — Oracle Cloud Free Tier (recommended next step)
- 4 ARM cores / 24 GB RAM / 10 TB egress per month, $0.
- Different IP ranges than FreeBuff's cloud provider — frequently not yet
  flagged by YouTube.
- Requires a credit card for signup + a bit of terminal work; then deploy
  this repo with Docker and re-run the same diagnostics against that URL.

### Option 2 — Cloudflare Workers / hybrid
- Great for metadata/search (100k req/day free) but **cannot** relay video
  streams (response size limits) — would need a second hop for `/api/stream`.

### Option 3 — Home server (most reliable, most technical)
- Run the proxy on an always-on computer at the family's place or yours
  (residential IPs are not datacenter-flagged).
- Needs port forwarding + dynamic DNS; Dockerfile is ready to go.
