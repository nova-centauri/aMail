ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim AS build

WORKDIR /app

# better-sqlite3-multiple-ciphers (SQLite with SQLCipher-compatible encryption)
# ships prebuilt binaries for common platforms; these build dependencies make
# the image reliable when npm has to compile the addon instead.
COPY package.json package-lock.json ./
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && npm ci \
    && rm -rf /var/lib/apt/lists/*

COPY . ./
RUN npm run build \
    && npm prune --omit=dev


FROM node:${NODE_VERSION}-bookworm-slim AS runtime

ARG APP_UID=10001
ARG APP_GID=10001

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    AMAIL_DATA_DIR=/data \
    AMAIL_STATIC_DIR=/app/dist

WORKDIR /app

# A non-empty, owned directory lets Docker initialize a new named volume with
# the correct ownership before the non-root process starts.
RUN groupadd --gid "${APP_GID}" amail \
    && useradd --uid "${APP_UID}" --gid amail --no-create-home \
      --home-dir /nonexistent --shell /usr/sbin/nologin amail \
    && mkdir -p /data \
    && touch /data/.volume-owner \
    && chown -R amail:amail /data

COPY --chown=amail:amail --from=build /app/package.json /app/package-lock.json ./
COPY --chown=amail:amail --from=build /app/node_modules ./node_modules
COPY --chown=amail:amail --from=build /app/dist ./dist
COPY --chown=amail:amail --from=build /app/server ./server

USER amail

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '3000') + '/api/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["npm", "start"]
