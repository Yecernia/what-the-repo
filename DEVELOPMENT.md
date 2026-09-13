# Development guide

[简体中文](DEVELOPMENT.zh-CN.md) · **English**

[Product overview](README.en.md) · [Contributing](CONTRIBUTING.md)

This guide is for working on the hosted Web product's source code. To use the product, visit [what-the-repo](https://bottlecapduel.com).

## Code layout

- `server/`: TypeScript/Node.js, Fastify, Pi Agent runtime, static analysis,
  PostgreSQL persistence, Redis/BullMQ delivery and object-store adapters.
- `web/`: React/Vite workbench, conversation UI and evidence/architecture views.
- `evolution/pi/`: isolated candidate generation and human-reviewed Skill updates.
- `eval/`: deterministic test fixtures and evaluation cases.
- `infra/`, `compose*.yaml`, `scripts/`: development, validation and deployment recipes.

The application analyzes untrusted repositories without running their install,
build, test, hook or plugin scripts.

## Development

Use Node.js 22.19 or later (current CI uses Node.js 24). Install the three product
packages with `npm ci` in `server/`, `web/` and `evolution/pi/`.

The local dependency workflow runs PostgreSQL/Redis in Docker and runs the API,
analysis worker and Vite on the host. On Windows, configuration is kept in the
Git-ignored `.secrets/local.env`; `.env.example` documents the variables.
Use your own development OAuth application, callback and provider credentials.
For the default Web URL, the OAuth callback is
`http://127.0.0.1:5307/api/auth/github/callback`.
Keep your test OAuth application separate from the production application.
Never commit the filled-in file.

```powershell
New-Item -ItemType Directory -Force .secrets
# Only for first-time setup; do not overwrite existing credentials.
if (-not (Test-Path .secrets/local.env)) { Copy-Item .env.example .secrets/local.env }
# Fill .secrets/local.env before starting.
powershell -ExecutionPolicy Bypass -File scripts/start-local-dev-deps.ps1
```

Web defaults to `http://127.0.0.1:5307` and API to `http://127.0.0.1:8307`.

## Configuration and deployment

Configuration names use `WHAT_THE_REPO_*`; GitHub OAuth variables remain `GITHUB_OAUTH_*`. Filled environment files and credential files stay local and are ignored by Git. Example domains, buckets and account IDs must be replaced with your own values. Set optional `VITE_ICP_RECORD` to your own public filing label before building the Web image; the footer is hidden when it is empty.

Docker supplies PostgreSQL and Redis for host development. The full Compose files support integration testing; `infra/k8s/` and the k3s scripts describe the hosted single-node deployment. CI validates code and recipes; it does not publish or deploy them.


## License checks

Run `node scripts/check-license-inventory.mjs` from the repository root after dependency or asset changes. See [license records](licenses/README.md), [third-party notices](THIRD_PARTY_NOTICES.md) and [distribution boundaries](licenses/DISTRIBUTION.md).
