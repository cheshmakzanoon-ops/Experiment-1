# --- R8 / ProGuard rules for the FamilyTube WebView wrapper -----------------
#
# Release builds use minifyEnabled + shrinkResources. These rules keep the
# classes that are reached reflectively (the JS bridge and the WebView client
# subclass) so R8 does not strip or rename them.

# The JavaScript bridge: methods are invoked from JavaScript by name through
# addJavascriptInterface("AndroidBridge"). Keep every public method (the
# ones annotated @JavascriptInterface).
-keepclassmembers class com.familytube.MainActivity$JavaScriptBridge {
    public *;
}

# WebViewClient subclass instantiated in MainActivity and overridden methods
# dispatched by the Android framework (virtual dispatch — safe to keep all).
-keep class com.familytube.FamilyWebViewClient { *; }

# Don't warn about missing classes from the web app / JVM backports.
-dontwarn java.nio.file.**
-dontwarn org.jetbrains.annotations.**
