# Collector incomplete-result handling

## Goal

Prevent expected partial-result periods during a live Thai lottery draw from producing false GitHub Actions failure alerts, without ever publishing incomplete or conflicting results.

## Behavior

- Each source attempt produces one explicit outcome: `complete`, `partial`, `unavailable`, or `parser_error`.
- `partial` requires a fetched page that is positively identified as the requested draw and parsed successfully, but does not yet contain every required prize.
- Before 18:00 ICT, at least one `partial` source with no complete source ends successfully with `Waiting for complete result`; the five-minute schedule performs the next retry.
- At or after 18:00 ICT, a still-partial draw fails visibly. The cutoff is evaluated from an injected clock at the end of the collection attempt using fixed UTC timestamps in tests.
- If every source is `unavailable` or `parser_error`, the job fails rather than being hidden as an incomplete draw.
- If one source is partial and another is unavailable, the outcome is waiting before the cutoff and includes diagnostics for the unavailable source.
- Complete sources must agree on every canonical prize field. Any disagreement is fatal and no result is published.
- The existing verified payload remains byte-for-byte unchanged unless a complete result passes strict validation at the write boundary.

## Structure

- Return structured source outcomes for expected partial data; reserve exceptions for fatal source, parser, mismatch, and validation failures.
- Preserve the failure stage and message from each settled source operation instead of discarding rejected reasons.
- Add an orchestration function with an injected clock for deterministic ICT cutoff behavior.
- Verify the requested draw date from Sanook page metadata or canonical content before accepting either a partial or complete candidate.
- Compare a canonical fingerprint containing all prize fields while excluding only metadata (`source`, `sources`, and `publishedAt`).
- Make `writeIfNewer` call `validateResult` before reading or writing the destination.
- Add a workflow concurrency group with `cancel-in-progress: false` so collection jobs cannot write concurrently.
- Keep the existing five-minute schedule as the retry mechanism; do not add sleeps or internal retries.

## Tests

- Partial data before 18:00 ICT returns a waiting outcome without writing.
- Partial data at 17:59:59 ICT waits; at 18:00:00 ICT it fails.
- All-source network failure and parser failure remain fatal before 18:00.
- A partial source plus an unavailable source waits and retains diagnostics.
- Complete sources differing in any prize field are rejected.
- Sanook content for a different draw date is rejected.
- `writeIfNewer` rejects a partial/invalid payload and leaves the previous file byte-for-byte unchanged.
- The no-rewrite test uses a fully valid result.
- Existing parser and validation tests continue to pass.

## Operational constraints

- No partial payload is written.
- Workflow permissions and repository data format do not change.
- A failed job is only a visible GitHub Actions failure; delivery of email alerts still depends on repository notification settings.
- Special draw dates outside the existing configured day list remain a separate scheduling concern and are not expanded in this change.
