# Secondary deployment route — the PRIMARY runtime is Freebuff Cloud, which
# clones the repo, installs dependencies and runs the repo's own scripts.
# This image uses the SAME runtime strategy as Freebuff: the pinned official
# yt-dlp standalone binary is bootstrapped into .runtime/bin/ (gitignored)
# and verified by SHA-256 — no pip, no Python, no ffmpeg, no Chromium needed.
# The app selects a single progressive media URL and byte-relays it, so
# ffmpeg is not required anywhere in the pipeline.

FROM node:22-slim

# A health check later and the Node runtime itself are the only runtime
# needs; keep the image minimal.
ENV NODE_ENV=production

WORKDIR /app

# Install dependencies FIRST so the layer cache survives source changes.
# `npm ci` fails hard on a lockfile mismatch — never fall back to install.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Copy the source tree (node_modules/dist/.runtime excluded via .dockerignore).
COPY . .

# Bootstrap the pinned yt-dlp standalone binary (idempotent, SHA-256
# verified). Node 22 provides the modern EJS/js-runtime for yt-dlp's
# JavaScript challenges via `--js-runtimes node` in the centralized runner.
RUN npm run bootstrap:runtime && npm run build

# Run as a non-root user.
RUN useradd -m -u 1000 appuser && \
    chown -R appuser:appuser /app
USER appuser

EXPOSE 3000

# Health check honors $PORT (default 3000) — does not assume a fixed port.
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# `npm start` runs the idempotent `prestart` runtime verification first,
# then the compiled server (which itself fails readiness precisely when the
# runtime is missing — never a later ENOENT storm on user requests).
CMD ["npm", "start"]
