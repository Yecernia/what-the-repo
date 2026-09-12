FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8

COPY --chown=0:0 sandbox-entry.mjs /opt/what-the-repo/sandbox-entry.mjs
COPY --chown=0:0 checks /opt/what-the-repo/checks

RUN chmod 0555 /opt/what-the-repo/sandbox-entry.mjs \
    && chmod 0555 /opt/what-the-repo/checks/*.mjs \
    && mkdir -p /workspace /tmp \
    && chmod 0755 /workspace /tmp

COPY LICENSE /usr/share/doc/what-the-repo/LICENSE

USER 65532:65532
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/node", "/opt/what-the-repo/sandbox-entry.mjs"]
