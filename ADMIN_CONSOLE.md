# Admin console

[简体中文](ADMIN_CONSOLE.zh-CN.md) · **English**

The `/admin` console serves one configured administrator. It includes overview, tasks and users, agents and providers, budgets, feedback and self-evolution, storage, and audit records. Desktop and mobile layouts use system fonts. Generic code is public; real identity bindings, secrets, deployment settings and runtime data remain private.

## Authentication and setup

Administration is disabled without `WHAT_THE_REPO_ADMIN_GITHUB_ID`. Use the immutable numeric GitHub account ID, never a username or first-login assignment. Production requires PostgreSQL, HTTPS and a `WHAT_THE_REPO_KEY_ENCRYPTION_SECRET` of at least 32 characters (or its `_FILE` form), shared with API, analysis and evolution workers. Apply migrations including `0020_admin_console.sql` before enabling this version.

Generate a bootstrap credential in a private file with `node scripts/create-admin-bootstrap.mjs .secrets/admin-bootstrap.txt`. The script refuses overwrites and prints only its SHA-256 digest. Configure that digest as `WHAT_THE_REPO_ADMIN_BOOTSTRAP_SHA256`. Sign in with the configured GitHub account, enter the bootstrap credential, scan the Authenticator QR code and confirm a TOTP code. Save the ten recovery codes shown once. Bootstrap credentials cannot replace an already-bound authenticator.

GitHub plus TOTP is required at login. Ordinary operations use the authenticated session, without another OTP for each operation. Sessions have an eight-hour maximum and expire after 30 minutes without authorized requests; logout revokes the current session immediately. Every management endpoint authorizes server-side; mutations also require approved origin, a dedicated request header and a CSRF token.

TOTP uses SHA-1, six digits, 30-second steps and a one-step clock tolerance. Accepted steps cannot be replayed. Five failed attempts lock verification for 15 minutes across restarts and processes. Seeds use AES-256-GCM encryption; recovery codes are stored only as digests. Audit logs exclude keys, seeds, codes and request bodies. Tests include [RFC 6238 vectors](https://www.rfc-editor.org/info/rfc6238/); replacement follows the account-protection principles in the [OWASP MFA guide](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html).

To replace an authenticator, log out, repeat GitHub login and prove the current TOTP or a one-use recovery code on the verification page. Existing sessions are revoked. A replacement must be confirmed before issuing a new session and recovery codes. Recovery never directly grants management access. Losing both factors requires private operator recovery of stored state; there is no public reset or first-user takeover endpoint.

For a separate HTTPS hostname, configure `WHAT_THE_REPO_ADMIN_WEB_URL=https://admin.example.org` and route its `/api` requests to the API and pages to the Web build. Set the gateway's fixed `GITHUB_GATEWAY_ADMIN_CALLBACK_URL=https://admin.example.org/api/auth/github/callback`. Signed OAuth requests carry an admin audience; ordinary users retain their existing callback. Cookies do not use a shared parent domain. The code does not change DNS, certificates, ingress or production settings automatically.

Deployment integration: optional k3s settings are in `.env.k3s.example`, and gateway settings are in `.env.github-gateway.example`. The evolution Secret must contain the same `key-encryption-secret` as API and analysis workers. Updating only its image without this Secret mount cannot enable encrypted provider configuration. Static template checks do not establish an installed, connected production service.

## Budgets and attribution

| Budget | Initial program setting | Scope |
| --- | --- | --- |
| Platform daily analysis | USD 5 | Shared repository analysis, semantic helpers and language overlays |
| Platform daily free chat | USD 5 | Free chat and route, citation, memory and other chat helpers |
| Evolution per task | USD 1 | All calls within an individual feedback-analysis or candidate-generation task |
| Evolution daily total | USD 5 | Platform feedback analysis and candidate generation combined |

Amounts are edited in the console. `null` means genuinely unlimited; zero disables new paid calls. Unlimited on one applicable budget never bypasses another finite budget. Legacy per-owner and mixed daily monetary limits and `WHAT_THE_REPO_EVOLUTION_MAX_COST_USD` are ignored. Personal monetary limits and a personal-quota panel are not enabled.

BYOK chat and helpers use the selected user's key. They do not debit platform budgets or face site daily monetary restrictions. Shared public repository analysis remains platform-funded regardless of the triggering identity. Manual user model verification is attributed to BYOK; feedback analysis belongs to platform evolution. Events record business, payer, agent role, connection, task and configuration version. Unclassifiable older events remain `historical_unclassified`.

PostgreSQL atomically reserves finite budgets before model transport. Known usage settles the reservation; missing usage, uncertain cancellation and interrupted calls retain it. Duplicate callbacks cannot double-charge or refund. Reservations use conservative model limits, so admission may stop before the last remaining dollar can fit another request. Costs are program estimates, not provider invoices. Models without reliable price metadata cannot run against a finite platform budget; unlimited and BYOK calls retain an unknown-cost marker instead of being represented as free.

Daily reset follows the **Asia/Shanghai calendar day**. Analysis and free-chat exhaustion have separate `site_analysis_budget_exhausted` and `site_chat_budget_exhausted` codes and ask users to try tomorrow. Zero budgets use `site_budget_disabled`, with no promise of tomorrow's recovery. Upstream balance, rate limits and storage have separate errors. HTTP responses, chat streams and job status reuse existing error UI, without retrying monetary failures as network disconnects. Existing results remain readable, BYOK remains available when free chat is exhausted, and evolution exhaustion does not stop the site.

Concurrency, frequency, queue, step, time and token protections remain deployment controls, viewable but not editable in the console. Usage displays known spend, held reservations, remaining estimates, reset time and unknown calls. Per-task evolution totals span calendar days.

## Configuration, review and monitoring

Feedback lists show GitHub usernames and display names, with numeric identities retained for reference. Users and guests use server-side pagination with 25 rows per page.
JSON and code details use syntax highlighting. Candidate changes open in a unified Git diff dialog with addition/deletion colors, old/new line numbers and highlighted code; Escape closes the dialog.

Connections can be reused by multiple agents. Stored keys show only masked tails. Changing a destination requires re-entering the key. Connection verification only requests the model catalogue, without paid inference; catalogue success does not prove paid inference acceptance. Each save creates a configuration version. Analysis and evolution jobs pin their version when created; each chat turn and its helpers use one captured version. Version zero denotes deployment defaults, whose later changes still require the deployment process to drain existing work.

Feedback includes votes, analyzed signals, source requests, candidate diffs, checks, evaluations, usage, reviews and version history. The “Approve and publish” operation is queued durably for the existing evolution worker's review/publish/rollback logic. Interrupted publishing commands are not automatically replayed: inspect the current registry and task ledger before resolving an uncertain result. Configuration, budgets, reviews, cleanup and authentication outcomes are audited.

Online means **an identity with a foreground heartbeat in the last 90 seconds**. Visible tabs send every 25 seconds; the server deduplicates tabs sharing an account or visitor-browser identity. Mobile background tabs stop renewing and disconnected identities expire. Visitor counts approximate browser identities, not real people. Existing request, model, queue and database metrics are reused. Worker observations older than 45 seconds are stale; missing or unknown values are not healthy zeroes. Existing Prometheus/Grafana examples remain available.

## Storage

The overview charts show stored GitHub accounts versus guest browser identities, plus hourly average and peak online counts by default. A one-hour minute view is available. The collector stores one count-only aggregate per minute, retains seven days and displays the latest 24 hours. Averages use observed minutes only; coverage, missing intervals and samples older than 90 seconds are explicit. No individual browsing history is recorded. Apply `0021_admin_audience_samples.sql` and grant the runtime role table access.

Capacity fields and displays use decimal GB (1 GB = 1,000,000,000 bytes). APIs continue to use bytes; an unchanged form preserves the exact original value. COS price estimates retain their USD/GiB/month basis with a visible GB conversion.

Model administration covers platform connections only: free chat, repository analysis, feedback analysis, evolution and analysis helpers. Learning routes, understanding assessment, citation review and memory maintenance always follow the conversation's selected model and payer. They have no independent admin setting and ignore legacy deployment helper overrides.

COS policy prefix conditions must URL-encode slashes as `%2F`; the trailing wildcard allows object-specific version listing within the same product prefix. See [Tencent Cloud condition-key documentation](https://cloud.tencent.com/document/product/436/71307).

The former per-user 4 GiB snapshot cap is removed. Time-based visitor lifecycle remains independent: empty visitors expire after seven idle days; visitors with projects are soft-deleted after 30 idle days with a seven-day recovery window.

Snapshot reclamation scans only when capacity is low, selecting aged, unreferenced candidates for administrator-confirmed deletion. The delete transaction rechecks project bindings, repository heads, snapshot state and active work. Any queued/running job conservatively blocks snapshot reclamation. User deletion, temporary-file cleanup and security expiries follow their own rules.

Host admission measures real filesystem capacity. Defaults reserve 2 GiB for system/database work and 1 GiB per queued/running task, warn at 8 GiB and resume admission at 4 GiB. The console edits policy; `WHAT_THE_REPO_STORAGE_VOLUME_PATHS` lists additional actual mounts separated by semicolons. Low or unknown capacity blocks new analysis/overlay processing while read, admin and cleanup access remain available.

COS uses paginated object inventory and configured capacity/monthly-cost budgets, never a fictitious disk-free percentage. Inventory expires after five minutes; finite COS budgets fail closed when usage is unknown. Refresh inventory in the console. Monthly cost is an estimate using the configured storage unit price and excludes request/traffic charges. Deleting COS objects does not free host space, and deleting database rows does not guarantee immediate database file shrinkage. Candidate estimates deduplicate object keys; unavailable sizes remain unknown.

Inventory covers completed objects under the configured COS prefix, including retained historical versions. It requires versioning-state and object-version-list read permissions; failed collection remains unknown. Administrator-confirmed reclamation permanently deletes all versions and delete markers for the unreferenced snapshot. Ordinary deletion keeps its previous semantics. Reference/job locks remain held through deletion; object failures are reported and leave the candidate retryable.

## Local verification

For persistent development on Windows, run `powershell -ExecutionPolicy Bypass -File scripts/start-admin-dev.ps1` from the repository root.
It reuses PostgreSQL on loopback port 15432 and creates a separate `wtr_admin_preview_dev` database. It does not load production connections, model keys or COS settings.
Open `http://127.0.0.1:5391/admin`; synthetic data controls and the local test authenticator code are at `http://127.0.0.1:8491/`.
The frontend hot reloads the same React source; backend source changes restart the local API. Five audience scenarios cover a full day, low counts, collection gaps, empty history and stale samples.
Users, feedback, candidates and review history are synthetic. Switching scenarios replaces only audience fixtures in this development database; refresh the console to view them.
Candidate publication is disabled in this development entry. Production collection, paid models and publication require separate verification.
Credentials, logs and persistent state remain in ignored `.local/admin-preview-dev/`. Restarts preserve settings and unexpired sessions. The bottom-right link opens the controls; your personal Authenticator is not needed.
Production updates require a separate deployment. Local hot reload does not change the server, and Git push alone is not deployment.

Both hourly and minute trends use straight segments without curve smoothing. Missing hours or minutes remain gaps. Selection reveals a guide and small markers; low counts and isolated observations remain inspectable.

The API collects COS inventory every two minutes even when the console is closed. Failures retain the previous timestamp; samples older than five minutes become unknown. The product CAM policy needs `GetBucketVersioning` and product-prefix-limited `GetBucket`/`GetBucketObjectVersions` read permissions; see `infra/tencent/cam-product-objects-policy.json`. Bucket versioning settings and access to database backup objects remain separate.

Build and test each of the three packages separately. Normal server tests exercise isolated file-mode authentication; PostgreSQL tests skip without their dedicated test URL. `node scripts/test-admin-postgres.mjs` reads ignored local credentials, accepts only loopback port 15432, creates a separate `wtr_admin_test_*` database and deletes only that test database afterward.

For an isolated preview, run `node --import tsx src/smoke/admin-preview.ts` in `server`. In `web`, set `WHAT_THE_REPO_BACKEND_URL=http://127.0.0.1:8390`, then run `npm run dev -- --port 5390`. Open `http://127.0.0.1:5390/admin`. A loopback mock gateway on 8490 supplies a dedicated test identity, but the actual signed callback, bootstrap and TOTP flow still run. Private fixture credentials are written under `.local/admin-preview-*`, never printed. Production mode refuses this entry point.

Run `node scripts/smoke-admin-preview.mjs <fixture-directory>` from the root for desktop/mobile acceptance with that test identity. It saves only isolated test-session data and screenshots. Model tests use mocks; paid provider and production acceptance are separate activities. Passing local tests does not establish production readiness.

After acceptance, run `node scripts/open-admin-preview.mjs <fixture-directory>` to open an interactive Chrome preview with the isolated session.

The preview includes isolated sample tasks, usage and a candidate. Configuration and budgets are editable. It has no analysis or evolution worker, so the sample candidate cannot be published; separate tests verify the server-side review, publication and rollback flow.

The analysis task list groups the current or latest analysis by repository instead of conversation title. Participants come from that shared analysis batch, excluding later cache reuse. User lists put identities with a foreground heartbeat in the last 90 seconds first. User and repository tables support pagination and page-number jumps. Repository rows show two users, with a dialog for all remaining users. Console text uses system fonts; code uses monospace.

Storage lists retained repository versions, COS objects including retained object versions, server snapshot/source files, associated database records and indexes, distinct users, and the last conversation time supported by the analysis version recorded on user messages (missing historical attribution stays unknown). Shared database pages are allocated by row-count estimates, not claimed as immediately reclaimable disk space. Conversation history is retained when analysis payloads are removed. Missing or expired object inventory remains unknown.

Administrators preview impact and type the repository name before deleting analysis data. Version/reference changes invalidate confirmation; active conversations use a database shared lock that excludes deletion, and queued/running analyses block cleanup. A durable withdrawal precedes object/index deletion. Partial failures remain unavailable for reuse and can be retried from the repository list. This manual workflow is separate from low-capacity discovery of unreferenced old snapshots and existing guest lifecycle cleanup.
