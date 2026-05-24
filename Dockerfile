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

FROM node:22-bookworm-slim

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
