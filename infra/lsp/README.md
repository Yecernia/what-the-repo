# Isolated language-server validation

This is an optional local validation toolchain, separate from the Web runtime.
It does not enable production LSP enrichment or generate production attestation.
Production still requires an operator-owned wrapper, inventoried runtimes and
truth/probe artifacts bound to the current execution policy.

Build the server (`npm --prefix server run build`). Create a fresh build context
containing only `lsp-worker.js`, `lsp-policy.js` and `facts.js` from
`server/dist/analysis`, plus `validation.mjs` from this directory and the official
[clangd Linux 22.1.6 archive](https://github.com/clangd/clangd/releases/tag/22.1.6)
named `clangd-linux-22.1.6.zip`. The Dockerfile checks its published SHA-256 before
extracting the complete distribution. Build with
`docker build -f infra/lsp/validation.Dockerfile -t wtr-lsp-validation CONTEXT`.
Use `docker image inspect --format '{{.Id}}' wtr-lsp-validation` to obtain the
immutable image ID. Record it alongside the report; Debian package updates mean
rebuilding the same Dockerfile can produce a different image.

Set `WTR_LSP_TEST_IMAGE` to that `sha256:...` ID, optionally set
`WTR_TEST_DOCKER_BINARY` to the Docker CLI's absolute path, and run:

```sh
node scripts/test-lsp-sandbox.mjs /path/to/private/report.json
```

The harness accepts only a local Docker endpoint. Every test uses a new
container with no network or host bind mounts, a read-only root, unprivileged
user, dropped capabilities, no privilege escalation, a bounded non-executable
temporary filesystem, a PID limit and equal memory/swap limits. Containers are
removed in `finally`, including failures. It tests actual outbound connection
failure, forbidden writes, absence of host paths/socket/secrets, PID exhaustion,
physical-memory OOM termination and cleanup of a detached child. The memory test
deliberately terminates its own 128 MiB container; other containers use 1 GiB.

The language suite runs the actual product LSP worker against Pyright,
Intelephense, gopls, rust-analyzer and clangd. It includes their compiler/runtime
dependencies, checks declarations and supported call hierarchies, and verifies
that a Rust build script is neither built nor executed. These fixtures are
authored tests; third-party repository scripts are never run.
The pinned clangd replaces Debian's clangd 19 for these requests: version 19
advertises call hierarchy but does not implement the required outgoing-call
method. Rust queries wait for the server's explicit quiescent workspace status;
disabling Cargo workspace reload would prevent initial semantic analysis.

For Java, place a separately verified JDT LS distribution (including its
upstream notices) in a second context as `jdtls/`, alongside `validation.mjs`
and the three compiled worker files used by the core context.
Build `validation-java.Dockerfile` with `--build-arg BASE_IMAGE=LOCAL_REFERENCE`,
verifying that the reference still resolves to the recorded core image ID.
This adds Java 21 and tests an explicit Eclipse Java project with an empty build
specification, automatic builds and Maven/Gradle import disabled. Save the JDT
LS file inventory with the report. JDT LS readiness uses its `ServiceReady`
notification; server display labels are checked by exact source selections.
An imported project passing does not establish support for unmanaged folders:
JDT LS 1.59.0 can return declarations/calls there while reporting an internal
project error, which the worker preserves as incomplete enrichment. Buildship
may still attempt its own version-list lookup; the network boundary blocks it.
Shutdown diagnostics are reported separately from completed queries, and the
container cleanup check still requires all processes to terminate.

C# language servers that load projects through MSBuild are deliberately not
started on untrusted repositories. C# AST facts remain available. Microsoft
documents that even opening a project through MSBuild requires trusted inputs;
an offline environment alone does not make it safe. Cargo tool overrides and
clangd compile/plugin configuration likewise cause enrichment to be declined
explicitly, rather than silently changing the project's inputs.

The npm tools retain their installed upstream license files, and Debian tools
retain `/usr/share/doc` notices. No built image or third-party distribution is
committed to this repository; review their redistribution requirements before
publishing an image.

References: [rust-analyzer security](https://rust-analyzer.github.io/book/security.html),
[MSBuild security](https://learn.microsoft.com/en-us/visualstudio/msbuild/msbuild-security-best-practices),
[clangd compiler execution](https://clangd.llvm.org/design/compile-commands),
[Docker memory constraints](https://docs.docker.com/engine/containers/resource_constraints/),
[Docker network isolation](https://docs.docker.com/engine/network/drivers/none/).
