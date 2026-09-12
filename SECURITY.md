# Security policy

[简体中文](SECURITY.zh-CN.md) · **English**

[Product overview](README.en.md) · [Contributing](CONTRIBUTING.md)

## Supported code

Security fixes are prioritized for the current `main` branch. When tagged releases are available, use the latest release and check its notes for security fixes; older tags and branches do not have a separate long-term support commitment. Include the exact commit or release version in a report.

This repository contains the hosted Web product's source. A GitHub commit or Release is not proof that the hosted service has deployed the same code. A separate desktop or offline edition is outside the current scope.

## Reporting a vulnerability privately

Do not put vulnerability details in a public issue, pull request or discussion.

1. Open the repository's [Security advisories](https://github.com/Yecernia/what-the-repo/security/advisories) page. If **“Report a vulnerability”** is available, use it to send a private report to the maintainers.
2. If that button is unavailable, do not assume private reporting is enabled. Use a private security contact explicitly published by the [maintainer](https://github.com/Yecernia), or open a minimal [issue](https://github.com/Yecernia/what-the-repo/issues) titled **“Private security contact requested”** containing only a request for a private channel. Do not include reproduction details, affected accounts, credentials or evidence in that public request. Wait for an agreed private channel before sending sensitive information.

Creating this file does not enable GitHub private vulnerability reporting; that is a separate repository setting. Ordinary bugs and feature requests can still use public issues if they contain no sensitive information.

## What to include

- Affected commit or version, component, and whether the issue concerns a local setup or the hosted service.
- The expected behavior, observed behavior, prerequisites and potential impact.
- Minimal reproduction steps using your own data, with sanitized logs or a small example where useful.
- Any suggested mitigation, if known.

Never send working tokens, provider keys, passwords, session cookies or another person's private source or data. Redact these values from examples. If one of your credentials has been exposed, revoke or rotate it through the relevant provider.

## Safe reproduction and handling

Prefer an isolated local setup and accounts or data you control. This policy is not authorization to access other users' data, bypass permissions, disrupt the hosted service or test third-party infrastructure. Stop if reproduction risks exposing real user data, and report the minimum information needed privately.

Maintainers will assess reports, request clarification when needed, and coordinate a fix and disclosure where appropriate. Response and remediation depend on available maintainer capacity; there is no fixed response or repair deadline. Please coordinate public technical details with the maintainers so affected users have an opportunity to apply a fix.

Community conduct concerns belong under the [code of conduct](CODE_OF_CONDUCT.md), rather than vulnerability reports.
