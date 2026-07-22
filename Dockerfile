# Quran Hakim — production mini-app image for the JooW apphost mount.
#
# Build context is apps/joowquran/ (this dir), because the image needs BOTH the
# SPA (web/) and its zero-dependency Node API (backend/server.mjs):
#
#   docker build -f apps/joowquran/Dockerfile \
#     --build-arg VITE_JOOW_HOST_ORIGIN=https://stage.joow.org \
#     -t ghcr.io/shooji-senex/joow-app-quranhakim:dev apps/joowquran
#
# The result is a single lean image listening on :8080 that
#   • serves the built SPA (dist/) statically, base-pathed at the mount
#     /api/joow/apps/quranhakim/ (the apphost mount strips that prefix, so the
#     container serves at root),
#   • reverse-proxies /api/*  -> the Node API (backend/server.mjs, 127.0.0.1:8787),
#   • reverse-proxies the heavy media prefixes (recitation/tafsir/…) -> an
#     EXTERNAL origin (JOOW_AUDIO_ORIGIN) so multi-GB audio is NEVER baked in,
#   • answers /health with 200 for the container/mount health probe.

# ---- Stage 1: build the SPA -------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app/web
# Install deps first for layer caching. The vendored @joow/sdk (a file: dep)
# MUST be present before `npm ci`, so copy it with the manifests.
COPY web/package.json web/package-lock.json ./
COPY web/vendor ./vendor
RUN npm ci
COPY web/ ./
# The reader's App.jsx imports the shared theme from the parent dir
# (../../joow-app-theme.css → /app/joow-app-theme.css, one level above WORKDIR).
COPY joow-app-theme.css /app/joow-app-theme.css
# Mount base is fixed; audio + host origin are build-configurable.
#   VITE_AUDIO_BASE=""  -> same-origin: /api + audio resolve under the mount
#                          (nginx below proxies /api -> node, media -> external).
#   VITE_AUDIO_BASE=https://quranner.com -> audio + /api go straight to that origin.
ARG VITE_AUDIO_BASE=""
ARG VITE_JOOW_HOST_ORIGIN=""
ENV VITE_AUDIO_BASE=$VITE_AUDIO_BASE
ENV VITE_JOOW_HOST_ORIGIN=$VITE_JOOW_HOST_ORIGIN
RUN npx vite build --base=/api/joow/apps/quranhakim/

# ---- Stage 2: runtime (nginx static + api proxy + node API) -----------------
FROM node:20-alpine AS runtime
RUN apk add --no-cache nginx wget
WORKDIR /app
# The Node API is dependency-free (node stdlib only), so no npm install here.
COPY backend/ ./backend/
COPY --from=build /app/web/dist ./dist/
COPY web/deploy/nginx.conf.template /etc/nginx/nginx.conf.template
COPY web/deploy/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh \
 && mkdir -p /tmp/nginx \
 && chown -R node:node /app /tmp/nginx /var/lib/nginx /var/log/nginx

# The Node API reads surah/tafsir metadata from the served SPA root; heavy audio
# assets live off-image on JOOW_AUDIO_ORIGIN. ELEVENLABS/ANTHROPIC/SESSION keys
# are unset here (generation + the reader's own auth degrade gracefully — the
# shell owns identity when framed).
ENV WEBROOT=/app/dist \
    PORT=8787 \
    TZ=UTC \
    JOOW_AUDIO_ORIGIN=https://quranner.com \
    NODE_ENV=production

# Numeric, non-root UID is MANDATORY: the JooW apphost's validateContainerUser
# refuses a named user, because an image-controlled /etc/passwd could remap the
# name to uid 0. Everything the container writes lives under the /tmp tmpfs
# (see docker-entrypoint.sh), and /app + /app/dist are world-readable, so the
# uid need not own them.
USER 1001
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=8s --retries=5 \
  CMD wget -qO- http://127.0.0.1:8080/health >/dev/null 2>&1 || exit 1
CMD ["/docker-entrypoint.sh"]
