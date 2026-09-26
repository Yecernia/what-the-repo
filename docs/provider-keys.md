# User-managed provider API keys

[简体中文](provider-keys.zh-CN.md) · **English**

How what-the-repo stores and uses the model API keys users bring themselves, and what operators must do to keep
them safe. To report a problem, see the [security policy](../SECURITY.md).

## Storage

In PostgreSQL deployments, personal provider keys are stored as AES-256-GCM authenticated ciphertext, bound to the
owner and connection. The server derives its encryption key from deployment secret material, separate from the
database and source repository. Existing encrypted records remain readable with the original deployment secret; do
not rotate it without a migration plan.

The development-only FileStore uses an encrypted in-memory vault and does not survive process restarts.

## Use

Keys are decrypted only when needed. Startup and settings availability checks do not load plaintext keys, and the
vault has no plaintext cache. Browser code does not persist provider keys in cookies or browser storage, and
settings responses contain only availability and a fixed mask. Replacement requires a newly verified key; deletion
removes its stored ciphertext but does not revoke an already running upstream request or the upstream credential
itself.

Credential-management requests require HTTPS, apart from localhost development, and send the draft in
`x-wtr-byok-draft`. Ordinary chat requests do not resend a saved key. Application diagnostics use bounded error
categories instead of raw provider errors. Known credential echoes are filtered before agent events and session
persistence; arbitrary transformations by a malicious upstream cannot be guaranteed safe.

## Operator responsibilities

- Exclude credential headers, authorization, cookies, request bodies and complete runtime objects from proxy, APM
  and debug logs.
- Keep encryption secrets outside Git, database dumps and container images.
- HTTPS protects transport, not database contents, and field encryption does not protect an already compromised
  application process. Memory and core dumps, swap and historical backups need separate controls; clearing
  JavaScript references is not secure memory erasure.

Users should use dedicated, limited-budget keys and revoke them with the provider after any suspected exposure.
