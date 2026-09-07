# Fonts (self-hosted)

The household UI must render without Google-hosted fonts/icons or any other
external CDN, so the fonts are served from this same origin
(`src/frontend/styles/fonts.css`).

| File | Family | License | Source |
| --- | --- | --- | --- |
| `Vazirmatn-{Regular,Medium,Bold}.woff2` | Vazirmatn | OFL-1.1 | rastikerdar/vazirmatn (`fonts/webfonts/`) |
| `MaterialIconsRound-Regular.woff2` | Material Icons Round | Apache-2.0 | fonts.gstatic.com (Material Icons Round v109) |

To update a font: replace the file(s) above and keep the filenames, or edit
`styles/fonts.css`. Nothing else in the app references external font hosts.

Do not add runtime references to fonts.googleapis.com / fonts.gstatic.com —
the Persian network may block them and the service worker must never depend
on third-party assets for the core UI.
