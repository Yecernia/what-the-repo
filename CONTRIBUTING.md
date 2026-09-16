# Contributing to what-the-repo

[简体中文](CONTRIBUTING.zh-CN.md) · **English**

[Back to product overview](README.en.md)

Contributions to what-the-repo code and documentation are welcome. See [AGENTS.md](AGENTS.md) for code entry points, development setup and common commands.

## Changes and pull requests

1. For substantial product or architecture changes, open an issue describing the problem and proposed behavior first.
2. Fork the repository, create a branch, and make a focused change. Never include credentials, local databases, internal collaboration documents or generated runtime files.
3. Run checks relevant to your change. Server: `npm run build && npm test`; Web: `npm run build && npm test && npm run lint`; Evolution: `npm run build && npm test`. Run each from its package directory. From the root, run `node scripts/check-license-inventory.mjs`.
4. Open a pull request describing the problem, resulting behavior and validation. Include screenshots for visible UI changes. A draft PR is welcome before checks pass.

GitHub runs CI after the PR is opened. Once checks pass, a maintainer reviews and merges the change. PR checks use test configuration; they do not connect to production services or paid models, or deploy the application.

Use Conventional Commit titles such as `fix: restore cancelled analysis jobs`, `feat: add an evidence filter`, `docs: explain local setup`, or `ci: update quality checks`. Maintainers can normalize the final squash title.

## Integration checks

After installing the server dependencies, set `WTR_TEST_POSTGRES_URL` to a disposable local PostgreSQL database named `wtr_test_bootstrap`, then run `node scripts/test-postgres.mjs`. It compiles the tests and creates a separate temporary database for each PostgreSQL test file; it never reads your local credentials file. This covers persistence and any committed concurrency/scheduling integration tests.

`node scripts/test-runtime-config.mjs` checks the complete portable composition without starting services. `pwsh -File scripts/test-runtime-compose.ps1` starts an isolated two-API/two-worker test stack, checks failover, and removes its own containers and volumes. It uses test-only credentials and invalid model endpoints. These tests need Docker, not access to a maintainer deployment.

## Dependencies and attribution

Explain why a dependency is needed. Update the lockfile, license inventory and applicable notices when changing dependencies or third-party assets; preserve existing copyright and modification notices. The license check reports inventory records that need updating. See [license records](licenses/README.md).

## Community and security

Please follow the [code of conduct](CODE_OF_CONDUCT.md) in issues, pull requests and discussions. If you find a vulnerability, contact me privately as described in the [security policy](SECURITY.md).
