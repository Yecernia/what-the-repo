# Security policy

[简体中文](SECURITY.zh-CN.md) · **English**

[Product overview](README.en.md) · [Contributing](CONTRIBUTING.md)

I'm [Yecernia](https://github.com/Yecernia), the author of what-the-repo. If you find a security issue, thank you for telling me privately so I have an opportunity to protect affected users and address it first.

## How to report to me

Use **“Report a vulnerability”** on this repository's [Security advisories](https://github.com/Yecernia/what-the-repo/security/advisories) page to submit a private report.

You can also email me using the address listed on [my GitHub profile](https://github.com/Yecernia), with a subject starting with **[what-the-repo Security]**. If GitHub's private reporting option is unavailable, please use email.

Do not include exploit steps, affected accounts or sensitive evidence in a public issue, pull request or discussion.

## What to include

- What you found and which features or data it could affect.
- Whether it affects the hosted service or a local development setup, and the commit or version if known.
- Minimal reproduction steps using your own accounts and test data, with sanitized logs where useful.
- Whether you would like credit in the fix notes, and the name you would like to use.

A complete exploit program is not required. Do not send working keys, tokens, passwords, session cookies or other users' private data. Revoke or rotate your own credentials first if they have been exposed.

## How I will respond

I will acknowledge your report, investigate its impact, and keep you informed privately. If a fix needs more time or help from an upstream project, I will explain why. With your permission, I will credit you in the fix notes.

Please coordinate public disclosure of vulnerability details with me so affected users have time to apply a fix.

## Security scope

what-the-repo is a hosted Web product that analyzes public GitHub repositories. I am particularly interested in:

- Authentication, session or authorization flaws that expose another user's projects, conversations or learning data.
- Path, repository-fetch or file-access validation failures that allow out-of-bounds reads or writes, or server requests to destinations that should not be accessible.
- Malicious repository content or prompt injection that causes agents to exceed tool permissions, disclose secrets or execute code they should not execute.
- Page injection, snapshot or object-storage access flaws, and dependency vulnerabilities that can be exploited in this product.

Ordinary inaccurate answers, feature requests and bugs that do not affect security boundaries can use regular issues. If you are unsure whether something is a security issue, you can report it privately first.

Security fixes are prioritized for the current main branch; older tags and branches do not have a separate long-term support commitment. Include the time of occurrence for hosted-service reports, since a source commit may not match the deployed version at that time.

Prefer an isolated local setup for reproduction, using only your own accounts and data. Do not access other users' data, disrupt the hosted service or test third-party infrastructure. If you encounter real user data unexpectedly, stop and tell me privately.

For community conduct concerns, follow the [code of conduct](CODE_OF_CONDUCT.md).

## User-managed provider API keys

In PostgreSQL deployments, personal provider keys are stored as AES-256-GCM authenticated ciphertext, bound to the owner and connection. The server derives its encryption key from deployment secret material, separate from the database and source repository. Existing encrypted records remain readable with the original deployment secret; do not rotate it without a migration plan.

Keys are decrypted only when needed. Startup and settings availability checks do not load plaintext keys, and the vault has no plaintext cache. The development-only FileStore uses an encrypted in-memory vault and does not survive process restarts. Browser code does not persist provider keys in cookies or browser storage, and settings responses contain only availability and a fixed mask. Replacement requires a newly verified key; deletion removes its stored ciphertext but does not revoke an already running upstream request or the upstream credential itself.

Credential-management requests require HTTPS, apart from localhost development, and send the draft in `x-wtr-byok-draft`. Ordinary chat requests do not resend a saved key. Application diagnostics use bounded error categories instead of raw provider errors. Known credential echoes are filtered before agent events and session persistence; arbitrary transformations by a malicious upstream cannot be guaranteed safe.

Operators must exclude credential headers, authorization, cookies, request bodies and complete runtime objects from proxy/APM/debug logs. Keep encryption secrets outside Git, database dumps and container images. HTTPS protects transport, not database contents; field encryption does not protect an already compromised application process. Memory/core dumps, swap and historical backups require separate controls, and clearing JavaScript references is not secure memory erasure. Users should use dedicated limited-budget keys and revoke them with the provider after suspected exposure.
