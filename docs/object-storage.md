# Object-backed repository analysis

Published repository content lives in immutable objects (Tencent COS in a
configured deployment; the local object adapter in development). PostgreSQL
owns users, permissions, jobs, conversations, snapshot bindings and compact
query indexes. An object cache is disposable: evicting it never deletes content
or requires another analysis.

## Persistent data

Canonical snapshot rows contain object keys, byte counts, SHA-256 digests and a
small conversation summary. Complete view and analysis JSON are never inlined.
Analysis arrays already use compressed chunks; [source packs](source-snapshots.md)
support independently verified file-range reads. Complete language overlays
also use immutable objects, with a separate bounded summary for conversation
context.

Query-directory nodes keep one stable key, a numeric row ordinal, a numeric
parent, filter fields and searchable text. Edges reference numeric endpoint
ordinals; evidence rows contain identity and ordinal, and evidence links contain
numeric references. Names, attributes, detailed evidence and response metadata
are stored in compressed directory objects. Node/edge display payloads and
evidence text are not duplicated in database rows.

Directory chunks target 256 KiB before compression and at most 512 rows. An
indivisible large row is isolated, with a 32 MiB row/decompression limit. The
generation manifest maps row ranges to immutable object descriptors. SQL first
selects a page, then the reader fetches its covering chunks with bounded
concurrency. Internal Agent calls omit unused metadata; public callers requesting
metadata receive the existing complete metadata sections.

Text search covers human-readable node names, labels, responsibilities and
paths, and relation kind, label and description. It no longer searches arbitrary
serialized JSON attributes or machine IDs. Exact entity and symbol IDs remain
available through the explicit ID filters. Punctuation is literal search text;
it does not activate a full-graph fallback scan.

## Cache and memory

`WHAT_THE_REPO_OBJECT_CACHE_BYTES` defaults to 67,108,864 bytes per process.
`WHAT_THE_REPO_OBJECT_CACHE_ENTRY_BYTES` defaults to 8,388,608 bytes. Setting the
total to zero disables retained object bodies. The cache also caps its entry and
in-flight bookkeeping, merges simultaneous reads of the same object/range, and
evicts least-recently-used entries. Whole-object reads validate the digest in
the content-addressed key before retention; consumers also verify their trusted
descriptors. Returned buffers do not alias cached buffers.

These are retained-byte limits, not total process RSS limits: response buffers,
decompression and parsed JSON still consume transient memory. The parsed source
manifest cache separately allows at most eight entries and an estimated 8 MiB
weight (or the smaller configured object-cache budget). Its estimate includes
serialized text and per-file bookkeeping. API replicas and analysis child
processes each have their own budgets. No persistent local disk cache is added.

## Publication and reclamation

A generation and each planned object key are committed through the control
connection before upload, even with a one-connection business pool. Each upload
adds one bounded intent row; the complete manifest is written once, avoiding
repeated rewrites of a growing JSON document. Staging removes the temporary
intent rows only after the complete manifest has been committed.
An interrupted upload or a rolled-back publication therefore leaves recoverable
ownership metadata. Only the final database transaction publishes the complete
directory pointer together with canonical snapshot metadata.

Readers hold a read transaction while loading directory objects. Reclamation
waits for transactions that could still see the retired generation, removes its
database children, then commits object-deletion work before removing generation
metadata. Failed deletions remain in an independent retry ledger. Generation
paths are unique, so deleting retired directory chunks cannot delete a later
generation's chunks. Whole-snapshot cleanup also includes its directory and
language-overlay objects.

## Upgrade boundary

Migrations 0038 and 0039 deliberately reject an existing analysis dataset with
`storage_format_reset_required`; 0041 similarly rejects old language-overlay
rows. This release targets development/test data and supplies no legacy format
conversion. Drain old application/worker processes and explicitly remove old
test analysis data and its object namespace, or provision fresh test storage,
before applying the new migrations. Do not erase unrelated user or deployment
configuration as an incidental migration step. No production data is cleared
automatically. Old and new application versions must not share the upgraded
schema.

## Validation

The directory reader's isolated PostgreSQL tests compare paging, filtering,
hierarchy, neighbors, projections and evidence budgets against the shared
in-memory contract. Separate tests exercise corruption, cache eviction,
concurrent reads, failed uploads, rollback recovery, reader pinning and cleanup
retries. No paid model request is needed.

`directory-storage-benchmark.postgres.test.ts` builds the same synthetic graph
against the real pre-0038 and current table/index layouts. It reports physical
database bytes and cold/warm local object-read counts, and checks returned rows
for equality. It is an opt-in disposable-PostgreSQL test, not a live COS latency
or production capacity benchmark. Current COS space is measured separately by
the object inventory, including retained historical versions; database file
reclamation and object deletion are distinct operations.
