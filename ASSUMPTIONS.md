# Assumptions and decisions

Status: T00–T06 transport/database/submission/read and pure moderation policy implemented;
worker decision commit and recovery remain planned. Entries identify
planned or implemented behavior individually.
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

**Decision (owner-approved 2026-10-28; normalization and arbitration implemented/exercised in T07):** Match exact, case-sensitive seller and category IDs, exact nonnegative BIGINT price, and title/description normalized on copies by NFC → JavaScript locale-independent `toLowerCase()` → NFC. Collapse every code point with Unicode `White_Space` into one ASCII U+0020 and remove only resulting U+0020 at the edges. This includes tab, line breaks, NBSP, NEL and other `White_Space`; it preserves accents, punctuation, U+200B and U+FEFF. It does not do full case folding (`ß` remains distinct from `ss`), accent removal, fuzzy matching, or ID normalization. Active means `auto_approved` or `published`. Serialize non-trusted automated check-and-commit with a PostgreSQL transaction-scoped advisory lock and re-read duplicates inside that transaction.

**Rationale:** Deterministic equality supports repeatable concurrency checks. R3 rejection beats R2/R5 escalation; retain all triggered reasons among evaluated rules. No fuzzy matching.

**Cost of being wrong:** Equality changes alter rejection rates. This deliberately provides no universal duplicate exclusion: trusted sellers bypass R3, and later human approvals can create duplicates. A global constraint would add a new business rule.

## A4 — Idempotency transport, scope and lifetime

**Ambiguity:** The brief requires a key, but OpenAPI specifies neither transport nor scope, optionality or retention.

**Decision (T04 implementation):** `Idempotency-Key` is optional,
globally scoped, case-sensitive, and retained with its listing for the supported
listing lifetime. No canonical key means a fresh independent submission.
Recognize only one canonical field line whose bare value matches
`^[A-Za-z0-9._~-]{1,128}$`; reject invalid values and duplicate canonical field
lines with 400. Do not trim or normalize the value in application code. Ignore
`X-Idempotency-Key`; it is not an alias, including when the canonical header is
present. This is a project policy, not a claim of full IETF Structured Field
draft conformance. Same key and canonical body returns 200 with original ID and
current status; changed body returns 409. No separate key TTL/cleanup is added.
The HTTP parser may remove optional wire whitespace before application code sees
the field value.

**Rationale:** Avoid inventing a required body field. A unique DB key reserves submission atomically with listing/job creation.

**Cost of being wrong:** Global keys can collide across clients; changing scope or retention affects replay guarantees and may require migration.

## A5 — Canonical request identity and unknown properties

**Ambiguity:** OpenAPI permits additional properties and does not define "same body".

**Decision (T04 implementation):** Accept harmless unknown
properties, include the complete supplied JSON object in canonical hashing, and
persist only defined listing fields. Object key order and JSON formatting do not
change identity; arrays retain order. Decoded strings are compared exactly with
no trim, case-fold or Unicode normalization. Canonical object keys sort by
JavaScript UTF-16 code-unit order. Canonical JSON strings use well-formed JSON
escaping, preserving distinctions such as a lone surrogate versus U+FFFD in
unknown fields. Numbers use exact mathematical value without JavaScript
`Number`: equivalent decimal/exponent spellings compare equal, negative zero
equals zero, adjacent unsafe integers remain distinct, and exponent
normalization stays compact. `price_vnd` follows T03 strict integer-token
syntax. Hashing uses SHA-256 over the deterministic typed representation.
Submission strings that go into PostgreSQL text have the separate A14 policy.
T04 unit and actual POST tests exercise canonicalization, keyed replay and
changed unknown-field conflicts through production wiring.

**Rationale:** Preserve the permissive schema while detecting meaningful request changes. Duplicate normalization is a separate policy.

**Cost of being wrong:** Changes to hashing semantics can turn old replays into conflicts; versioning/backward compatibility may be needed.

## A6 — Expiry duration and default

**Ambiguity:** The lifecycle includes expired but no duration. The owner included expiry in core without selecting a duration.

**Decision:** `LISTING_TTL_DAYS` defaults to 30 application-wide and remains configurable as a positive decimal safe integer. Automatic and human publication persist `published_at` and `expires_at` from the same PostgreSQL clock instant; one day is exactly 24 hours. Expiry changes only a due `published` listing's status (and lifecycle version); it retains decision, decided_at and moderation history. Existing deadlines are not recalculated when configuration changes.

**Rationale:** Complete the selected lifecycle with a visible, testable default. Thirty days is an implementation assumption, not a brief requirement.

**Cost of being wrong:** Listings may disappear too early/late; changing existing deadlines requires an explicit migration policy. The validator intentionally keeps the existing positive decimal safe-integer range without a new upper bound. Extremely large but syntactically valid values can exceed PostgreSQL interval/timestamp arithmetic and cause publication to fail; this is not represented as a promise that every accepted integer is a usable calendar duration.

**Current implementation:** T10 sets the application default to 30; Compose supplies the same default to API and worker and permits a shared override. Explicit invalid values continue to fail fast; missing TTL no longer fails.

## A7 — Current result and internal history

**Ambiguity:** OpenAPI represents the current decision without a public history endpoint; audit storage is unspecified.

**Decision:** Follow OpenAPI: human resolution replaces the displayed escalation. Per plan, keep append-only history with at most one event per committed auto/human phase. Publication and expiry are lifecycle changes, not moderation results. Use HUMAN as the human reason ID and retain moderator/note internally.

**Rationale:** Explain current state without losing prior decisions; a HUMAN rule ID is allowed by OpenAPI.

**Cost of being wrong:** Public history would need a separate API design and privacy policy.

## A8 — Storage, worker topology and failures

**Ambiguity:** The brief permits different infrastructure and restart durability scopes.

**Decision (owner-approved 2026-10-29, T08 policy):** Use PostgreSQL jobs with distinct API and worker processes; multiple worker processes are supported, each worker processes one claimed job at a time. Lease duration is 30 seconds, measured with PostgreSQL `clock_timestamp()`; no heartbeat renews it. Each successful claim increments attempts, including a reclaimed claim after process crash; maximum is 5 claims total. Retry scheduling uses full jitter from 0 through `min(30 seconds, 1 second × 2^(attempt−1))`, while the configured polling interval prevents a tight loop. After the budget is exhausted, the job becomes `failed`, the listing stays pending, and a sanitized diagnostic remains visible for operator inspection. Operator requeue is a guarded manual operation only after inspecting the cause and confirming the listing remains pending; resetting attempts opens a new retry budget. A `running` job with NULL claim token or NULL lease is quarantined to `failed`, preserving attempts and listing/history. A current live running job whose listing is nonpending is also quarantined to `failed`, preserving listing/history/attempts; completed jobs and stale/expired tokens are no-ops. Worker database statements use `statement_timeout=10s` and `lock_timeout=5s`; these are per-statement limits, not a total transaction deadline. Shutdown stops new claims, cancels idle polling, awaits active work, and closes the database; forced termination is recovered by lease expiry. Tests use isolated ephemeral storage; named volumes survive normal shutdown/restarts, not explicit volume deletion.

**Rationale:** Atomically store work and results without introducing an external broker. Bounded retries keep healthy work moving and make poison jobs visible without inventing a moderation rejection. Quarantining inconsistent running/job state avoids silently completing incomplete phases.

**Cost of being wrong:** Database queue throughput may require redesign at scale; volume deletion loses durable state. A 30-second lease with no heartbeat may roll back slow R3 scans and spend retry attempts; the final DB-time fence preserves atomicity, and performance/lease tuning can follow measured evidence. Five attempts can move a transiently failing job to operator action; operator reset is explicit and must not reopen a completed phase.

## A9 — Authentication and error extensions

**Ambiguity:** OpenAPI defines no moderator authentication and omits some validation errors on read/human routes.

**Decision:** Per plan, do not introduce mandatory auth for this exercise. Preserve all specified statuses/envelopes; document 400 extensions for invalid query/human input during T03/T05/T09. Unknown seller/category on submission is 422. Missing human listing is 404; invalid phase/concurrent loser is 409.

**Rationale:** Keep conformance; production authorization is a documented follow-up.

**Cost of being wrong:** The prototype moderator endpoint must not be treated as production-ready authorization. New consumers may need error-extension documentation.

## A10 — Exact integer transport and text length

**Ambiguity:** OpenAPI uses integer/int64; ordinary JavaScript number parsing cannot represent its full range. Text length units need an explicit implementation convention. OAS 3.0.3 §4.4 defines integer syntax without fraction or exponent.

**Decision (owner revised 2026-10-28; transport implemented in T03):** Accept price_vnd JSON integer tokens from 0 through 9223372036854775807 exactly; reject fraction/exponent tokens including 1000.0 and 1e3 with 400. This supersedes the earlier mathematical-integer choice after review against [OAS 3.0.3 §4.4](https://spec.openapis.org/oas/v3.0.3#data-types). Normalize integer-token -0 to output 0. The shared listing request pipe returns bigint; response serialization emits numeric tokens. Text bounds count Unicode code points. Unknown numeric fields retain full JSON grammar and precision. T04 actual POST tests and T05 actual GET one/list tests cover the public roundtrip through PostgreSQL and the production response serializer.

**Rationale:** Prevent silent rounding and avoid requiring price strings absent from OpenAPI.

**Cost of being wrong:** Additional transport complexity; clients using ordinary floating-point JSON parsers may still lose precision locally.

## A11 — Bootstrap and seed lifecycle

**Ambiguity:** The plan permits either a dedicated migration runner or API/worker
startup bootstrap, and does not define how rows outside the seed files are handled.

**Decision:** Use the owner-selected `pg` plus versioned SQL approach. API and
worker acquire PostgreSQL transaction advisory lock `(74201, 2)`, apply the
explicit migration manifest, validate checksums, and upsert seed-file rows in
one transaction before starting. Seed rows absent from the files are preserved.
Connection establishment/handshake times out after five seconds. Startup also
waits up to five seconds to acquire the bootstrap lock, then fails
without accepting traffic if bootstrap fails. Migration-history edits require a
new migration; automatic rollback/reset is not performed.
These are separate limits, not a total migration/seed execution deadline or
evidence that the full cold-machine startup gate has passed.

**Rationale:** Keep API and worker on the same startup path, prevent races on a
fresh database, and avoid deleting data during recovery.

**Cost of being wrong:** A stale extra reference row remains available to later
business logic until explicitly removed by a separately reviewed migration.

## A12 — Planned T03 JSON resource budgets

**Ambiguity:** OpenAPI does not prescribe a request byte limit or JSON nesting
budget. The implementation plan requires a bounded body and safe parser errors.

**Decision (T03 implementation):** Bound raw JSON
request bodies at 1,048,576 bytes, using actual received bytes rather than trusting
Content-Length. Reject larger bodies with 413 and the standard error envelope
(`payload_too_large`). Limit object/array nesting to 128 levels, with the root
container at level 1; deeper input returns 400 `invalid_request`. Record these
as transport resource policies, not new required listing fields. Use the JSON
library for parsing; any depth preflight guard only counts nesting outside
strings and must handle escapes, without implementing another JSON grammar.

**Rationale:** Bound parser resource use and make threshold behavior testable
through the production HTTP path, including chunked bodies and failure recovery.

**Cost of being wrong:** Very large unknown fields or unusually deep JSON that
otherwise satisfies the field schema will be rejected. Changing these budgets
later requires updating documentation and HTTP boundary tests together.

## A13 — Planned T03 JSON decoding and media policy

**Ambiguity:** OpenAPI does not define duplicate-key handling, malformed UTF-8,
or the response policy for unsupported body media/encoding.

**Decision (T03 implementation, policy reviewed 2026-10-28):** Reject duplicate
object keys at every depth and malformed UTF-8 with 400 `invalid_request`.
Decode UTF-8 strictly. For requests carrying a body, accept application/json
and application/*+json; charset may be absent or UTF-8 (case-insensitive).
Reject malformed/unsupported media types or charsets, and Content-Encoding
other than absent or identity, with 400 `invalid_request`; do not decompress.
Bodyless GET does not require Content-Type. Preserve unknown JSON values without
stripping, including lossless numbers (A5/A10). Resource limits follow A12.

**Rationale:** Make ambiguous inputs deterministic without adding required
listing fields. Duplicate-key behavior was verified against the pinned library
in Node 22/CommonJS and by actual production parser HTTP tests.

**Cost of being wrong:** Clients sending compressed JSON, other media/charsets,
or duplicate-key objects will be rejected; 400 for unsupported transport is a
project choice and must be documented and exercised through actual HTTP.

## A14 — JSON strings stored in PostgreSQL text

**Ambiguity:** OpenAPI and the brief define listing strings and length bounds but
do not state whether U+0000 or unpaired UTF-16 surrogates are accepted. The JSON
parser accepts them, while PostgreSQL text cannot store U+0000 and UTF-8 binding
cannot preserve an unpaired surrogate.

**Decision (owner-approved 2026-10-28; T04 implementation):** For persisted
`title` and `description`, reject U+0000 and unpaired UTF-16 surrogates with 400
`invalid_request` before database work. Such `seller_id` and `category_id`
values cannot identify a storable reference and return the documented 422
`validation_error` for unknown references. Valid surrogate pairs and U+FFFD are
accepted and persisted exactly. Unknown JSON properties are not stored in
PostgreSQL text; preserve their complete values for canonical hashing, including
U+0000 and unpaired surrogates. Do not trim, strip or replace these values.

**Rationale:** Avoid returning 500 for unrepresentable input and prevent
silently changing accepted title/description or matching a different reference
ID after UTF-8 replacement. Keep exact JSON identity for fields not persisted.

**Cost of being wrong:** This narrows accepted values beyond what OpenAPI
explicitly says. If product requirements need those code units as listing text,
storage and every downstream reader/moderation path need a reversible string
representation rather than PostgreSQL `text` binding.

## A15 — GET listing query decoding

**Ambiguity:** OpenAPI defines read filters and limit bounds but does not define malformed percent encoding, malformed UTF-8, duplicate query fields, or bracket-shaped query values.

**Decision (owner-approved 2026-10-28; implemented and exercised through actual HTTP in T05):** Known query parameters (seller_id, status, limit) and recognized bracket variants use raw-query inspection before decoding. Malformed percent escapes or invalid UTF-8 in a known parameter return 400 invalid_request. A valid UTF-8 encoded literal U+FFFD remains an ordinary exact-match value. Unknown query parameters are ignored, including malformed values. Values use form-query semantics: raw + means space, %2B means plus; decode once only. Repeated known fields and known bracket variants return 400. Validate status and limit before an unrepresentable seller filter returns an empty list. seller_id=%00 is valid encoding but not representable by PostgreSQL text, so it yields 200 items:[] after other query validation. `limit` accepts decimal digits with numeric value 1–100 (including leading zeroes), defaults to 20. See T05 implementation plan and execution log for evidence and tested boundaries.

**Rationale:** Prevent forgiving UTF-8 replacement from aliasing malformed selector bytes to a real U+FFFD identifier while preserving the existing policy of ignoring extension query parameters.

**Cost of being wrong:** Clients sending malformed known selectors receive 400 rather than replacement-based lookup. Changing this later requires updating raw-boundary and HTTP tests together. Unknown fields remain outside strict decoding by design.

## A16 — R1 Unicode boundaries and phrase matching

**Ambiguity:** The brief requires case-insensitive whole-term matching but does not define Unicode word characters, canonical-equivalent text, spacing within multiword terms, or the number/order of reasons for repeated matches.

**Decision (owner-approved 2026-10-28; implemented and exercised by T06 Node 22 tests on 2026-10-28):** Normalize NFC copies of the seed term, title, and description for matching only. Treat Unicode Letter, Mark, Number, and Connector_Punctuation characters as word characters; a match must not have one of these characters immediately before or after the complete seed term. Use case-insensitive Unicode matching and escape each seed term as a literal. A multiword term matches its seed spelling with the same single U+0020 space; do not collapse whitespace. Match title and description independently. Produce one R1 reason per matched seed term, even if it occurs more than once or in both fields. Sort R1 reasons by deterministic ordinal order of the original seed terms. Preserve the original seed spelling in each reason message. Do not accent-strip, transliterate, or apply broader language-specific case folding.

**Rationale:** This gives a reproducible Unicode boundary that does not split combining marks, underscores, or letters/numbers out of a word; NFC lets canonically equivalent text match without modifying persisted listing text. Literal phrase spacing avoids silently broadening seed policy. Stable per-term reasons preserve explainability and deterministic output.

**Cost of being wrong:** This treats underscore as part of a word and requires exact seed phrase spacing; users expecting underscores as separators or flexible whitespace will not get an R1 match. Unicode case mappings outside simple case-insensitive matching, accent-insensitive matching, or another phrase policy would require explicit product agreement and boundary tests.

## A17 — Human listing decisions and automatic publication

**Ambiguity:** The HTTP contract does not define how moderator metadata is normalized, whether empty metadata is valid, what public reason text to use, or the precise TTL clock arithmetic for human and automatic publication.

**Decision (owner-approved 2026-10-29; T09 implementation, TTL default completed in T10):** Preserve `moderator_id` and optional `note` exactly as supplied; do not trim or normalize them. Empty strings are valid because the OpenAPI schema defines no `minLength`. Reject NUL and unpaired UTF-16 surrogates in either value with HTTP 400 `invalid_request` before database work; accept valid surrogate pairs and U+FFFD. The public HUMAN reason is exactly `Approved by human moderator` or `Rejected by human moderator`; moderator metadata is stored only in the internal human history row and never included in the public decision message/detail or error response. A missing note is SQL NULL, while an empty note remains an empty string. Use `LISTING_TTL_DAYS`, defaulting to 30 when absent; one day is exactly 24 hours, computed from PostgreSQL time in the same transaction. The existing positive decimal safe-integer validator remains unchanged and no new upper bound is introduced.

For a human decision, only `needs_human` is eligible. The locked persisted decision must map through the production listing mapper, have outcome `escalated`, and have NULL `published_at` and `expires_at`; a mismatch is persisted-state corruption and fails safely with HTTP 500 without changing listing, history, or job. Automatic publication changes `auto_approved` to `published` without creating a new moderation history phase or changing the committed decision/time. Publication scans one eligible row per worker tick. Eventual publication is guaranteed only for valid data while the database/worker is healthy, or after a transient fault is removed; a permanently failing head row can block later rows until an operator resolves it. T09 does not add poison-publication quarantine or fairness scheduling.

**Rationale:** Exact metadata retention preserves the moderator's supplied record; explicit safe text prevents PostgreSQL binding failures and public metadata leakage. Database-clock arithmetic keeps timestamps consistent across processes and avoids host timezone/DST assumptions. Treating a semantically inconsistent `needs_human` row as corruption avoids converting bad persisted data into a normal conflict or silently repairing it during a human decision.

**Cost of being wrong:** Empty or whitespace metadata is retained as provided, and malformed PostgreSQL text is rejected beyond the basic JSON string type. A fixed 24-hour day differs from a local-calendar-day interpretation. A permanently poisonous publication row can starve healthy rows behind it; operator intervention is required under that condition.

## A18 — Health and operational diagnostics

**Ambiguity:** OpenAPI defines health paths and 200/503 statuses but not the
conditions, 503 body, probe budget or worker log fields.

**Decision (T11 implementation choice, not separately owner-approved):**
Liveness is listener-only and returns `200 {"status":"ok"}`. Readiness requires
successful bootstrap for this process, no shutdown drain, and a successful
database probe; otherwise it returns `503 {"status":"not_ready"}` without
internal details. Readiness coalesces simultaneous in-flight probes and does
not reuse a settled success. The probe uses the existing pool with its
5-second checkout timeout and a 1-second per-query client timeout. Worker
events expose only system IDs, attempts, phase, outcome and rule IDs where
available, and sanitized diagnostics; no raw payload or error text. Operators
inspect failed jobs before an exact guarded manual requeue.

**Rationale:** The API can serve listing operations only when its database is
reachable. A cheap probe and allowlisted events make failure visible without
putting credentials, claim tokens or listing content in logs.

**Cost of being wrong:** A successful `SELECT 1` does not prove every schema
object or seed remains correct after startup. These client-side timeout values
are not a strict wall-clock deadline under event-loop stalls or a guarantee
that PostgreSQL cancelled the server query. Liveness intentionally remains
200 during a database outage while the listener is alive.
