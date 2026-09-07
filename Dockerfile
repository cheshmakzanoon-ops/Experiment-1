# Use Node.js 20 slim as base
FROM node:20-slim

# Install yt-dlp and ffmpeg
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    ca-certificates && \
    pip3 install --no-cache-dir --break-system-packages yt-dlp && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./

# Install ALL dependencies first (build needs devDependencies, e.g. tsc)
RUN npm ci 2>/dev/null || npm install

# Copy source code
COPY . .

# Build TypeScript, then drop devDependencies to slim the image
RUN npm run build && npm prune --omit=dev

# Create non-root user
RUN useradd -m -u 1000 appuser && \
    chown -R appuser:appuser /app
USER appuser

# Expose port
EXPOSE 3000

# Health check (route is /api/health)
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://127.0.0.1:3000/api/health || exit 1

# Start the application
CMD ["node", "dist/index.js"]
