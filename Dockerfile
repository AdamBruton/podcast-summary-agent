# Production image for Railway.
#
# Base: Debian slim (avoids Alpine + musl issues that can affect yt-dlp's
# bundled binaries). Node 22 LTS for parity with local development.
#
# Includes:
#   - Node + npm (from the base image)
#   - python3 + pip + yt-dlp (the latest yt-dlp version is installed via pip,
#     not apt, since the apt version lags YouTube's frequent changes by weeks)
#   - ffmpeg (for audio extraction when Whisper fallback transcription is needed)
#   - ca-certificates + tini (proper PID 1 signal handling in containers)
#
# Persistent state lives on the Railway volume mounted at /data — never
# in the image. The runtime CONFIG_DIR + DATA_DIR are computed from the
# RAILWAY_VOLUME_MOUNT_PATH env var (see src/lib/config.js).

# PIN the base image by digest — do NOT revert this to a floating
# `node:22-bookworm-slim` tag. On 2026-06-19 an unpinned rebuild silently
# drifted the Node runtime (sha256:7af03b14… → sha256:d9f85009…); the newer
# Node 22.x tore down long-lived streaming HTTPS connections to
# api.anthropic.com mid-response (ERR_STREAM_PREMATURE_CLOSE), failing 100% of
# `extract` calls and killing the daily brief for days with no code change. This
# digest is the last build that delivered briefs. Bump it DELIBERATELY (and watch
# one daily run) when you want a newer Node — never via an unpinned tag.
FROM node:22-bookworm-slim@sha256:7af03b14a13c8cdd38e45058fd957bf00a72bbe17feac43b1c15a689c029c732

# System deps. --no-install-recommends keeps the image lean.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      python3-pip \
      ffmpeg \
      ca-certificates \
      tini \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp from pip. --break-system-packages is required on Debian 12
# (PEP 668) since we're a container, not a multi-user system.
RUN pip3 install --break-system-packages --no-cache-dir yt-dlp

WORKDIR /app

# Install npm deps first (layer-cacheable).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Then copy the rest of the source.
COPY . .

# Railway sets PORT automatically. We listen on $PORT (see src/web/server.js).
# Volume gets mounted at $RAILWAY_VOLUME_MOUNT_PATH (typically /data).
EXPOSE 3000

# Use tini for clean signal handling (Express needs SIGTERM to exit fast on
# redeploy; without tini, signals can be misrouted to the Node process).
ENTRYPOINT ["/usr/bin/tini", "--"]

# Default: run the web service. Railway's cron job overrides this with
# `npm run brief` for the scheduled daily run.
CMD ["npm", "run", "web"]
