# FamilyTube Android WebView wrapper

A small Gradle project (Kotlin, API 26+, AGP 8.2) that wraps the web app in
a full-screen WebView — a real home-screen «ویدیو» app for non-technical
family members. Built from the command line (no Android Studio) with a JDK
17+ and an Android SDK.

## Security model (read before changing anything)

The wrapper is hardened around one rule: **the only page ever allowed to
render inside the bridge-enabled WebView is the trusted origin baked in at
build time** (`BuildConfig.WEBAPP_URL`).

- **Navigation** (`FamilyWebViewClient`): same trusted origin stays in the
  WebView; any other http(s) main-frame URL opens in the system browser;
  off-origin sub-frames are blocked; unknown/non-web schemes are rejected.
  No substring matching (`host.contains(...)`) is used as a trust decision.
- **JS bridge** (`window.AndroidBridge`): every method that touches native
  capabilities (download, share, storage info, cache clear, persistence)
  verifies the current main frame is the trusted origin before acting.
  Only the cosmetic toast and `reloadApp()` (which always reloads the
  trusted URL) are ungated.
- **Native download**: the bridge never trusts a caller-supplied URL — it
  validates the video id against the exact YouTube id shape
  (`^[A-Za-z0-9_-]{11}$`) and rebuilds the URL from the trusted origin:
  `{origin}/api/stream/{videoId}?quality=240`.
- **Deep links**: the manifest pins `familytube://watch/…` to host
  `watch`; `MainActivity` validates the `v` parameter against the id shape
  before storing it, and it is inserted into JavaScript only through JSON
  quoting (`AppSecurity.jsQuote`) — raw payloads can never execute.
- **Transport**: release builds are HTTPS-only — `usesCleartextTraffic` is
  off, `MIXED_CONTENT_NEVER_ALLOW`, the network-security config trusts only
  system CAs and has **no** wildcard domains. Debug builds add a
  localhost/emulator cleartext exception via `src/debug/` only.
- **Release URL validation** (`app/build.gradle`): release tasks **fail**
  when `WEBAPP_URL` is missing, not HTTPS, has a malformed host, or embeds
  credentials. Debug builds accept http only for local dev hosts
  (`localhost`, `127.0.0.1`, `10.0.2.2`).

## Building

```bash
# Debug APK (auto-signed, installable) — any https URL or local dev http:
./gradlew assembleDebug -PWEBAPP_URL="https://your-server.example"
# → app/build/outputs/apk/debug/app-debug.apk

# Release APK (requires signing properties; HTTPS URL enforced):
./gradlew assembleRelease -PWEBAPP_URL="https://your-server.example" \
  -PSTORE_FILE=/path/to/keystore.jks -PSTORE_PASSWORD=… \
  -PKEY_ALIAS=… -PKEY_PASSWORD=…
# → app/build/outputs/apk/release/app-release.apk
```

From the repository root a convenience script exists:
`./build-apk.sh "https://your-server.example"`.

Set the URL for repeated builds in `android/gradle.properties`
(`WEBAPP_URL=…`), or always pass `-PWEBAPP_URL`. Point it at the public,
always-on Freebuff deployment — never a throwaway preview.

### Unit tests

The security helpers are pure JVM (`AppSecurity.kt`, no Android classes)
so they run without an emulator:

```bash
./gradlew testDebugUnitTest
```

Covers video-id validation (incl. injection payloads), trusted-origin
parsing, lookalike/suffix-host rejection, scheme rules, JS-quoting
escaping, and label bounding.

## What the wrapper provides

- Full-screen WebView host, portrait-locked, screen kept on while watching.
- Back button walks WebView history, then asks «خروج از برنامه؟».
- Persian «اینترنت قطع است» offline page with a retry button; auto-reload
  on reconnect (`NetworkMonitor`).
- JS bridge: `showToast`, `isNetworkAvailable`, `downloadVideo`,
  `getStorageInfo`, `clearAppCache`, `requestPersistentStorage`,
  `shareVideo`, `reloadApp` — used by `src/frontend/js/utils/nativeApp.js`.
- Deep links `familytube://watch?v=<11-char id>` open the watch hash on the
  trusted page.

## Real-device checklist

- [ ] Install the debug APK pointed at the real URL; the Persian UI loads
      with zero external font/icon requests.
- [ ] Watch + seek a video (Range through the real ingress).
- [ ] Airplane mode → «اینترنت قطع است»; reconnect → auto-reload.
- [ ] Download an offline video in Library → آفلاین, drop the connection
      mid-download, resume — progress continues, not restarts.
- [ ] `familytube://watch?v=abc123` (valid id) opens; garbage/injected
      payloads are ignored and never run JavaScript.
- [ ] A release build with a missing/HTTP/localhost `WEBAPP_URL` fails the
      build.
- [ ] `adb logcat` shows no WebView navigation to non-trusted origins.

## Known platform notes

- Android WebView does not support service workers, so `sw.js` shell
  caching is inactive inside the wrapper — IndexedDB offline downloads
  still work (chunked, resumable).
- The debug APK has a `.debug` application-id suffix, so debug and release
  builds can coexist on one device.
- Cleartext exceptions exist only under `src/debug/`; a release APK cannot
  talk to plain-HTTP hosts by construction.
