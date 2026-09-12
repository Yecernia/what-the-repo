# what-the-repo

An evidence-grounded AI learning companion for understanding unfamiliar public
GitHub repositories.

what-the-repo 的在线 Web 产品源码。系统从公开仓库建立文件、符号和关系事实，
再生成架构视图、学习价值点与研学路线，并在对话中提供可核对的代码证据。

## Scope

This repository contains the hosted Web application, API, analysis worker,
controlled Evolution worker, tests and deployment recipes. Local launch scripts
are for development and testing. A separate login-free local/desktop edition is
a future product, not the purpose of these development scripts.

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
Development launch is not an end-user standalone edition or proof of production
deployment readiness.

## Configuration and deployment

Configuration names use `WHAT_THE_REPO_*`; GitHub OAuth variables remain `GITHUB_OAUTH_*`. Filled environment files and credential files stay local and are ignored by Git. Example domains, buckets and account IDs must be replaced with your own values. Set optional `VITE_ICP_RECORD` to your own public filing label before building the Web image; the footer is hidden when it is empty.

Docker supplies PostgreSQL and Redis for host development. The full Compose files support integration testing; `infra/k8s/` and the k3s scripts describe the hosted single-node deployment. Deployment requires separate configuration and access to your own infrastructure. CI validates code and recipes; it does not publish or deploy them.

Existing installations must migrate environment names and explicitly preserve their database names, object prefixes and storage mounts before deploying renamed code. Version 1 provider-key encryption retains its original KDF identifier so stored keys remain readable. Browser cookies and cache keys use the new name; existing browser sessions require signing in again.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for pull requests, checks and dependency changes. CI starts after a PR is created; passing CI does not replace maintainer review.

## License and attribution

Original project code is licensed under [MIT](LICENSE), copyright 2026 Yecernia.
Third-party material keeps its own terms. See [Third-party notices](THIRD_PARTY_NOTICES.md),
[direct dependencies](licenses/DIRECT_DEPENDENCIES.md),
[all npm dependencies](licenses/NPM_DEPENDENCIES.md),
[visual assets](licenses/ASSETS.md) and [distribution boundaries](licenses/DISTRIBUTION.md).

```sh
node scripts/check-license-inventory.mjs
```

The license inventory covers the source snapshot and its declared dependencies;
it is not a completed binary/container redistribution audit.
