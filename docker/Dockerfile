FROM node:24.21.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS base

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

# Development (compose.dev.yml): the source is mounted over /app and run with tsx
FROM base AS dev
# better-sqlite3 falls back to compiling its binding when no prebuilt one matches
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
CMD ["sh", "/app/docker/dev-entrypoint.sh"]

FROM dev AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build

FROM dev AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM base

ENV NODE_ENV=production \
    PORT=3000

COPY --from=prod-deps --chown=node:node /app/node_modules node_modules
COPY --from=build --chown=node:node /app/dist dist
COPY --from=build --chown=node:node /app/public public
COPY --chown=node:node resources/views resources/views
COPY --chown=node:node package.json ./
COPY --chown=node:node docker/entrypoint.sh /entrypoint.sh

# Imports waiting for a decision, finished exports, logs and the generated APP_KEY
RUN mkdir -p storage/app/private storage/logs && chown -R node:node storage
VOLUME /app/storage

USER node

EXPOSE 3000

ENTRYPOINT ["sh", "/entrypoint.sh"]
