# Contributing to what-the-repo

This repository contains the hosted Web product. A separate offline/desktop edition is outside the current scope.

## Changes and pull requests

1. For substantial product or architecture changes, open an issue describing the problem and proposed behavior first.
2. Fork the repository, create a branch, and make a focused change. Never include credentials, local databases, internal collaboration documents or generated runtime files.
3. Run checks relevant to your change. Server: `npm run build && npm test`; Web: `npm run build && npm test && npm run lint`; Evolution: `npm run build && npm test`. Run each from its package directory. From the root, run `node scripts/check-license-inventory.mjs`.
4. Open a pull request describing the problem, resulting behavior and validation. Include screenshots for visible UI changes. A draft PR is welcome before checks pass.

GitHub runs CI after the PR is opened. Passing checks are evidence for review; maintainers still review the change before merging. Ordinary PR checks do not receive production or paid-model credentials and do not deploy the application.

Use Conventional Commit titles such as `fix: restore cancelled analysis jobs`, `feat: add an evidence filter`, `docs: explain local setup`, or `ci: update quality checks`. Maintainers can normalize the final squash title. Contributors do not need access to the hosted service's servers or secrets.

## Dependencies and attribution

Explain why a dependency is needed. Update the lockfile, license inventory and applicable notices when changing dependencies or third-party assets; preserve existing copyright and modification notices. The inventory includes exact manifest hashes and will report stale records. See [license records](licenses/README.md).

## Reporting security issues

Do not paste a live credential, private source or an exploit against the hosted service into a public issue. Use GitHub's private vulnerability reporting when enabled; otherwise request a private contact channel without posting sensitive details. Never test against other users' data.
