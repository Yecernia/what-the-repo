# Validation toolchain only. Build separately from the product runtime; run the
# test harness by immutable image ID. Never mount credentials or a Docker socket.
FROM node:24.14.0-trixie-slim
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && node -e "require('fs').writeFileSync('/tmp/bootstrap-ca.pem', require('tls').rootCertificates.join('\n'))" \
    && apt-get -o Acquire::https::CaInfo=/tmp/bootstrap-ca.pem update \
    && apt-get -o Acquire::https::CaInfo=/tmp/bootstrap-ca.pem install -y --no-install-recommends \
    ca-certificates python3 golang-go gopls rustc cargo rust-analyzer rust-src clangd \
    && rm -rf /var/lib/apt/lists/* /tmp/bootstrap-ca.pem
WORKDIR /opt/lsp
RUN npm install --ignore-scripts --no-audit --no-fund --save-exact \
    vscode-jsonrpc@8.2.1 pyright@1.1.408 intelephense@1.16.5
RUN printf '{"type":"module"}\n' > package.json
# Debian's clangd 19 advertises call hierarchy but lacks outgoingCalls. Keep the
# complete upstream distribution (resource headers and notices), not just a binary.
COPY clangd-linux-22.1.6.zip /tmp/clangd.zip
RUN echo 'a9c77443af2e447ed467e84771848d3a6ac1c56f84bcfcde717e66318de77cfa  /tmp/clangd.zip' | sha256sum -c - \
    && python3 -m zipfile -e /tmp/clangd.zip /opt \
    && chmod 755 /opt/clangd_22.1.6/bin/clangd \
    && ln -s /opt/clangd_22.1.6/bin/clangd /usr/local/bin/clangd \
    && rm /tmp/clangd.zip
# Trusted product worker; only these files enter the build context.
COPY lsp-worker.js lsp-policy.js facts.js ./
COPY validation.mjs ./
USER 1000:1000
ENTRYPOINT ["node", "/opt/lsp/validation.mjs"]
