# Fonts

index.html loads Vazirmatn (Persian) from Google Fonts for convenience.

**Important for the Iran deployment:** `fonts.googleapis.com` / `fonts.gstatic.com`
are blocked in Iran. Download the Vazirmatn woff2 files (OFL licensed) and place
them here, then swap the `<link>` tags in `../index.html` for `@font-face` rules
pointing at `assets/fonts/*.woff2`. The theme falls back to Roboto/system fonts
until then.
