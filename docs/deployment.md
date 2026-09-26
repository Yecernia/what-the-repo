# Deployment

[简体中文](deployment.zh-CN.md) · **English**

This runs the same Web product as [what-the-repo.com](https://what-the-repo.com) on your own machine or server.
There is no separate desktop or personal edition. For local development, see the
[contribution guide](../CONTRIBUTING.md).

## Requirements

- Docker with Linux containers and Docker Compose 2.24.4 or newer.
- Your own GitHub OAuth application and model configuration.

## Configure

Copy `.env.example` to the ignored `.secrets/runtime.env` and replace the database passwords, session and
encryption secrets, OAuth application and model configuration with your own.

- For containers, set `WHAT_THE_REPO_REDIS_URL=redis://redis:6379`.
- Register the OAuth callback `<WHAT_THE_REPO_WEB_URL>/api/auth/github/callback`. Locally that is
  `http://127.0.0.1:5307/api/auth/github/callback`, not the internal API port.
- For a public instance, set `NODE_ENV=production` and `WHAT_THE_REPO_WEB_URL` to your HTTPS origin.

COS, MCP, the admin console and search are optional and can stay unconfigured.

## Start

```sh
docker compose --env-file .secrets/runtime.env -f compose.runtime.yaml up --build -d --wait
```

This initializes the database and starts PostgreSQL, Redis, the API, the analysis worker, the retention scheduler
and the Web frontend. The Web frontend listens on `127.0.0.1:5307`; the API and database stay internal.

## Running it on a server

- Terminate HTTPS at your own reverse proxy. A [placeholder Nginx template](../infra/docker/public-edge.nginx.conf.template)
  is provided.
- Data lives in named volumes. Arrange and test your own off-host backups.
- Put instance-specific ports, resource limits and networking in an ignored `compose.instance.yaml` and pass it
  with an additional `-f`.

## Replicas and optional profiles

- `--scale api=2 --scale analysis-worker=2` runs the same service code with replicas. Keep the retention scheduler
  as a single instance.
- `--profile monitoring` needs your own metrics token and Grafana credentials.
- `--profile evolution` needs its own model configuration and gives the trusted worker Docker access. It is not
  started by default.

## File-based secrets

For file-based credentials and read-only service filesystems, add
[compose.runtime-secrets.yaml](../compose.runtime-secrets.yaml), provide the secret files it declares under
`WTR_SECRET_ROOT`, and make sure each container user can read only its mounted files. This overlay does not
generate credentials.

## Verification

Pull requests run these checks, none of which needs the maintainer's accounts or deployment files:

- [runtime configuration checks](../scripts/test-runtime-config.mjs)
- [replica and failover smoke tests](../scripts/test-runtime-compose.ps1)
- [isolated PostgreSQL tests](../scripts/test-postgres.mjs)

## Capacity

See [runtime capacity](runtime-capacity.md) for concurrency settings, personal limits, analysis stage resources and
migration from old configuration. The example values are starting points, not load-tested capacity.
