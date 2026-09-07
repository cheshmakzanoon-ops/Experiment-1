# FamilyTube — Android WebView wrapper

A tiny native Android shell around the Persian YouTube client web app. It
gives your mom a real home-screen app («ویدیو») instead of a browser
bookmark: full-screen WebView (no address bar), portrait lock, back button
walking the WebView history, a Persian «اینترنت قطع است» page when the
server is unreachable, auto-reload when connectivity returns, native share
sheets, and a JS bridge (`window.AndroidBridge`) for network status, storage
and toasts.

- **minSdk 26** (Android 8.0) — works on low-end phones running Android 8–13+
- **No Android Studio required** — plain Gradle from a terminal
- **No YouTube SDK / API keys** — everything is proxied by our own backend,
  the same as the browser app
- APK is a few MB (it is just a WebView wrapper around the web app)

> ⚠️ **Android WebView cannot run service workers.** The app shell/thumbnail
> caching done by `sw.js` in a normal browser is therefore inactive inside
> the wrapper. Offline **downloads** still work (they stream through the
> `/api/stream` proxy into IndexedDB and play back from a local Blob), and
> the WebView's own HTTP cache helps on repeat visits.

---

## 1. Before building: set the web app URL

The APK has the server URL baked in at build time as `BuildConfig.WEBAPP_URL`
(it must point at the **public, always-on deployment** of this app — the
address your mom's phone can reach from home, e.g. `https://family.example`).

| Method | Command / file |
| --- | --- |
| Root helper script (recommended) | `./build-apk.sh "https://your-server.example"` (from the repo root — checks prerequisites, cleans, builds) |
| Gradle property | `cd android && ./gradlew assembleDebug -PWEBAPP_URL="https://your-server.example"` |
| `gradle.properties` | uncomment `WEBAPP_URL=https://your-server.example` |
| Default (dev only) | `http://localhost:3000` |

The network security config
(`app/src/main/res/xml/network_security_config.xml`) trusts system CAs for
HTTPS and additionally permits cleartext HTTP for `localhost`, `10.0.2.2`,
`127.0.0.1` and the preview hosts listed there. If your server is **HTTP**
(not HTTPS), add its host to the cleartext `<domain>` list.

## 2. Prerequisites (one-time)

- **JDK 17+** (`java -version`)
- **Android SDK**: set `ANDROID_HOME` (or `ANDROID_SDK_ROOT`) to an SDK with
  `platforms;android-34` and `build-tools;34.0.0` installed. Example:

  ```bash
  wget https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
  unzip -q commandlinetools-linux-11076708_latest.zip -d sdk
  yes | sdk/cmdline-tools/bin/sdkmanager --sdk_root="$PWD/sdk" --licenses > /dev/null
  sdk/cmdline-tools/bin/sdkmanager --sdk_root="$PWD/sdk" "platforms;android-34" "build-tools;34.0.0"
  export ANDROID_HOME="$PWD/sdk"
  ```

  No `local.properties` is needed if `ANDROID_HOME` is exported.

## 3. Build

### Quick build (with the repo-root script)

From the project root (after the web app has been validated — see
`TESTING.md`):

```bash
chmod +x build-apk.sh     # first time only
./build-apk.sh "https://your-server.example"
```

The script checks that `java`, the Gradle wrapper and the `android/` project
are present, cleans, builds the debug APK with your URL baked in, and prints
where the APK landed.

### Manual build

```bash
cd android
chmod +x gradlew          # first time only (already set in this repo)

# Debug APK — auto-signed with the debug key, installable as-is.
# Ideal for a personal sideload for family.
./gradlew assembleDebug -PWEBAPP_URL="https://your-server.example"
# → app/build/outputs/apk/debug/app-debug.apk

# Release APK (unsigned unless you sign — see below).
./gradlew assembleRelease -PWEBAPP_URL="https://your-server.example"
# → app/build/outputs/apk/release/app-release-unsigned.apk
```

The first run downloads Gradle 8.5 (~130 MB) and the Android build tools, so
it takes a while.

### Without an Android SDK locally (Docker)

```bash
cd android
docker run --rm \
  -v "$(pwd)":/project \
  -v "$HOME/.gradle":/root/.gradle \
  -w /project \
  -e ANDROID_HOME=/opt/android-sdk \
  mingc/android-build-box:latest \
  bash -c "chmod +x gradlew && ./gradlew assembleDebug -PWEBAPP_URL=\"https://your-server.example\""
```

## 4. Signing (only if you build `release`)

Android refuses to install **unsigned** APKs, so for sideloading either use
the debug APK above or sign a release APK once:

```bash
# Generate a keystore (once, keep it safe — you need it for every update)
keytool -genkey -v -keystore familytube.keystore -alias familytube \
  -keyalg RSA -keysize 2048 -validity 10000

# Build a signed release APK
./gradlew assembleRelease \
  -PWEBAPP_URL="https://your-server.example" \
  -PSTORE_FILE=familytube.keystore \
  -PSTORE_PASSWORD=changeit \
  -PKEY_ALIAS=familytube \
  -PKEY_PASSWORD=changeit
# → app/build/outputs/apk/release/app-release.apk  (installable)
```

A signed APK is also what you need if you ever want to publish via Play
(optional; sideloading is simpler for a private family app). Debug builds
share one debug keystore, so they are fine for personal use but not for
distributing updates later — use the release + keystore flow once the app is
"done".

## 5. Install on the phone

1. Copy the APK to the phone (USB cable, or send the file via any messenger).
2. On the phone: Settings → Security → «نصب برنامههای ناشناس» → allow your
   file manager / messenger.
3. Open the APK and tap «نصب».

## 6. Updating

The web app auto-updates on the server; the wrapper shows the new version on
its next launch. You only build a new APK when you change the wrapper code,
the URL, the icon, or the app name. Bump `versionCode`/`versionName` in
`app/build.gradle` each time you rebuild a signed APK.

---

## Project layout

```
android/
├── build.gradle / settings.gradle / gradle.properties   # Gradle config
├── gradlew / gradlew.bat / gradle/wrapper/              # Gradle 8.5 wrapper
└── app/
    ├── build.gradle            # WEBAPP_URL property, SDK 26–34, signing hooks
    ├── proguard-rules.pro      # keeps the JS bridge + WebView client
    └── src/main/
        ├── AndroidManifest.xml
        ├── java/com/familytube/
        │   ├── MainActivity.kt           # WebView host, back button, JS bridge
        │   ├── WebViewClient.kt          # FamilyWebViewClient: offline page,
        │   │                              #   tracker blocking, wrapper flag
        │   ├── NetworkMonitor.kt         # connectivity callbacks + isConnected
        │   ├── DownloadManagerBridge.kt  # future native downloads (DownloadManager)
        │   └── OfflineStorageHelper.kt   # storage info / cache clear for the bridge
        └── res/
            ├── values*/ strings.xml (fa + en), colors, styles, dimens
            ├── drawable/       # adaptive icon layers + splash background
            ├── mipmap-anydpi-v26/  # ic_launcher (+ round)
            ├── layout/activity_main.xml
            └── xml/network_security_config.xml
```

## JS bridge API (exposed to the web app as `window.AndroidBridge`)

Web-side usage lives in `src/frontend/js/utils/nativeApp.js`; the wrapper
signals readiness by setting `window.AndroidWrapper` and dispatching
`android-wrapper-ready` after each page load.

| Method | Returns | Purpose |
| --- | --- | --- |
| `showToast(message)` | – | native toast |
| `isNetworkAvailable()` | `boolean` | ConnectivityManager-based |
| `requestPersistentStorage()` | `boolean` | keep IndexedDB downloads safe |
| `getStorageInfo()` | JSON string | free space in the app dirs |
| `shareVideo(title, url)` | – | system share sheet |
| `downloadVideo(id, title, url)` | `boolean` | (future) DownloadManager copy |
| `clearAppCache()` | `boolean` | free space by clearing WebView cache |
| `reloadApp()` | – | used by the Persian offline page's retry button |

## What to check on a real phone

- [ ] App icon «ویدیو» appears in the launcher; app opens straight to the web app.
- [ ] Back button goes back inside the app; on the home view it asks «خروج از برنامه؟».
- [ ] Airplane mode → Persian «اینترنت قطع است» page; reconnect → auto-reloads.
- [ ] Watch a video, press Home, reopen — playback/downloads persist.
- [ ] ⋮ menu → «اشتراکگذاری» opens the native share sheet.
- [ ] Downloads in Library → «آفلاین» work while offline (IndexedDB).
