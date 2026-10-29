# Architecture

## Runtime processes

Docker Compose runs PostgreSQL, a NestJS HTTP API, and a separate NestJS worker.
Both Node processes use the same `pg` database module and bootstrap sequence.
The API factory completes database startup before the executable calls `listen`;
the worker sends `worker-started` only after its database-backed Nest context is
created. A bootstrap error exits startup and closes the pool.

## Database bootstrap

`src/db/assets.ts` validates the repository seed files and loads an explicit SQL
migration manifest. `src/db/database.ts` owns a PostgreSQL pool. On startup it
uses one checked-out client for a transaction-scoped advisory lock, the migration
ledger, any pending migration, and seed upserts. The lock serializes API/worker
startup on a new database. Migration checksums detect edits to an applied SQL
file; an unknown or non-prefix migration history stops startup without resetting
the database.

Connections, including PostgreSQL authentication/handshake, have a five-second
timeout. The separate five-second `lock_timeout` limits bootstrap lock waits;
neither setting is a total deadline for running migrations or seed SQL.

The versioned SQL in `migrations/` creates the reference, listing, idempotency,
job, and moderation-history tables and their persistence constraints. The API's
`POST /v1/listings` validates through the shared lossless JSON transport, then
uses the submission service and PostgreSQL repository to atomically persist a
pending listing, one queued moderation job, and an optional idempotency key.
The repository resolves concurrent key races only after the losing transaction
rolls back; a replay returns the persisted listing's current status. Submission
does not evaluate moderation rules or create a decision/history record. T05 adds
GET one/list through the same `SubmissionModule` database registration. The read
repository selects `price_vnd::text` and `decision::text`; one mapper validates
the persisted state, parses decision JSON losslessly, and projects only public
DTO fields before the shared JSON response interceptor serializes it. List SQL
uses parameterized exact filters and `created_at DESC, id DESC`; `created_at`
ordering retains PostgreSQL timestamp precision even though public ISO strings
are formatted to milliseconds. Malformed known query encodings return 400 while
malformed unknown extension values are ignored. T06 adds a pure R1/R2/R4/R5
evaluator and a read-only repository for persisted seller, category, and banned
keyword snapshots. Normal non-trusted listings require an explicit R3 fact;
R3 arbitration is performed by the transaction-bound automated listing
repository. The database-backed worker described below invokes that production
evaluation path.

The worker claims due jobs with PostgreSQL row locks and `SKIP LOCKED`, records a
UUID claim token and a 30-second database-clock lease, and processes one job at a
time per process. Claims include crash/lease recoveries and are capped at five;
retry scheduling uses full jitter with an exponential ceiling capped at 30 seconds.
An automated listing decision, append-only `auto` history row, and guarded job
completion commit in one transaction. The repository reuses the T07 evaluator and
R3 arbitration against the caller's transaction; production listing mapping
validates the persisted decision before history is written. Failed attempts retain
the listing as pending, store only a sanitized diagnostic, and become `failed`
after exhaustion. Malformed live running metadata and live jobs pointing to a
non-pending listing are quarantined as failed without changing listing/history.
An operator may requeue a failed job only after inspection and confirming its
listing remains pending; the guarded SQL template is in the T08 execution log.
The worker shutdown stops new claims and polling, waits for its active operation,
then closes the database pool. A forced process death leaves the lease for later
recovery.
The polling interval defaults to 1,000 milliseconds and is bounded to the Node
timer range of 1 through 2,147,483,647 milliseconds at both configuration and
worker-loop construction boundaries.

The submission pipe checks persisted text fields before database access: title
and description reject U+0000 and unpaired UTF-16 surrogates with 400; reference
IDs containing those values return 422. Valid Unicode scalar text is stored
unchanged. Unknown JSON properties remain in the idempotency hash but are not
written to PostgreSQL text columns.

## Human decisions and publication

`POST /v1/listings/{id}/decision` is registered through the production human
module and transport. Its pipe validates/projects the request before the service
calls `HumanDecisionRepository`. The repository locks the listing in a
READ COMMITTED transaction and accepts only `needs_human` with a mapped
`escalated` decision and NULL publication timestamps. It writes the replacement
HUMAN decision, one DB-clock `decided_at`, and one human history row in the same
transaction. Approval also sets `published_at` to that same instant and derives
`expires_at` using exact 24-hour days; rejection leaves both publication times
NULL. Conflicting requests see the committed terminal state and return 409.
Moderator metadata is retained in internal history, not exposed in the public
decision.

The worker runs `PublicationRepository` after its moderation work, scanning at
most one persisted `auto_approved` row per tick. It uses row locking with
`SKIP LOCKED`, validates the stored approval through the production mapper,
then updates status/timestamps/version transactionally. This lifecycle update
does not write another moderation history row or alter the automated decision,
`decided_at`, or job. A committed row remains discoverable after worker restart.
Publication SQL errors are logged separately from moderation failures and the
row remains eligible for a later scan. A permanently failing oldest row can
starve later rows; an operator must resolve the underlying data/SQL problem.
There is no publication quarantine or fairness scheduler in this design.
After publication the same worker loop runs a bounded expiry batch using the
PostgreSQL transaction clock. It changes only due `published` rows to `expired`
and increments their lifecycle version. A partial deadline index covers
published rows; expired rows retain the current decision, decided_at and audit
history. Restarted workers continue scanning persisted overdue rows.

## Transactions and ownership

The API health module owns both `/livez` and `/readyz`. Liveness reports only
that the listener can answer. Readiness uses the same bootstrapped `Database`
instance as listing routes and a bounded `SELECT 1`; it coalesces simultaneous
in-flight probes without caching a previous success. A failed probe returns a
public 503 without database details. A successful bootstrap is remembered for
this process; the probe does not rescan migrations or seeds on each request, so
it cannot detect every later schema or seed mutation. Shutdown marks readiness
draining before the pool closes. The probe releases checked-out clients and
destroys one after query error or timeout; the driver's client-side timeout is
not a claim that PostgreSQL cancelled a server-side operation.

Worker completion metadata comes from the mapped persisted decision inside
the automated commit transaction and is logged only after commit. Claim recovery,
quarantine, exhaustion and stale results use allowlisted identifiers and safe
diagnostics. The read-only operator SQL and guarded requeue template live under
`ops/`; these are manual operational aids, not unauthenticated HTTP endpoints.

`src/db/transaction.ts` checks out one `PoolClient` and uses it for `BEGIN`, all
callback statements, and `COMMIT` or `ROLLBACK`. The callback must not issue
transactional work through `Pool.query`. Each `Database` owns its pool and closes
it through the Nest shutdown lifecycle. Tests create uniquely named databases
inside the isolated Compose PostgreSQL service and drop them only after their
application pools are closed.

The helper returns a callback result only when PostgreSQL reports the `COMMIT`
command. A callback that catches a SQL error may leave an aborted transaction;
if PostgreSQL ends it with `ROLLBACK`, the helper rejects and discards that
checked-out client. Callback work is never automatically retried after a commit
failure with an uncertain outcome.

## Runtime assets

The final API/worker image contains compiled JavaScript plus `seed/` and
`migrations/`. Asset lookup is rooted at the compiled application location, not
the process working directory. The test image also contains these files and
uses the real PostgreSQL service for integration tests.
