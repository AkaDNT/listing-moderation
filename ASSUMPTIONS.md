# Assumptions and decisions

Status: design baseline for T00; application behavior is not implemented yet.
Source labels below distinguish the normative OpenAPI/brief from owner decisions
recorded in the local implementation plan. Q1–Q13 transcripts are not present;
the plan's summary is the available record. Revisit entries if implementation
or new requirements change the decision.

## A1 — Banned terms override trusted sellers

**Ambiguity:** The brief says R1 is "always rejected" but R4 "bypasses moderation entirely".

**Decision:** Per owner decisions summarized in the plan, run R1 first for every seller. If clear and trust_score >= 80, R4 approves and skips R2/R3/R5, including trusted unverified sellers.

**Rationale:** Preserve the mandatory banned-content restriction and make the conflicting precedence explicit. Reasons describe only rules actually evaluated.

**Cost of being wrong:** A different precedence changes trusted-seller outcomes and requires policy/test changes.

## A2 — Trusted submissions remain asynchronous

**Ambiguity:** The brief requires POST to acknowledge pending without inline evaluation, while R4 says "published immediately".

**Decision:** Per plan, all new submissions atomically store pending and a job, then return 202 pending. The worker fast-tracks trusted listings after R1. Publication is a recoverable lifecycle transition after auto_approved.

**Rationale:** Keep the defined asynchronous HTTP contract for all sellers.

**Cost of being wrong:** Trusted listings incur worker latency; synchronous publication would require revisiting the submission contract.

## A3 — Duplicate equality and concurrency boundary

**Ambiguity:** The brief leaves "the same" and "active" undefined for R3.

**Decision:** Per plan, match seller, category, exact price, and NFC/lowercase/trimmed/collapsed Unicode whitespace title and description. Active means auto_approved or published. Serialize non-trusted auto check-and-commit with a PostgreSQL transaction-scoped advisory lock and re-read duplicates inside that transaction.

**Rationale:** Deterministic equality supports repeatable concurrency checks. R3 rejection beats R2/R5 escalation; retain all triggered reasons among evaluated rules. No fuzzy matching.

**Cost of being wrong:** Equality changes alter rejection rates. This deliberately provides no universal duplicate exclusion: trusted sellers bypass R3, and later human approvals can create duplicates. A global constraint would add a new business rule.

## A4 — Idempotency transport, scope and lifetime

**Ambiguity:** The brief requires a key, but OpenAPI specifies neither transport nor scope, optionality or retention.

**Decision:** Per plan, use Idempotency-Key, globally scoped and retained for the supported listing lifetime. No key means a fresh submission. Same key and canonical body returns 200 with original ID and current status; different body returns 409. Invalid keys return 400. Header length/syntax and optional X-Idempotency-Key support remain to be fixed in T04.

**Rationale:** Avoid inventing a required body field. A unique DB key reserves submission atomically with listing/job creation.

**Cost of being wrong:** Global keys can collide across clients; changing scope or retention affects replay guarantees and may require migration.

## A5 — Canonical request identity and unknown properties

**Ambiguity:** OpenAPI permits additional properties and does not define "same body".

**Decision:** Per plan, accept harmless unknown properties, include all supplied JSON fields in canonical hashing, and persist only defined listing fields. Object key order and JSON formatting do not change identity; actual value differences do. Do not normalize user text as part of submission identity. Exact numeric canonicalization will be fixed with lossless transport in T03–T04.

**Rationale:** Preserve the permissive schema while detecting meaningful request changes. Duplicate normalization is a separate policy.

**Cost of being wrong:** Changes to hashing semantics can turn old replays into conflicts; versioning/backward compatibility may be needed.

## A6 — Expiry duration is proposed

**Ambiguity:** The lifecycle includes expired but no duration. The owner included expiry in core without selecting a duration.

**Decision:** Proposed default LISTING_TTL_DAYS=30, configurable, measured from publication using DB time. Internal published_at/expires_at require no new public fields. Expiry changes only published status; retain decision and decided_at.

**Rationale:** Complete the selected lifecycle with a visible, testable default. Thirty days is an implementation assumption, not a brief requirement.

**Cost of being wrong:** Listings may disappear too early/late; changing existing deadlines requires an explicit migration policy.

## A7 — Current result and internal history

**Ambiguity:** OpenAPI represents the current decision without a public history endpoint; audit storage is unspecified.

**Decision:** Follow OpenAPI: human resolution replaces the displayed escalation. Per plan, keep append-only history with at most one event per committed auto/human phase. Publication and expiry are lifecycle changes, not moderation results. Use HUMAN as the human reason ID and retain moderator/note internally.

**Rationale:** Explain current state without losing prior decisions; a HUMAN rule ID is allowed by OpenAPI.

**Cost of being wrong:** Public history would need a separate API design and privacy policy.

## A8 — Storage, worker topology and failures

**Ambiguity:** The brief permits different infrastructure and restart durability scopes.

**Decision:** Per plan, PostgreSQL plus pg transactions, distinct API/worker processes, multiple workers supported. Persist jobs with leases, fencing tokens, retry metadata/backoff and an actionable poison-job policy. Named volumes survive normal shutdown/restarts, not explicit volume deletion; tests use isolated ephemeral storage. Retry limits and operator procedure will be fixed in T08.

**Rationale:** Atomically store work and results without introducing an external broker.

**Cost of being wrong:** Database queue throughput may require redesign at scale; volume deletion loses durable state.

## A9 — Authentication and error extensions

**Ambiguity:** OpenAPI defines no moderator authentication and omits some validation errors on read/human routes.

**Decision:** Per plan, do not introduce mandatory auth for this exercise. Preserve all specified statuses/envelopes; document 400 extensions for invalid query/human input during T03/T05/T09. Unknown seller/category on submission is 422. Missing human listing is 404; invalid phase/concurrent loser is 409.

**Rationale:** Keep conformance; production authorization is a documented follow-up.

**Cost of being wrong:** The prototype moderator endpoint must not be treated as production-ready authorization. New consumers may need error-extension documentation.

## A10 — Exact integer transport and text length

**Ambiguity:** OpenAPI uses integer/int64; ordinary JavaScript number parsing cannot represent its full range. Text length units and exponent notation are not further specified.

**Decision:** Per plan, accept 0..9223372036854775807 exactly, persist BIGINT, serialize JSON number tokens, and count Unicode code points for text bounds. Lossless raw HTTP parsing must precede validation. The exact policy for integer-valued exponent notation remains a documented T03 choice.

**Rationale:** Prevent silent rounding and avoid requiring price strings absent from OpenAPI.

**Cost of being wrong:** Additional transport complexity; clients using ordinary floating-point JSON parsers may still lose precision locally.
