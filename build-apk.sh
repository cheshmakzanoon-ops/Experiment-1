#!/bin/bash
# build-apk.sh — Build the FamilyTube Android APK with the correct server URL
#
# Usage (from the project root, on a machine with JDK 17+ and an Android SDK):
#   ./build-apk.sh "https://your-server.example"
#
# The URL is baked into the APK at build time as BuildConfig.WEBAPP_URL.
# Use a public HTTPS URL — never localhost — or the phone cannot reach it.

set -e

# --- Configuration ----------------------------------------------------------
WEBAPP_URL="${1:-https://your-freebuff-preview-url.app}"

echo "=========================================="
echo "  Building FamilyTube APK"
echo "  WebApp URL: $WEBAPP_URL"
echo "=========================================="

# --- Verify prerequisites ---------------------------------------------------
echo ""
echo "Checking prerequisites..."

if ! command -v java &> /dev/null; then
  echo "❌ Java is not installed. Install JDK 17+."
  exit 1
fi

if [ ! -f android/gradlew ]; then
  echo "❌ Gradle wrapper not found (android/gradlew). Is the android/ project present?"
  exit 1
fi

if [ ! -d android/app ]; then
  echo "❌ android/app not found. Run this from the project root."
  exit 1
fi

JAVA_MAJOR=$(java -version 2>&1 | head -n1 | sed -E 's/.*version "([0-9]+).*/\1/')
if [ -n "$JAVA_MAJOR" ] && [ "$JAVA_MAJOR" -lt 17 ]; then
  echo "⚠️  Java $JAVA_MAJOR detected. JDK 17+ is recommended."
fi

if ! echo "$WEBAPP_URL" | grep -q '^https://'; then
  echo "⚠️  URL is not https:// — the APK should point at an HTTPS deployment"
  echo "   (service workers and Android WebView prefer a secure origin)."
fi

# --- Build ------------------------------------------------------------------
echo ""
echo "Building debug APK (auto-signed, installable)..."
echo ""

cd android
./gradlew clean
./gradlew assembleDebug -PWEBAPP_URL="$WEBAPP_URL"

# --- Result -----------------------------------------------------------------
APK_PATH="app/build/outputs/apk/debug/app-debug.apk"

if [ -f "$APK_PATH" ]; then
  APK_SIZE=$(du -h "$APK_PATH" | cut -f1)
  echo ""
  echo "✅ APK built successfully!"
  echo "   Location: android/$APK_PATH"
  echo "   Size: $APK_SIZE"
  echo "   URL baked in: $WEBAPP_URL"
  echo ""
  echo "Next steps:"
  echo "1. Copy the APK to the phone (USB or any messenger)."
  echo "2. On the phone enable 'Install from unknown sources' for the app you use."
  echo "3. Open the APK and install."
  echo "4. Test that the app loads and can play a video."
else
  echo "❌ APK build failed. Check the Gradle output above."
  exit 1
fi
