# Source snapshot storage

For the overall database/object split, cache limits and format upgrade boundary,
see [object-backed repository analysis](object-storage.md).

Published source snapshots use an immutable file index and bounded object packs.
This reduces object-storage request overhead for repositories containing many
small files while preserving independent file access.

## Writing and publication

Files are ordered by path and grouped into packs containing at most 4 MiB of
original content or 1,024 files. A single file cannot exceed the acquisition
limit of 4 MiB. Four packs are prepared/uploaded concurrently by default; within
each pack, at most eight files are read and compressed concurrently. Object
requests also pass through the shared runtime storage admission limit.

Each file is compressed independently with gzip level 3 when it saves bytes.
Files smaller than 128 bytes skip compression. The pack concatenates these
independent frames. Its key includes its ordinal and SHA-256; identical content
and grouping produce the same keys on retry. The raw size bound is not a process
memory cap: file buffers, compression output, concatenation and index metadata
also occupy memory. No whole-repository content buffer is required.

The version 2 index stores each pack key once and records each file's pack
number, byte offset, stored length, encoding, original length and SHA-256.
Canonical serialization keeps its digest stable after a JSONB checkpoint
round trip. Writers reject changed file lengths and unsupported filesystem
entries. Readers validate paths, pack ownership, contiguous ranges and sizes.

All packs must finish before the source index is uploaded. Publication commits
the snapshot metadata and query directory in one PostgreSQL transaction.
Cancellation drains already-started uploads, stops queued work and rejects the
prepared result, including cancellation during the final index upload. Objects
already uploaded may remain unreferenced until existing snapshot cleanup runs;
their presence does not make a snapshot visible. A completed prepared source
checkpoint can be reused after local source files are removed. A partial upload
does not have a per-pack resume checkpoint and may repeat PUTs on retry.

## Reading and cleanup

Local and COS adapters fetch only the requested file's encoded range. COS
responses must return HTTP 206, matching Content-Range and exact byte count.
Decompression is bounded by the declared original length, then the original
length and SHA-256 are verified. Empty files need no content download. Index
fetching and validation still occur before file access; the index is cached.
Range requests consume the same storage permits as other object requests.

Version 1 indexes remain readable through their original per-file object keys.
Adapters without range support may fall back to fetching one bounded pack;
production local/COS adapters support ranges. Cleanup retains existing snapshot
reference checks and deduplicates object keys, since many files share a pack.
No database migration or historical snapshot rewrite is required.

Tests cover packing limits, random access, integrity failures, cancellation,
legacy reads and cleanup. The dedicated PostgreSQL test is enabled with
`WTR_ADMIN_TEST_DATABASE_URL` pointing to a disposable loopback database named
`wtr_admin_test_*`. Real COS validation remains available through the existing
`npm run smoke:cos` command and requires explicit credentials and authorization.
