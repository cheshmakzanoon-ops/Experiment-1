# PO Token Setup Guide

## What is a PO token?

YouTube requires Proof-of-Origin (PO) tokens for requests coming from
datacenter IPs. Without one, yt-dlp extraction often fails with
`Sign in to confirm you're not a bot` or HTTP 429/403. A PO token proves the
request originates from a "real" browser session; the token is paired with a
`visitorData` value.

## How this app uses tokens

Two independent paths feed tokens to yt-dlp:

1. **Env pair (legacy path, always honored).** When `YT_PO_TOKEN` and
   `YT_VISITOR_DATA` are set, `src/utils/ytDlp.ts` passes
   `--extractor-args "youtube:po_token=web+TOKEN+VISITOR_DATA"` on the
   default (web) extraction attempt. This works on every yt-dlp build that
   understands the `po_token` extractor arg.
2. **Auto-generation (bgutil provider).** The app talks to a
   `bgutil-ytdlp-pot-provider` HTTP **provider server**
   (`src/services/potoken/generator.ts`) and:
   - refreshes a `{token, visitorData}` pair every 4 hours and writes it into
     `YT_PO_TOKEN` / `YT_VISITOR_DATA` (so the legacy path above always has a
     fresh pair), and
   - the **plugin** (pip) makes modern yt-dlp (≥ 2025.05.22) fetch tokens
     from that same server on its own during extraction.

Both paths degrade gracefully: no provider, no Chromium, or a generation
timeout only means extraction runs without a token (and may be blocked).

## Automatic setup (recommended)

### 1. Provider server (must run somewhere reachable)

The provider is the project
[Brainicism/bgutil-ytdlp-pot-provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider).
It is **not** distributed on npm. Pick one:

- **Sidecar Docker image (easiest).** Uncomment the `pot-provider` service in
  `docker-compose.yml` — it runs `brainicism/bgutil-ytdlp-pot-provider`
  inside the app's network namespace on `http://127.0.0.1:4416` (the app's
  default). Chromium is already in the app image; the provider image brings
  its own.
- **Standalone container / host.** Run the provider yourself and point the
  app at it:
  ```bash
  docker run -d --name bgutil-provider --init -p 127.0.0.1:4416:4416 \
    brainicism/bgutil-ytdlp-pot-provider
  # then set:  YT_PO_PROVIDER_URL=http://127.0.0.1:4416
  ```
- **Built from source (no Docker).** Clone the repo, build the server, and
  either keep its binary on PATH (the app spawns it on boot) or run it
  manually:
  ```bash
  git clone --depth 1 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git
  cd bgutil-ytdlp-pot-provider/server
  npm ci && npx tsc
  node build/main.js --port 4416
  ```

### 2. Provider plugin (lets yt-dlp fetch tokens itself)

The Dockerfile installs yt-dlp and the plugin from pip, which modern yt-dlp
auto-discovers:

```bash
pip3 install --no-cache-dir yt-dlp bgutil-ytdlp-pot-provider
yt-dlp -v <URL>   # verbose output should list "PO Token Providers: bgutil:…"
```

### 3. Check status

```
GET /api/diag/potoken     (requires API key — add ?key=… or X-API-Key header)
```

It reports the token mode (`env` | `provider` | `none`), whether the provider
is reachable, expiry time, and (when reachable) a freshly minted pair.

On a healthy boot the server logs show:

```
[potoken] Provider reachable at http://127.0.0.1:4416
[potoken] Initial PO token generated
```

### Provider tuning

- Default endpoint is `http://127.0.0.1:4416`; override with
  `YT_PO_PROVIDER_URL` (sidecar on another host, custom port, …). When the
  URL is non-default the app never tries to spawn its own provider.
- Tokens expire after ~6 hours; the app refreshes every 4 hours
  (`REFRESH_INTERVAL_MS` in `src/services/potoken/generator.ts`).
- First generation after boot can be slow (Chromium warm-up); re-check
  `/api/diag/potoken` after a minute on small VPSes.

## Manual setup (alternative)

If no provider is available on your host:

1. Generate a token pair with any provider you have access to.
2. Set the pair in the environment (FreeBuff → Keys/API keys UI, or `.env`):

   ```bash
   export YT_PO_TOKEN="generated_token_here"
   export YT_VISITOR_DATA="generated_visitor_data_here"
   ```

3. Restart the server. Extraction now sends the token on web-client
   attempts; `GET /api/diag/potoken` shows `mode: "env"`.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `[potoken] bgutil provider failed to start: spawn ENOENT` | Provider binary not on PATH | Use the docker sidecar or clone+build the provider (see above) |
| `[potoken] …started but did not become reachable… is Chromium installed?` | Chromium missing/crashed | Install `chromium` + deps (the Dockerfile does); check provider logs |
| `/api/diag/potoken` → `provider not reachable` | Provider down or `YT_PO_PROVIDER_URL` wrong | Confirm `curl http://127.0.0.1:4416/ping` from the container |
| Tokens exist but YouTube still blocks | Token stale or IP still flagged | Watch `/api/diag/potoken` expiry; consider residential egress |
| No PO token configured at all | Provider not installed / env not set | Extraction still attempts; expect possible bot-wall until a token is present |
| `yt-dlp -v` shows no `bgutil:` providers | Plugin not discovered | Reinstall the pip plugin into the same environment as yt-dlp and confirm yt-dlp ≥ 2025.05.22 |

> Note: providing a PO token does **not** guarantee a bypass — YouTube also
> considers IP reputation, cookies and client. For a stubborn datacenter IP,
> combine tokens with residential egress (Plan B in TESTING.md).
