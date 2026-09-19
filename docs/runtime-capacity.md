# Runtime capacity

Capacity values are starting points, not measured throughput guarantees. PostgreSQL
coordinates admission across processes. Redis only delivers wake-ups. Stage
checkpoints and source files require the same shared data volume; these defaults
target one host, not unrelated hosts with independent local disks.

## Work and resources

A repository job keeps its durable identity and personal participation allowance
until completion or failure. Its supervisor starts a separate Node process for
each phase: fetch, static analysis, semantic interpretation, and publication.
The process exits after saving its checkpoint, releasing its resident memory.
Waiting for a model does not retain a fetch, static-analysis, or publication slot.
Language overlays use their own isolated process and the shared model/memory pools.

Stage slots and memory are acquired atomically. Each model request acquires its
business allowance and applicable upstream allowances together. Neither holds one
of those allowances while waiting for the other. Owners with fewer active grants
are preferred, then tasks, with FIFO tie-breaking; running work is not preempted.
Aged large memory requests reserve contested resources so small arrivals cannot
indefinitely pass them. Semantic producers use the model concurrency, bounded to
16 batches per job to limit pending metadata and materialized inputs.

The file persistence backend is a single-process development fallback. It keeps
one in-process whole-job lane and does not provide the production stage isolation
or distributed capacity guarantees. Use PostgreSQL to exercise these features.

## Settings

All names below have the prefix `WHAT_THE_REPO_`. Integer values outside their
accepted range fail startup instead of being silently clamped.

| Setting | Initial value | Accepted range | Controls |
| --- | ---: | --- | --- |
| CHAT_CONCURRENCY | 8 | 1–256 | Whole executing chat turns, including their tools |
| CHAT_MODEL_CONCURRENCY | 8 | 1–256 | Concurrent chat/verification model requests |
| ANALYSIS_FETCH_CONCURRENCY | 2 | 1–32 | Repository download stages |
| ANALYSIS_CPU_CONCURRENCY | 2 | 1–32 | Static parsing and graph construction stages |
| ANALYSIS_MODEL_CONCURRENCY | 8 | 1–256 | Model requests across all repository analyses/overlays |
| ANALYSIS_PUBLISH_CONCURRENCY | 1 | 1–16 | Full snapshot publication stages |
| CHAT_OWNER_CONCURRENCY | 2 | 1–16 | Personal active chat turns, including waiting; also bounds personal chat model requests |
| CHAT_QUEUE_LIMIT | 16 | 0–256 | Global waiting chats; each person may have only one |
| CHAT_WAIT_TIMEOUT_MS | 30000 | 1–120000 | Whole-chat admission waiting deadline |
| CHAT_DISCONNECT_GRACE_MS | 30000 | 0–120000 | Waiting chat reconnection grace |
| ANALYSIS_OWNER_CONCURRENCY | 2 | 1–16 | Personal active analyses, retained between phases |
| ANALYSIS_OWNER_QUEUE_LIMIT | 4 | 1–64 | Personal waiting analyses |
| ANALYSIS_QUEUE_LIMIT | 32 | 1–256 | Physical jobs waiting for participation/scheduling |
| ANALYSIS_PENDING_LIMIT | 32 | 1–256 | Total accepted unfinished physical jobs, including running |
| ANALYSIS_MEMORY_MB | 6144 | 1024–1048576 | Shared stage working-memory reservation budget |
| OBJECT_STORE_CONCURRENCY | 8 | 1–64 | Shared snapshot object I/O requests |

The two analysis backlog limits count different things. Setting both to 32 means
at most 32 unfinished physical jobs, not 32 running plus 32 waiting. Shared jobs
consume one physical entry; each participant still consumes their applicable
personal allowance. Reusing an already completed result consumes neither.
Project count, creation-frequency and monetary controls remain in force.
Changing tabs or connection labels does not create extra allowances.

New requests receive a clear busy response when admission is full. Accepted
analysis jobs continue after a browser disconnect. Waiting between phases is
shown explicitly. Resource waiting is excluded from the semantic execution timer;
actual model execution, tool work and request-count budgets remain bounded.
Conflicting simultaneous turns in one conversation fail promptly.

## Memory and deployment

Memory estimates include source expansion and checkpoint sizes. Parsed caches and
previous graph data live in a separate checkpoint part; semantic work does not
load them. Legacy inline checkpoints can be converted when resumed. Publication
loads both parts. Checkpoint hashes are checked before use.

Each stage gets a V8 heap limit and an RSS guard. On Linux the supervisor also
samples the process tree, including native tools. Oversized jobs fail explicitly;
they are not allowed to wait forever for more memory than the whole budget.
RSS sampling is a guard, not a kernel hard limit: the worker container memory limit
remains the final protection against bursts. The memory budget must leave at least
512 MB or 15% (whichever is larger) inside that container for supervision/overhead.
Startup checks the Linux cgroup limit. Reserve host memory for the API, database,
Redis, other workers and operating system separately.

The portable analysis container starts with 3 CPUs and 8 GiB, configurable through
`WHAT_THE_REPO_ANALYSIS_CONTAINER_CPUS` and
`WHAT_THE_REPO_ANALYSIS_CONTAINER_MEMORY`. These are independent of the application
admission settings. Changing a manifest is supported; these values are not a
capacity certification for a particular machine.

Each isolated stage has a database pool of two connections plus a separate
single-connection object-admission pool. The latter prevents deadlocks when object
operations occur inside a metadata transaction. Budget these pools together with
API, supervisor, scheduler, evolution and maintenance connections; increasing
worker replicas does not multiply the shared resource limits.

## Upstream accounts

`WHAT_THE_REPO_UPSTREAM_CAPACITIES` is a JSON array, empty by default. Configure
only verified upstream concurrency allowances, not an invented universal limit.
Each rule has `account`, `baseUrl`, `credentialHashes`, optional `model`, and
`concurrency` (1–256). `account` is an operator-chosen stable identifier, not a
browser connection label. Multiple keys for one account belong in the same rule.
An account-wide rule and a model-specific rule may both apply to a request.
Matching rules are shared by chat, analysis, feedback and evolution.

`credentialHashes` contains SHA-256 hex digests of
`baseUrl.replace(/\/+$/, '').toLowerCase() + '\0' + apiKey`, using the literal
NUL separator. Generate these inside a trusted credential workflow; do not paste
keys into shell history or commit them. Reusing a key under another connection
label still matches. Unlisted personal keys get normal business and personal
limits but no invented upstream account allowance. RPM/TPM quotas are not inferred
from concurrency; this setting does not implement token-rate limiting.

## Migration and verification

Remove these obsolete variables before starting the new runtime:

- `ANALYSIS_CONCURRENCY`, `ANALYSIS_QUEUE_CONCURRENCY`: whole-job bottlenecks are
  replaced by stage capacities and `ANALYSIS_PENDING_LIMIT`.
- `PROVIDER_CONCURRENCY`: use `CHAT_MODEL_CONCURRENCY` and `ANALYSIS_MODEL_CONCURRENCY`.
- `UPSTREAM_CONCURRENCY`: use verified account rules in `UPSTREAM_CAPACITIES`.
- `QUOTA_ACTIVE_ANALYSIS_JOBS`: obsolete duplicate; use the personal analysis settings.
- `PROVIDER_GATE_POLL_MS`, `SESSION_LOCK_WAIT_TIMEOUT_MS`: polling/backoff and
  same-conversation exclusion are internal behavior.

Nonempty obsolete variables fail startup with a migration message. Stop/drain old
API and workers before switching the admission protocol; do not mix old and new
workers. Use consistent resource settings across replicas. This change adds no
new SQL migration, but still requires the repository's existing migrations.

Metrics now distinguish stage waiting/execution, active stages and reserved memory.
Child model metrics are aggregated into the supervisor without process-ID labels.
Duration buckets extend to one hour. Use actual user waiting, first response,
completion times and failures alongside CPU, RSS, database and upstream metrics.

Functional checks cover shared admission, cancellation, expiry, checkpoint recovery,
personal quotas across real subprocess boundaries and publication. They are not
load tests. Tune capacities later by bottleneck: measure a baseline, vary one
resource pool at a time, then verify a few mixed workloads and failure cases.
There is no need to enumerate every possible configuration combination.
