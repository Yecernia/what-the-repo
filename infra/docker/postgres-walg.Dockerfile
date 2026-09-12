ARG POSTGRES_IMAGE=postgres:16.15-bookworm

FROM ${POSTGRES_IMAGE} AS wal-g

ARG WAL_G_VERSION=v3.0.9
ARG TARGETARCH=amd64

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && case "$TARGETARCH" in \
         amd64) \
           asset="wal-g-pg-20.04-amd64"; \
           sha256="965a7147852435bc4b54f272799b63df826b54ef65cf7c4fc688c82b96c0c4eb" \
           ;; \
         arm64) \
           asset="wal-g-pg-20.04-aarch64"; \
           sha256="89f0cea535eed8c5b742358bff5151e65b302eab90689d0afb38750f8d505936" \
           ;; \
         *) \
           echo "Unsupported WAL-G target architecture: $TARGETARCH" >&2; \
           exit 1 \
           ;; \
       esac \
    && download_path="/tmp/wal-g" \
    && download_url="https://github.com/wal-g/wal-g/releases/download/${WAL_G_VERSION}/${asset}" \
    && rm -f "$download_path" \
    && for attempt in 1 2 3 4 5; do \
         if curl --fail --location --show-error --silent --http1.1 \
              --retry 4 --retry-all-errors --retry-delay 3 \
              --connect-timeout 20 --max-time 300 \
              "$download_url" --output "$download_path"; then \
           break; \
         fi; \
         rm -f "$download_path"; \
         if [ "$attempt" -eq 5 ]; then exit 1; fi; \
         sleep "$((attempt * 3))"; \
       done \
    && echo "${sha256}  ${download_path}" | sha256sum --check --strict \
    && install -m 0755 "$download_path" /usr/local/bin/wal-g \
    && rm -f "$download_path"

FROM ${POSTGRES_IMAGE}

# The runtime stage must carry the trust store too; the builder's package layer
# is discarded, and WAL-G needs CA roots when it talks to COS over HTTPS.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=wal-g /usr/local/bin/wal-g /usr/local/bin/wal-g
COPY infra/postgres/wtr-postgres-entrypoint /usr/local/bin/wtr-postgres-entrypoint
COPY infra/postgres/wtr-postgres-role-bootstrap /usr/local/bin/wtr-postgres-role-bootstrap
COPY infra/postgres/wtr-wal-g /usr/local/bin/wtr-wal-g
COPY infra/postgres/wtr-postgres-backup /usr/local/bin/wtr-postgres-backup
COPY infra/postgres/wtr-postgres-restore /usr/local/bin/wtr-postgres-restore

RUN chmod 0755 \
      /usr/local/bin/wal-g \
      /usr/local/bin/wtr-postgres-entrypoint \
      /usr/local/bin/wtr-postgres-role-bootstrap \
      /usr/local/bin/wtr-wal-g \
      /usr/local/bin/wtr-postgres-backup \
      /usr/local/bin/wtr-postgres-restore \
    && wal-g --version

COPY LICENSE THIRD_PARTY_NOTICES.md /usr/share/doc/what-the-repo/
COPY licenses/ /usr/share/doc/what-the-repo/licenses/


ENTRYPOINT ["/usr/local/bin/wtr-postgres-entrypoint"]
