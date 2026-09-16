FROM node:24.14.0-bookworm-slim AS build

WORKDIR /app/evolution/pi
COPY evolution/pi/package.json evolution/pi/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY evolution/pi/tsconfig.json evolution/pi/tsconfig.runtime.json ./
COPY evolution/pi/src ./src
COPY evolution/pi/scripts/build-platform-budget.mjs ./scripts/build-platform-budget.mjs
COPY server/src /app/server/src
RUN npm run build:runtime && npm prune --omit=dev --ignore-scripts

FROM node:24.14.0-bookworm-slim

ENV NODE_ENV=production \
    PI_OFFLINE=1 \
    WHAT_THE_REPO_ROOT=/app \
    WHAT_THE_REPO_DATA_DIR=/var/lib/what-the-repo \
    WHAT_THE_REPO_DOCKER=/usr/bin/docker \
    WHAT_THE_REPO_EVOLUTION_DOCKER_CONFIG=/run/what-the-repo-docker-config \
    WHAT_THE_REPO_EVOLUTION_SANDBOX_IMAGE=what-the-repo-pi-sandbox:local \
    HOME=/tmp/evolution-home

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates docker.io tini \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/lib/what-the-repo /run/what-the-repo-docker-config /tmp/evolution-home

WORKDIR /app/evolution/pi
COPY --from=build /app/evolution/pi/package.json ./
COPY --from=build /app/evolution/pi/node_modules ./node_modules
COPY --from=build /app/evolution/pi/.dist ./.dist
COPY --from=build /app/server/dist /app/server/dist
COPY server/package.json /app/server/package.json
COPY server/skills /app/server/skills

COPY LICENSE THIRD_PARTY_NOTICES.md /usr/share/doc/what-the-repo/
COPY licenses/ /usr/share/doc/what-the-repo/licenses/


ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", ".dist/src/worker-main.js"]
