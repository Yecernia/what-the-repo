FROM node:24.14.0-trixie-slim AS build

WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY server/tsconfig.json ./
COPY server/src ./src
COPY server/migrations ./migrations
RUN npm run build && npm prune --omit=dev

FROM node:24.14.0-trixie-slim

ENV NODE_ENV=production \
    WHAT_THE_REPO_ROOT=/app \
    WHAT_THE_REPO_DATA_DIR=/var/lib/what-the-repo \
    WHAT_THE_REPO_SERVER_HOST=0.0.0.0 \
    WHAT_THE_REPO_SERVER_PORT=8307

RUN set -eux; \
    export DEBIAN_FRONTEND=noninteractive; \
    for attempt in 1 2 3 4 5; do \
      apt-get update && break; \
      if [ "$attempt" -eq 5 ]; then exit 1; fi; \
      sleep "$((attempt * 2))"; \
    done; \
    for attempt in 1 2 3 4 5; do \
      apt-get -o Acquire::Retries=5 upgrade --yes && break; \
      if [ "$attempt" -eq 5 ]; then exit 1; fi; \
      sleep "$((attempt * 2))"; \
    done; \
    for attempt in 1 2 3 4 5; do \
      apt-get -o Acquire::Retries=5 install --yes --no-install-recommends ca-certificates tini && break; \
      if [ "$attempt" -eq 5 ]; then exit 1; fi; \
      sleep "$((attempt * 2))"; \
    done; \
    rm -rf /var/lib/apt/lists/* \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    && rm -f \
      /usr/local/bin/npm \
      /usr/local/bin/npx \
      /usr/local/bin/corepack \
      /usr/local/bin/pnpm \
      /usr/local/bin/pnpx \
      /usr/local/bin/yarn \
      /usr/local/bin/yarnpkg \
    && groupadd --gid 10001 what-the-repo \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin what-the-repo \
    && mkdir -p /var/lib/what-the-repo /tmp/what-the-repo-home \
    && chown -R 10001:10001 /var/lib/what-the-repo /tmp/what-the-repo-home

WORKDIR /app/server
COPY --from=build /app/server/package.json ./
COPY --from=build /app/server/node_modules ./node_modules
COPY --from=build /app/server/dist ./dist
COPY --from=build /app/server/migrations ./migrations
COPY server/skills ./skills

ENV HOME=/tmp/what-the-repo-home
COPY LICENSE THIRD_PARTY_NOTICES.md /usr/share/doc/what-the-repo/
COPY licenses/ /usr/share/doc/what-the-repo/licenses/


USER 10001:10001
EXPOSE 8307
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
