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
keyword snapshots. Normal non-trusted listings require an explicit R3 fact; T06
does not query or commit R3. No route or worker job loop invokes this evaluator
yet. Worker decision commit, claim/retry behavior, and dynamic readiness belong
to later tasks.

The submission pipe checks persisted text fields before database access: title
and description reject U+0000 and unpaired UTF-16 surrogates with 400; reference
IDs containing those values return 422. Valid Unicode scalar text is stored
unchanged. Unknown JSON properties remain in the idempotency hash but are not
written to PostgreSQL text columns.

## Transactions and ownership

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
