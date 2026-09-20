# Optional Java validation layer. BASE_IMAGE is a verified local core image reference;
# jdtls/ is a separately verified upstream distribution, never repository code.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends openjdk-21-jre-headless \
    && rm -rf /var/lib/apt/lists/*
COPY jdtls/ /opt/jdtls/
COPY lsp-worker.js lsp-policy.js facts.js /opt/lsp/
COPY validation.mjs /opt/lsp/validation.mjs
ENV WTR_TEST_JDTLS=1
USER 1000:1000
