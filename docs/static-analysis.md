# Static analysis

The production coordinator calls `analyzeStaticSource`, followed by optional,
attested LSP enrichment and graph projection. Repository contents are inputs,
never build commands. The CPU stage remains a cancellable subprocess governed by
the existing shared memory and concurrency scheduler.

## Inputs and projects

The GitHub inventory records truncation and omitted paths, including symlinks,
excluded directories, size limits and files missing from the archive. An unknown
inventory cannot justify a deletion. Raw-byte SHA-256, strict UTF-8 decoding,
manifest size checks and boundary checks apply before parsing or LSP mirroring.
The limits are 30,000 files, 4 MiB per file, 300 MiB expanded source and 160 MiB
compressed archive. Binary and invalid UTF-8 inputs retain explicit diagnostics.

TS/JS projects use the installed TypeScript compiler's config parser, including
`extends`, include/exclude patterns, compiler options and project references.
Canonical `tsconfig.json` / `jsconfig.json` files and referenced configurations
define projects; unowned files receive an explicitly inferred project. A file
included by several projects belongs to the closest project, with deterministic
ties. Alternative build configurations are not all analyzed simultaneously.

The compiler host reads only the verified manifest and the installed compiler's
standard library declarations. It cannot load repository plugins, run package
scripts, fetch packages or read arbitrary host files. Workspace package exports
and unambiguous declared `rootDir`/output mappings can resolve source counterparts.
Missing dependencies stay visible; no unrelated same-name symbol supplies a target.

Other languages recognize nearby project descriptors without executing them.
Their native configuration interpretation, dependency discovery and deeper
semantics depend on an available, attested language server. LSP target files and
the complete mirrored project context are separate inputs.

## Capability matrix

| Language | Built-in extraction and binding | Project context / optional LSP |
| --- | --- | --- |
| TypeScript | Native declarations, merged overload signatures and implementation, lexical scopes, arrows, callbacks, accessors, initializers, imports/exports, calls and heritage | Compiler config parser, isolated programs, trusted standard library; no LSP in the main pipeline |
| JavaScript | The same native model for JS/JSX/MJS/CJS, with explicit unresolved dynamic cases | `jsconfig`, package context and inferred options; no LSP in the main pipeline |
| Python | Grammar declarations, decorators/default execution context, lambdas, imports and call sites; shadow-aware lexical candidates and module-path candidates | `pyproject.toml` / setup descriptors; optional LSP |
| Java | Grammar classes, interfaces, records, constructors, methods, lambdas, imports, heritage and call sites; overloads remain distinct syntax observations | Maven/Gradle descriptors; optional LSP |
| Go | Grammar types, interfaces, functions, receiver methods, closures, imports and calls | `go.mod` / `go.work`; optional LSP |
| Rust | Grammar types, traits, modules, functions, impl scope identities, closures, imports and calls | Cargo descriptors; optional LSP |
| PHP | Grammar namespaces, classes, traits, methods, closures, imports/includes and calls | Composer descriptor; optional LSP |
| C# | Grammar namespaces, types, constructors, methods, accessors, local functions, lambdas, using directives and calls | Solution/project descriptors; optional LSP |
| C/C++ | Separate C/C++ grammars; namespaces, types, prototypes, definitions, overload observations, lambdas, includes and calls | Compilation database/CMake descriptors; optional LSP |

Syntax adapters do not claim native semantic equivalence between separate C/C++
prototypes and definitions, Rust trait implementations or Java overload targets.
Without a semantic backend, those relationships remain unresolved. Python
lexical matches are candidates because rebinding, descriptors and monkey-patching
can change runtime dispatch. Macros, reflection, generated code and unavailable
dependency implementations are explicit limits, not empty implementations.

## Fact contract and graph

`project-facts-v1` separates entity IDs, declaration sites, call sites and
cross-version tracking keys. All ranges use one-based lines, zero-based UTF-16
columns and exclusive ends. Declarations retain full and selection ranges and
their declaration/definition role. Syntax recovery is a diagnostic; obtaining a
tree does not mean that parsing succeeded.

Call states distinguish static binding, dynamic candidates, standard library,
external dependency, missing dependency and unresolved sites. A static binding
to a declaration is weaker than a binding to an implementation. Imports distinguish
runtime imports, type imports, reexports and dynamic imports. Generic LSP
supertypes are not relabeled as class inheritance.

Graph construction uses entity references or exact declaration selections.
It does not guess targets by name, file suffix or nearby line. Relation evidence
retains tool/version, source digest, configuration digest, meaning and positions.
Component aggregation separates confirmed and candidate edges; it keeps all
evidence internally while tools page or bound displayed evidence.

`static_analysis` persists project contexts, source completeness, per-file syntax
and semantic completion, diagnostics, imports, exports, unresolved heritage and
all discovered calls. Coverage counts refer to known files and discovered call
sites, **not recall of an unknown true runtime call graph**. Language summaries
remain conservative; an attested executable does not make every fact verified.

Repository overview and relation tools expose limitations. The file-outline tool
accepts `kind: symbols | calls | imports`, literal filtering and pagination, so
the agent can inspect unresolved observations as well as graph edges. An empty
tool result must not be interpreted as proof that an implementation is absent.
The conversation tool `get_static_file_facts` pages calls, imports and exports
for paths already exposed by evidence tools. Both tool families read persisted
facts through the current project/snapshot binding.

## LSP execution and trust

The worker uses `vscode-jsonrpc`, negotiated UTF-16, declared server capabilities,
bounded concurrency (two workers, maximum four), request deadlines, a total
budget and cancellation. It processes every prepared hierarchy item and every
call range, preserving opaque server data. Flat symbols retain their flat status;
display container names do not establish lexical scope. Unknown symbol containers
do not hide their children.

Null/empty results, unsupported methods, request failures and unfinished targets
are distinct. Protocol-declared transient invalidation gets one bounded retry.
There is no fixed initialization sleep. Lack of an observable workspace-ready
signal is recorded. Server workspace errors prevent a completion claim. Partial
declarations are checkpointed before expensive hierarchy queries, and failed
worker runs can recover validated partial results. Target states and uncompleted
files explain budget-limited coverage.

Production enrichment fails closed without `lsp-attestation-v2`. Both wrapper
and server must declare standalone or inventoried-bundle runtime mode. The
attestation binds executable hashes, runtime inventories, platform, sandbox
probe and fixed fixture artifact. Bundles preserve resource layout and verify
every listed file before staging; limits apply to file count and total size.
The sandbox probe must establish network isolation, hidden host/target paths,
bounded writes/processes/memory and process-tree cleanup. A direct local protocol
test is not a substitute for this deployment probe.

Language initialization and subsequent configuration requests share an
operator-owned untrusted-source policy. Rust build scripts, procedural macros
and checks-on-save are disabled; Java automatic builds and Maven/Gradle imports
are disabled; Go uses an offline, local toolchain with CGO disabled. Cargo
executable overrides and clangd project compiler/plugin flags decline LSP
enrichment explicitly. Generic C# servers using MSBuild are not started on
untrusted input. AST analysis remains available in these cases. Truth artifacts
must bind the execution policy, and LSP cache identity includes configuration
and attestation identity. A runtime version/capability mismatch cannot claim
verified or completed enrichment.
Rust analysis waits for its explicit quiescent workspace notification and Java
for `ServiceReady`, within the request/deadline budget. Cargo discovery remains enabled while
build scripts and procedural macros remain disabled. Servers may omit the LSP
version field; executable and runtime inventories still bind their identity.
Reported build metadata is preserved in full for comparison, never shortened
as display text.

The [local Linux container suite](../infra/lsp/README.md) exercises real
toolchains and kernel resource boundaries. Its reports do not enable production
attestation or establish behavior for a different host/wrapper configuration.

Toolchain attestation, advertised capability, request completion and fact
certainty remain separate fields. Shutdown failures are reported separately
from completed analysis requests.

## Cache and publication

`analysis-cache-v3-project-facts` separates syntax and semantic results. Syntax
keys contain raw digest, path/dialect, parser/grammar versions, extraction schema
and encoding policy. Semantic keys contain effective project configuration,
compiler version, workspace package metadata, source structure and dependency
inputs, including previously resolved JSON modules. Structural changes invalidate
lookup domains even when no previous successful relation exists. Unchanged
syntax remains reusable when semantics must be recomputed.
File reads overlap with a bounded eight-request window; extraction order and
per-file integrity checks remain deterministic. Decoding and dependency content
hashes are reused within a run without retaining compiler state across runs.
LSP reuse additionally requires a completed run and an identical digest of the
entire mirrored workspace. Missing context invalidates the run even when an
incomplete inventory cannot prove deletion; changed configuration in another
language also invalidates it. Failed or partial runs are retried.

Old cache schemas are rejected. The analyzer bundle, installed toolchain and
attestation digest participate in publication identity; checkpoints also bind
the static identity. An incompatible checkpoint fails with a version mismatch
and requires a fresh analysis. No shared storage is deleted as migration.
Full and incremental facts are compared without timestamps, cache metrics or
historical tracking metadata. Invalidated old bindings are not published as
current facts. Missing symbols become tombstones only with sufficient successful
reanalysis; ambiguous rename matches do not acquire a guessed successor.

Both normal publication and resumed assembly persist `static_analysis`. Large
cache arrays use the existing chunked payload path. Static-file facts always use
indexed blocks of at most 32 files, including small repositories. A per-file
read fetches and verifies one block without loading graph or cache chunks;
tool output is limited to 50 observations per page. The browser view retains
coverage and project summaries, with `files: []` and `details_available: true`;
full per-target LSP coverage remains in analysis storage.
The file-backed checkpoint implementation also serves PostgreSQL deployments.

## Validation and operational limits

Tests cover final entity/relationship meaning, all nine language families,
UTF-16/CRLF positions, error recovery, configuration isolation, incremental/full
equivalence, safe inputs, protocol fragmentation, partial failures, cancellation,
bundle integrity and persistence. Protocol tests use generous startup budgets
so test-runner contention does not masquerade as a server failure.

Actual deployment acceptance still requires the attested wrapper and complete
language runtimes on the deployment OS. Native compiler semantics and retained
facts increase cold-start cost and memory compared with shallow extraction;
warm-cache improvements do not imply lower peak memory or faster paid model
stages. Runtime metrics expose syntax, semantic, LSP and graph time, process
high-water RSS, input size, cache hits and LSP request/failure counts.

References: [TypeScript compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API),
[LSP 3.17 specification](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/),
[web-tree-sitter](https://github.com/tree-sitter/tree-sitter/tree/master/lib/binding_web).
