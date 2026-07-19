#!/bin/sh
# Quran Hakim mini-app container entrypoint. Runs BOTH the zero-dependency Node
# API (loopback :8787) and nginx (:8080) in a single lean image. Busybox-sh
# compatible (no bash-only builtins).
set -eu

# Non-root writable temp dirs for nginx (pid + proxy/client temp paths).
mkdir -p /tmp/nginx/client_temp /tmp/nginx/proxy_temp /tmp/nginx/fastcgi_temp \
         /tmp/nginx/uwsgi_temp /tmp/nginx/scgi_temp

# Substitute the runtime-configurable external audio origin into the config.
AUDIO_ORIGIN="${JOOW_AUDIO_ORIGIN:-https://quranner.com}"
sed "s|__JOOW_AUDIO_ORIGIN__|${AUDIO_ORIGIN}|g" \
    /etc/nginx/nginx.conf.template > /tmp/nginx/nginx.conf

# Start the Node API in the background, then run nginx in the foreground so the
# container's lifecycle tracks nginx (and /health, which proxies to the API).
node /app/backend/server.mjs &
exec nginx -c /tmp/nginx/nginx.conf
