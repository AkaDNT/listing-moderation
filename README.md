# Listing Moderation Service

## Local lifecycle

The API and standalone worker run in Docker containers alongside PostgreSQL 16.
Before the API starts listening or the worker announces startup, both processes
connect to PostgreSQL, acquire the shared transaction-scoped bootstrap lock,
apply pending checksummed SQL migrations, and upsert the reference seed data.
The API exposes `GET /livez`, which reports process liveness. Dynamic database
readiness is planned for a later task. The listing submission and read routes
are available as described below.

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
retain numeric precision in responses. Worker processing remains a later task.
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
