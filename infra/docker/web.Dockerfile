FROM node:24.14.0-bookworm-slim AS build

WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY web ./
ARG VITE_ICP_RECORD=
RUN VITE_ICP_RECORD="$VITE_ICP_RECORD" npm run build

FROM nginx:1.27.4-alpine

COPY infra/docker/web.nginx.conf /etc/nginx/conf.d/default.conf
COPY infra/docker/nginx-security-headers.conf /etc/nginx/nginx-security-headers.conf
COPY --from=build /app/web/dist /usr/share/nginx/html

EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=6 \
  CMD wget --quiet --spider http://127.0.0.1:8080/healthz || exit 1
