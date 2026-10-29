# Repository Instructions — Listing Moderation Service

## Purpose and context

This repository implements the Listing Moderation Service take-home exercise.
The design prioritizes HTTP contract compatibility, transactionally correct moderation,
recoverable asynchronous work, explainable decisions, and reproducible local execution.
Keep the implementation focused: production-quality correctness without unnecessary infrastructure.

## Sources of truth

- `openapi.yaml`: authoritative HTTP paths, payloads, field types, statuses, and error shapes.
  Never change its defined contract to make an implementation or test pass.
- `seed/`: authoritative starter reference data. Load it on startup; do not alter the seed files.
- `.local-docs/LISTING_MODERATION_IMPLEMENTATION_PLAN.md` (owner-local, when available):
  task sequence, acceptance criteria, and required tests. Consult the selected task,
  not the entire plan for every small edit. Keep plan progress, execution logs,
  and internal review documents under ignored `.local-docs/`; do not require them
  for runtime, tests, or clean-clone execution.
- `ASSUMPTIONS.md` (when present): recorded decisions and rationale for ambiguous requirements.
- `ARCHITECTURE.md` (when present): documented component boundaries and trade-offs.
- The original `BRIEF.md` is intentionally excluded from Git. Do not make runtime,
  test, or clean-clone workflows depend on that local file.

If documents conflict with `openapi.yaml`, preserve the defined wire contract and
surface the conflict. Do not silently invent new requirements.

## Technical boundaries

- TypeScript / NestJS API; PostgreSQL for persistence and job state;
  dedicated database-backed worker; Docker Compose for local operation.
- Prefer simple, explicit database transactions and small testable modules.
  Do not introduce Redis, a message broker, a new service, or a frontend without a demonstrated need.
- Do not rely on process-local locks to guarantee correctness across API or worker processes.
- `make run` must start everything in the foreground, listen on `${PORT:-8080}`
  on the host, become ready within 180 seconds on a cold machine, and clean up safely on termination.
- `make test` must run from a clean checkout without a pre-running service or host Node.js toolchain,
  use isolated test dependencies, and exit nonzero on failure.

## API invariants

- Implement all six defined endpoints, including `GET /v1/listings`, `/livez`, and `/readyz`.
- A new `POST /v1/listings` persists `pending` and returns `202`; never evaluate moderation inline.
- Use the documented `Idempotency-Key` assumption: same key and canonical request returns
  `200` and the same listing; same key with changed payload returns `409`.
  Ensure concurrent submissions create only one listing and initial job.
- Unknown seller or category returns `422`. Preserve documented request/response types
  and error shapes; do not invent additional required fields.
- `price_vnd` is a nonnegative JSON int64. Preserve integer precision through parsing,
  PostgreSQL `BIGINT`, business rules, and JSON numeric serialization.
  Never silently round unsafe JavaScript numbers or serialize this API field as a string.
- A human decision is allowed only from `needs_human`; exactly one request can commit;
  concurrent losers and later attempts return `409`.

## Moderation rules (owner-approved)

- **R1 always wins.** Case-insensitive word-boundary matching in title/description rejects
  banned terms even for trusted sellers. The `reason.message` for R1 must include the matched
  seed term (apart from letter case), not just its `detail`.
- **R4 after R1:** `trust_score >= 80` bypasses R2, R3, and R5, including for unverified
  trusted sellers. Trusted submissions are still processed asynchronously by the worker.
- **R3 for non-trusted sellers:** duplicate means matching seller, category, price, and
  Unicode-NFC/case-/whitespace-normalized title and description against an existing
  `auto_approved` or `published` listing. Check and commit under appropriate DB concurrency
  control; never impose a global uniqueness rule that unintentionally blocks trusted sellers.
- **R2:** price strictly above 3x or strictly below one-third of the category median escalates.
- **R5:** an unverified, non-trusted seller escalates.
- Rejection outranks escalation; include reasons from applicable rules actually evaluated.
  Do not assert that bypassed rules fired.

## State, atomicity, and recovery

- Automated moderation commits at most once from `pending` to an automated outcome;
  human resolution commits at most once from `needs_human` to `published` or `rejected`.
- Persist the status, current decision, timestamp, phase audit record, and job completion
  consistently in the appropriate transaction. A stale attempt must never overwrite a
  committed result or later human resolution.
- A retried evaluation is acceptable; duplicate committed results are not.
  Healthy accepted work must not remain pending indefinitely: support lease recovery,
  retry, and observable exhaustion/failure handling.
- `auto_approved -> published` and `published -> expired` are lifecycle transitions,
  not new moderation phases. Expiry retains the committed decision and audit records.
- Current API `decision` represents the latest committed phase; retain prior phase results
  in internal append-only history.

## Verification and review

- Use strict TDD for changed behavior: write the test, observe RED for the intended
  reason (not missing fixtures/imports), then implement and observe GREEN.
- Integration tests must use production wiring for every component in scope,
  especially mappers, validators, and serializers. No identity stubs hiding behavior.
  If mocking is unavoidable, state precisely what the test does not prove.
- Every new runtime registration needs a direct contract test exercising its actual entrypoint.
- If an important business implementation is blocked by confusion or errors, stop
  that work and report the requirements, code paths, reproduction, evidence, and
  specific help needed. Present unresolved decisions with context for the owner;
  do not silently choose business behavior.
- For each implementation task, satisfy its acceptance criteria with focused unit tests
  (pure logic), integration tests using real PostgreSQL (transactions and constraints),
  and HTTP end-to-end tests where applicable. Do not use mocks as proof of concurrency safety.
- Test boundary values, simultaneous submissions, worker races, stale attempts,
  moderator decision races, crash/restart recovery, and integer precision.
- Run affected tests after changes; run the complete test/conformance suite at task gates
  and before submission. Do not claim a test passed unless it was run and observed.
- For code review, specifically flag non-atomic check-then-insert idempotency,
  read-then-write duplicate decisions, stale worker overwrites, incorrect int64 JSON,
  missing R1 match text in reasons, and inline moderation in POST.
- Keep changes within the selected task. If an assumption or API incompatibility appears,
  explain it and update the relevant documentation rather than silently changing behavior.

## Submission and documentation

- Keep `README.md`, `ARCHITECTURE.md`, and `ASSUMPTIONS.md` aligned with actual behavior.
  Document any deliberate simplification and its cost of being wrong.
- The repository also needs an actual Codex agent configuration (`AGENTS.md`) and
  authentic `AI-NOTES.md`; never invent AI errors, abandoned paths, or test evidence.
- Preserve the starter kit as the first Git commit. Keep the GitHub repository private;
  do not submit, invite collaborators, or push changes unless explicitly requested.
- Stage only as directed by the owner. Never commit or push: the owner must verify
  and perform those actions. A staged baseline is not evidence of a first commit.
