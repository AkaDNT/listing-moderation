# Listing Moderation Service

## Local lifecycle (T01)

The API and standalone worker run in Docker containers alongside PostgreSQL 16.
The API exposes `GET /livez`; this reports process liveness only. Database/schema
readiness and listing routes are added in later tasks.

```sh
make run                 # foreground; API at http://localhost:8080
PORT=8081 make run       # publish the API at http://localhost:8081
make test                # build and run the isolated containerized suite
make smoke               # Docker-backed T01 lifecycle and build-context checks
```

`make run` keeps its workspace-specific named database volume across normal
shutdowns. `make test` uses an invocation-specific Compose project and removes
only that project's verified-owned test volume after the runner exits. Both
commands refuse pre-existing containers and networks for the selected project;
`make run` reuses its database volume only when its workspace/mode labels match.
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
