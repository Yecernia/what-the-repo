FROM node:24.14.0-trixie-slim AS build

WORKDIR /source/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build

FROM node:24.14.0-trixie-slim AS dependencies

WORKDIR /app
COPY infra/docker/github-gateway/package.json infra/docker/github-gateway/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24.14.0-trixie-slim

ENV NODE_ENV=production \
    GITHUB_GATEWAY_HOST=0.0.0.0 \
    GITHUB_GATEWAY_PORT=8408

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
    && groupadd --gid 10002 github-gateway \
    && useradd --uid 10002 --gid 10002 --no-create-home --shell /usr/sbin/nologin github-gateway

WORKDIR /app
COPY --from=dependencies /app/package.json ./
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build /source/server/dist/github-gateway ./dist/github-gateway

COPY LICENSE THIRD_PARTY_NOTICES.md /usr/share/doc/what-the-repo/
COPY licenses/ /usr/share/doc/what-the-repo/licenses/


USER 10002:10002
EXPOSE 8408
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=4 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8408/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/github-gateway/main.js"]
