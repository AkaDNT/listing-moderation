# Listing Moderation Service

A listing moderation service built with TypeScript, NestJS and PostgreSQL.
The API accepts submissions for asynchronous evaluation, supports human review,
and exposes the current moderation result. A separate worker evaluates rules,
publishes approved listings and expires them when their publication period ends.

The service preserves int64 prices throughout JSON transport and database storage.
Database transactions coordinate concurrent submissions, worker attempts and
human decisions. See [ARCHITECTURE.md](ARCHITECTURE.md) for the design and
[ASSUMPTIONS.md](ASSUMPTIONS.md) for decisions about ambiguous requirements.

## Run locally

Use Linux or Ubuntu/WSL2 with Docker Engine/Desktop running, Docker Compose v2
or later, GNU Make, a POSIX shell, GNU coreutils (including `timeout`), and standard
POSIX utilities. Smoke checks also require `curl`. Registry access is needed for
image pulls and npm package installation inside the build. Host Node.js, npm,
TypeScript and PostgreSQL are not required. On Windows, run the commands below
inside WSL from the repository directory.

```sh
make run                     # foreground; http://localhost:8080
# In another terminal:
curl -i http://localhost:8080/readyz
```

Stop with Ctrl+C. The API and worker start only after migrations and seed loading
succeed. The first start loads 8 sellers, 5 categories and 6 banned keywords.
Subsequent starts verify migration checksums and restore seed-file rows; extra
reference rows are preserved. The workspace-specific database volume survives
normal shutdown. Moving the checkout to another path selects another default
Compose project and volume.

```sh
PORT=8081 make run            # host port 8081; container API still uses 8080
LISTING_TTL_DAYS=7 make run    # use the same publication TTL in API and worker
make test                    # isolated PostgreSQL and containerized test runner
make smoke                   # Docker lifecycle, restart/persistence and outage checks
```

Run `make test` from a separate terminal if `make run` is active; test resources
have their own invocation-specific project. No pre-running application is needed.
A successful test run ends with `fail 0`, no cancelled tests, and exit code 0.
Build, assertion and cleanup failures propagate as nonzero exits. Some tests
intentionally generate PostgreSQL ERROR messages; use the TAP result and command
exit status to determine success. `make smoke` also intentionally executes a
failing assertion to verify failure propagation.

The lifecycle checks resource ownership before cleanup and refuses pre-existing
containers/networks for its project. Run mode preserves its owned database volume;
test mode removes its test volume. It never performs a global Docker prune.

## HTTP usage

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/livez` | 200 while the API listener can respond |
| GET | `/readyz` | 200 after bootstrap when the database is reachable and the API is not draining; otherwise 503 |
| POST | `/v1/listings` | New submission: 202 with `id` and `pending`; same-key replay: 200; key reused with a changed body: 409 |
| GET | `/v1/listings/{id}` | Current listing/decision; missing ID: 404 |
| GET | `/v1/listings` | `{ "items": [...] }`, exact seller/status filters, newest first |
| POST | `/v1/listings/{id}/decision` | Human approve/reject from `needs_human`: 200; other states: 409; missing: 404 |

For each new walkthrough, choose a fresh `Idempotency-Key` and a distinct title.
The database persists between restarts: reusing a key replays the earlier listing,
and reusing content from an active listing can trigger duplicate rejection.
To test a replay within the same walkthrough, keep both the key and body unchanged.

```sh
curl -i http://localhost:8080/v1/listings \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: demo-review-1' \
  --data '{"seller_id":"s-1004","title":"Phone","description":"Used phone","price_vnd":6000000,"category_id":"c-phones"}'
```

Copy the returned ID into the following commands. Poll until the asynchronous
worker changes `pending` to `needs_human` for this unverified, non-trusted seller.
Repeating the POST above returns the same ID and its current status.

```sh
curl -i http://localhost:8080/v1/listings/LISTING_ID
curl -i 'http://localhost:8080/v1/listings?seller_id=s-1004&status=needs_human&limit=20'
curl -i -X POST http://localhost:8080/v1/listings/LISTING_ID/decision \
  -H 'Content-Type: application/json' \
  --data '{"decision":"approve","moderator_id":"demo-moderator","note":"Reviewed"}'
```

Approval publishes the row; rejection marks it rejected. A second human request
returns 409. Moderator metadata stays in internal history. Moderator
authentication is outside the exercise scope. The Compose configuration uses
development credentials; external deployment requires authentication and
appropriate credential and network controls.

List ordering is `created_at DESC, id DESC`, with default limit 20 and maximum
100. Invalid known query parameters return 400. Unknown seller/category in a
submission returns 422. Invalid submission or human decision bodies return 400;
bodies exceeding 1 MiB return 413. Errors use
`{ "error": { "code": "...", "message": "..." } }`.

`price_vnd` accepts JSON integer tokens from 0 through 9223372036854775807 and is
returned as a JSON number. Fraction/exponent syntax and quoted prices are invalid.
Use raw JSON or a lossless JSON client for values above JavaScript's safe integer
range; ordinary JavaScript `Number` parsing can round a correct response.
Title length is 1–200 Unicode code points; description permits up to 5000.
The transport rejects duplicate JSON keys, malformed UTF-8, nesting above 128,
and unsupported body media/encoding. See ASSUMPTIONS.md for precise text policies.

## Rules and lifecycle

| Rule | Condition | Result |
| --- | --- | --- |
| R1 | A whole banned term matches the title or description | Reject, including trusted sellers; the reason names the matched term |
| R4 | No R1 match and seller trust score >=80 | Approve; skip R2, R3 and R5, including for unverified sellers |
| R2 | Price is strictly below one-third or above three times the category median | Escalate for human review |
| R3 | A non-trusted seller has a matching normalized listing in `auto_approved` or `published` | Reject as a duplicate |
| R5 | A non-trusted seller is unverified | Escalate for human review |

For non-trusted sellers, rejection takes precedence over escalation. Reasons from
applicable rules are returned in R2, R3, R5 order. Exact normalization and boundary
policies are documented in ASSUMPTIONS.md.

All new submissions persist `pending` and a queued job before returning 202.
The worker commits one automated phase to `auto_approved`, `auto_rejected` or
`needs_human`. It separately publishes `auto_approved` rows. Human decisions
resolve only `needs_human`. Published rows eventually become `expired` after
their persisted deadline; expiry preserves the decision and audit history.

## Postman collection

Import [the collection](postman/listing-moderation.postman_collection.json) into
Postman, start the service with `make run`, and run the entire collection in
Collection Runner, in folder order from **00** through **15**. No separate
Postman environment is required. The collection variable `baseUrl` defaults to
`http://localhost:8080`; update it when using another host port.

Folder 00 creates a fresh `runId` for listing titles and idempotency keys. Start
from this folder for each new run against the persistent development database.
Polling requests wait for the expected moderation or publication state, with a
default `pollTimeoutMs` of 60000. Manual Send executes a polling request once;
send it again if the listing is still `pending` or `auto_approved`.

The collection covers submission, rule outcomes, human decisions, idempotency,
validation, exact int64 response tokens and listing queries. Folders 12 and 14
also send concurrent requests to check HTTP race outcomes. Inspect large int64
values in the raw response and preserve the supplied raw Text request bodies;
formatting or parsing them as JavaScript numbers can round their values.

These checks complement `make test`. They do not exercise worker crash recovery,
database transaction barriers or cold startup, and a normal collection run does
not wait for the default 30-day expiry period.

## Configuration

| Setting | Application default / constraint | Local Compose behavior |
| --- | --- | --- |
| `PORT` | 8080; decimal integer 1–65535 | Overrides host binding; API container stays on 8080 |
| `DATABASE_URL` | Required PostgreSQL URL with host and database | Internal development DB URL supplied by Compose; host override is not forwarded |
| `POLL_INTERVAL_MS` | 1000; decimal integer 1–2147483647 | Set to 1000 in `compose.yaml`; change that file to tune local polling |
| `LISTING_TTL_DAYS` | 30; positive decimal safe integer | Shared environment override for API and worker |

One TTL day is exactly 24 hours measured from PostgreSQL publication time.
Changing TTL affects future publications, not existing deadlines. Extremely
large accepted values can overflow database interval/timestamp arithmetic and
prevent publication. Compose's empty TTL substitution uses its fallback of 30;
a directly supplied empty application value is invalid.

Each worker handles one moderation claim per tick, then at most one publication
and an expiry batch of up to 100 rows before waiting the polling interval. Each
job allows at most five claims, including recovery claims. Each claim has a
30-second lease without heartbeat renewal. Retries use exponential backoff with
full jitter. When attempts are exhausted, the job becomes `failed` and its
unprocessed listing remains `pending`. SIGTERM/SIGINT stops new work and waits for the active operation before
closing the pool. Forced termination leaves the persisted lease for recovery.

## Operational checks and failed jobs

`/livez` returns `200 {"status":"ok"}` without querying the DB or worker.
`/readyz` returns the same body on success or `503 {"status":"not_ready"}` on a
failed probe or drain. A process that has exited has no HTTP response. The probe
uses a 5-second pool checkout timeout and a 1-second client query timeout; these
are not a hard 6-second wall-clock deadline or a worker-health check.

Worker JSON events expose generated IDs, attempts, phase, outcomes/rule IDs where
available, and safe diagnostics. They omit payload text, claim tokens, moderator
notes, database URLs, raw error messages and stacks. Search for
`worker_job_attempt_failed`, `worker_job_exhausted`, `worker_job_quarantined`,
`worker_claim_recovered`, `worker_publication_failed` and `worker_expiry_failed`.

Run [ops/inspect-jobs.sql](ops/inspect-jobs.sql) with a PostgreSQL client connected
to this service's database. It reports IDs, attempts, lease/availability times,
safe diagnostics, listing state, history count and DB-clock classifications.
Lease expiry does not prove the original process exited. Inspect worker logs
and database availability before intervening. Publication and expiry backlogs:

```sql
SELECT id,status,created_at,version FROM listings
WHERE status='auto_approved' ORDER BY created_at,id;
SELECT id,status,expires_at,version FROM listings
WHERE status='published' AND expires_at<=clock_timestamp() ORDER BY expires_at,id;
```

A running job with missing token/lease or a current live job attached to a
nonpending listing is quarantined as failed without altering listing/history.
For a failed moderation job, inspect listing, job and history first. Requeue only
if the listing remains pending and has no committed phase history. In an
interactive `psql` session set `listing_id`, `job_id`, `expected_attempts` and
`expected_error` to the exact inspected values, then run
`\i ops/requeue-failed-job.sql`. The script locks listing before job and leaves
its transaction open. **COMMIT only if the final UPDATE returns exactly one row**;
otherwise ROLLBACK and inspect again. Exiting without COMMIT rolls back. Requeue
resets attempts and grants a fresh five-claim budget; address the underlying
fault first. Never remove audit history to bypass a guard.

If startup refuses a lifecycle lock after a crash, inspect the PID file under
`${TMPDIR:-/tmp}` and the named project's Docker resources before removing that
specific stale lock directory. For a port conflict choose another `PORT`. For
migration checksum errors restore the applied migration and introduce a new
migration; do not reset the database to silence the error. Registry/network
failures during build require working registry access before startup can finish.

## Verification status and known limitations

The latest observed `make test` run on application/test commit `86fd885` completed
with **316 tests passed, 0 failed, 0 cancelled, exit 0** on 2026-10-30 (Asia/Saigon).
It includes pure rule tests, real PostgreSQL transactions/races and compiled
worker crash/restart tests, actual HTTP transport/mapper/serializer checks, and
a public POST-to-worker-to-human-to-expiry journey. The expiry journey sets an
overdue fixture deadline; it does not wait 30 days. Some fault tests use explicit
client-boundary injection; they prove propagation/rollback, not that PostgreSQL
naturally generated that fault. `make test` does not run the separate smoke target.

A startup measurement using a fresh rootless Docker engine reached readiness in
44.094 seconds, including application image pulls, build and bootstrap, with
2 CPUs and 4 GiB of memory. Engine provisioning was excluded. The measured
source preceded a test-only line-ending fix; timing depends on the environment
and registry access.

The dependency audit snapshot on 2026-10-29 UTC reported one moderate advisory
in development-only `yaml@2.8.1` (GHSA-48c2-rrv3-qjmp); the production-only report
had zero findings at that time. The development dependency upgrade is deferred;
runtime images omit it. Repository tooling should only process trusted YAML
until the parser is upgraded.

R3 scans may be expensive for a large active candidate set; there is no scan
benchmark or global duplicate constraint. A permanently failing oldest
publication row can block later publications until repaired. Database volumes
provide process-restart persistence, not backup, replication or disaster recovery.
See ARCHITECTURE.md for these trade-offs and production follow-ups.

## Repository references

- [openapi.yaml](openapi.yaml) defines the HTTP contract.
- [AGENTS.md](AGENTS.md) contains the Codex repository instructions.
- [AI-NOTES.md](AI-NOTES.md) records the AI collaboration and mistakes encountered.
- `seed/` is authoritative starter reference data; `migrations/` is checksummed SQL.
- `Makefile.example` is an inactive starter reference.

The exercise brief is supplied separately. Local planning notes and execution
evidence are excluded from version control and are not required to build,
run or test the service.
