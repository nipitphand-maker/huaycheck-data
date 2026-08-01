# Collector incomplete-result handling

## Goal

Prevent expected partial-result periods during a live Thai lottery draw from producing false GitHub Actions failure alerts, without ever publishing incomplete or conflicting results.

## Behavior

- A collection attempt may produce one of three outcomes: complete verified result, incomplete result, or fatal source/validation error.
- When no source has a complete valid result, classify the outcome as incomplete rather than a generic failure.
- Retry an incomplete outcome up to three total attempts, waiting 60 seconds between attempts in production.
- Before 18:00 ICT, exhausting incomplete retries ends successfully with a `Waiting for complete result` message. The scheduled workflow will try again later.
- At or after 18:00 ICT, exhausting incomplete retries is a failure so maintainers are alerted.
- A disagreement between complete sources remains fatal immediately. No retry or publication is allowed.
- The existing verified payload remains unchanged unless a complete result passes the current strict schema validation.

## Structure

- Add a typed incomplete-result error at the collector boundary.
- Add a small exported retry/orchestration function whose clock, delay, and collection operation can be injected for deterministic tests.
- Keep source parsing and strict result validation unchanged.
- Keep the workflow schedule unchanged; the Node process owns the short retry behavior.

## Tests

- Incomplete attempts retry and eventually publish when a later attempt is complete.
- Three incomplete attempts before 18:00 ICT return a waiting outcome without throwing.
- Three incomplete attempts at or after 18:00 ICT throw.
- Source mismatch remains fatal on the first attempt.
- Existing parser, validation, and no-rewrite tests continue to pass.

## Operational constraints

- Production delay is 60 seconds; tests inject a no-op delay.
- No partial payload is written.
- Workflow permissions and repository data format do not change.
