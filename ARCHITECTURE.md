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
job, and moderation-history tables and their persistence constraints. It does
not implement listing submission, moderation decisions, worker claim/retry
behavior, or dynamic readiness; those behaviors belong to later tasks.

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
