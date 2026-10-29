# Working with AI

I wrote the requirements, then asked Codex to propose an implementation plan.
I checked and revised the plan before asking Codex to implement it. After code
generation, I verified the implementation and made corrections to the code.
This was the working cycle for each task: requirements, plan review,
implementation, then code review and revision.

I delegated the initial implementation and test drafts to Codex while retaining
responsibility for requirements, plan revisions, code corrections and business
decisions. Those decisions included duplicate normalization, retry and lease
limits, quarantine behavior, human-review metadata and the publication TTL.
Codex also assisted with code inspection, reviews and implementation walkthroughs.
These notes summarize the recorded development logs and discussions.

The main boundary was that AI could propose an implementation, but it could not
change the HTTP contract or reference seed data to make a test pass. Ambiguous
business behavior required an explicit decision. I also required integration
tests to use PostgreSQL and the production validators, mappers and serializers.
Those expectations are captured in `AGENTS.md`. Review focused on what each test
actually demonstrated, which led to additional coverage for duplicate identity
fields, trusted duplicates, stale attempts and the public listing lifecycle.

A normalization test drafted by the model incorrectly expected a fullwidth
letter to equal its ASCII equivalent. That would require NFKC normalization;
the agreed policy was NFC. Review caught the mismatch, and the test was corrected
to preserve the distinction. The production policy stayed unchanged. A separate
review also corrected a verification claim: a mutation test run after
implementation had been described as test-first RED. The log now distinguishes
mutation testing, regression coverage and genuine RED/GREEN development.

Two smaller failures were in the tests themselves. A nested positive runner
inherited `TEST_FORCE_FAILURE=1` from an outer failure-propagation test; its
environment needed isolation. A SQL test assumed LF line endings and rejected a
valid CRLF checkout before reaching PostgreSQL; the marker check was made
line-ending tolerant. Both were reproduced and checked after correction.

For cold-start verification, a disposable VM approach was abandoned when
registry authentication failed before boot. I approved a fresh rootless Docker
engine in a resource-limited privileged outer container without access to the
host Docker socket. That produced a startup measurement with engine provisioning
explicitly excluded. The abandoned attempt's duration was not recorded. This was
a useful reminder to define the environment and measurement boundary before
spending time on the test infrastructure.
