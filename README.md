# Listing Moderation Service

## Local lifecycle

The API and standalone worker run in Docker containers alongside PostgreSQL 16.
Before the API starts listening or the worker announces startup, both processes
connect to PostgreSQL, acquire the shared transaction-scoped bootstrap lock,
apply pending checksummed SQL migrations, and upsert the reference seed data.
The API exposes `GET /livez`, which reports listener liveness, and `GET /readyz`,
which reports database readiness. The listing
submission and read routes are available as described below. A separate worker
process claims database jobs and commits automated moderation results.

```sh
make run                 # foreground; API at http://localhost:8080
PORT=8081 make run       # publish the API at http://localhost:8081
make test                # build and run the isolated containerized suite
make smoke               # Docker-backed lifecycle, asset packaging and restart checks
```

`make run` keeps its workspace-specific named database volume across normal
shutdowns. `make test` uses an invocation-specific Compose project and removes
only that project's verified-owned test volume after the runner exits. Both
commands refuse pre-existing containers and networks for the selected project;
`make run` reuses its database volume only when its workspace/mode labels match.
The first run creates the T02 schema and loads 8 sellers, 5 categories, and 6
banned keywords from `seed/`. Later starts verify migration checksums and
restore seed rows from those files. Rows outside the seed files are preserved.
The shared HTTP transport reads JSON without rounding integer tokens, validates
listing request shapes through its production pipe, and emits bigint values as
JSON numbers. It rejects request bodies over 1 MiB, nesting over 128 levels,
duplicate keys, malformed UTF-8 and unsupported JSON media/encoding.
`POST /v1/listings` is implemented in T04: it atomically stores a pending
listing and queued job, supports optional `Idempotency-Key` replay, and does not
run moderation inline. T05 implements `GET /v1/listings/{id}` and
`GET /v1/listings` through the same production mapper. List filters are exact
`seller_id` and `status` matches with a default limit of 20 (maximum 100),
ordered by `created_at DESC, id DESC`. Int64 prices and decision JSON values
retain numeric precision in responses. The worker processes one job at a time per
process using PostgreSQL leases and row locks. Each job receives at most five
claims, including lease recoveries; failed attempts use bounded full-jitter
backoff, and exhausted jobs become `failed` while their listing remains pending.
Malformed running-job metadata and a live job attached to a non-pending listing
are quarantined for operator inspection. Requeue is a guarded SQL operation and
requires confirming the listing is still pending. The worker handles SIGTERM and
SIGINT by stopping new claims, waiting for active work, and closing its database
pool; a forced kill is recovered after lease expiry.
`POLL_INTERVAL_MS` defaults to 1000 and accepts integer milliseconds from 1 to
2,147,483,647; larger delays are rejected to prevent Node timer overflow.
`POST /v1/listings/{id}/decision` resolves only a `needs_human` listing: approve
publishes it and reject marks it rejected, with the current decision and human
history committed atomically. After an automated approval, the worker publishes
the persisted listing in a separate recoverable lifecycle transition. Both
publication paths set `published_at` and `expires_at` from PostgreSQL time using
`LISTING_TTL_DAYS`, which defaults to 30 and accepts a positive decimal safe integer;
one day is defined as 24 hours. The worker expires published listings in bounded
database-clock batches after their persisted deadline. A permanently failing
oldest auto-approved row can block later publications until
an operator resolves it; T09 does not add poison-row quarantine or fairness
scheduling.
If the lifecycle lock is left behind after a forced kill or machine crash, inspect
the PID file and Docker resources before removing the stale lock directory under
`${TMPDIR:-/tmp}`.

The shell lifecycle requires a POSIX shell, GNU Make, Docker with Compose v2,
GNU coreutils (including `timeout`), `curl` for smoke checks, and standard POSIX utilities. It does not require host
Node.js, npm, TypeScript, or PostgreSQL. On Windows use Ubuntu/WSL2 or Git Bash
for Make and Docker commands; PowerShell can be used separately for Git review.

## Repository references

- `openapi.yaml` is the authoritative HTTP contract.
- `seed/` contains the reference seller, category, and banned-term data.
- `AGENTS.md` records repository implementation and verification constraints.
- `Makefile.example` is a starter reference, not an active implementation.

The original exercise brief is supplied separately and is not needed by runtime
or test commands. Task execution notes and review evidence are kept in ignored
`.local-docs/` files.

## Operational checks and failed jobs

`/livez` returns `200 {"status":"ok"}` while the API listener can respond. It
does not query PostgreSQL or the worker. `/readyz` returns the same 200 response
after this API instance has completed bootstrap and a short PostgreSQL probe
succeeds. It returns `503 {"status":"not_ready"}` when the database cannot be
probed or the instance is draining. A process that has exited has no HTTP
response. The readiness probe uses the API pool, a 5-second checkout timeout
and a 1-second query timeout; these are not a hard 6-second wall-clock bound.

Worker JSON events contain system-generated listing/job IDs, attempt, phase,
safe error category and, for completed moderation, outcome and evaluated rule
IDs. They never intentionally contain claim tokens, listing text, moderator
notes, database URLs, raw error messages or stacks. Search for
`worker_job_attempt_failed`, `worker_job_exhausted`,
`worker_job_quarantined`, `worker_claim_recovered`,
`worker_publication_failed` and `worker_expiry_failed`.

Run `ops/inspect-jobs.sql` with a PostgreSQL client connected to this service's
database. It is read-only and reports job/listing IDs, attempts, lease and
availability times, safe last error, listing status, history count and a
DB-clock classification. An expired lease is recoverable while attempts remain;
at five attempts it is exhausted and the worker marks it failed. Lease expiry
does not prove its old process has exited. Check worker logs and
database availability before acting. Publication backlog can be inspected with
`SELECT id,status,created_at,version FROM listings WHERE status='auto_approved'
ORDER BY created_at,id;`; expiry backlog with
`SELECT id,status,expires_at,version FROM listings WHERE status='published'
AND expires_at<=clock_timestamp() ORDER BY expires_at,id;`. A persistently
invalid oldest publication row can block later rows until repaired.

For a failed moderation job, inspect its listing, job, and history first. Only
requeue a job whose listing is still `pending` and has no committed phase
history. In an **interactive** `psql` session set `listing_id`, `job_id`,
`expected_attempts` and `expected_error` to the exact inspected values, then
run `\i ops/requeue-failed-job.sql`. The script starts a transaction, locks the
listing before the job, and performs a guarded update. **COMMIT only if the
final UPDATE returns exactly one row**; otherwise `ROLLBACK` and inspect again.
Exiting psql without COMMIT rolls back. The script resets attempts to zero,
granting a fresh five-claim budget, so it requires a human decision after the
underlying fault has been addressed. Never requeue a failed job attached to a
non-pending listing or manually remove history to bypass the guard.
