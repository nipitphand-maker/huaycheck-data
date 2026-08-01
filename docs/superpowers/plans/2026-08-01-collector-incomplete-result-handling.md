# Collector Incomplete-Result Handling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent expected partial lottery results from failing the workflow while preserving immediate failures for outages, parser breakage, mismatches, and invalid writes.

**Architecture:** `thai-results.mjs` will classify each source fetch/parse into a structured outcome, combine only complete candidates, and return a waiting status only when a verified-date partial page exists before 18:00 ICT. Strict validation and canonical comparison protect the publication boundary; GitHub Actions concurrency serializes collectors.

**Tech Stack:** Node.js 20 ESM, `node:test`, GitHub Actions YAML.

## Global Constraints

- Never write a partial or invalid payload.
- Keep the public JSON schema and workflow permissions unchanged.
- Use the existing five-minute cron as retry; add no sleeps or internal retry loops.
- Evaluate the 18:00 ICT cutoff after collection with an injected clock.
- Special draw-date scheduling is outside this change.

---

### Task 1: Canonical verification and write-boundary guard

**Files:**
- Modify: `thai-results.mjs:50-65,169-190`
- Test: `test/thai-results.test.mjs`

**Interfaces:**
- Produces: `canonicalResultFingerprint(value): string`, used to compare all prize fields while excluding metadata.
- Produces: `writeIfNewer(result, path): boolean`, now throws `invalid result: <reason>` before filesystem mutation.

- [ ] **Step 1: Write failing tests**

Add tests that change one fifth-prize number between two complete sources and expect `/source result mismatch/`. Replace the abbreviated no-rewrite fixture with `completeResult({ drawDate: '2026-08-01' })`. Add a test that writes a valid previous payload, captures `readFileSync(path, 'utf8')`, calls `writeIfNewer({ ...valid, fifthPrizes: [] }, path)`, expects `/invalid result/`, and asserts the file contents are unchanged.

- [ ] **Step 2: Verify RED**

Run: `node --test --test-name-pattern='mismatch|invalid payload|does not rewrite' test/thai-results.test.mjs`

Expected: the fifth-prize mismatch is accepted and the invalid write test does not throw.

- [ ] **Step 3: Implement canonical comparison and validation**

Add:

```js
function canonicalResultFingerprint(value) {
  const { source, sources, publishedAt, ...canonical } = value;
  return JSON.stringify(canonical);
}
```

In `chooseVerifiedResult`, compare every complete candidate fingerprint with the first and throw `new Error('source result mismatch')` on disagreement. At the first line of `writeIfNewer`, call `validateResult`; throw `new Error(`invalid result: ${validation.reason}`)` before `readLatest(path)` when invalid.

- [ ] **Step 4: Verify GREEN**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add thai-results.mjs test/thai-results.test.mjs
git commit -m "Harden verified result publication boundary"
```

### Task 2: Verify Sanook draw dates

**Files:**
- Modify: `thai-results.mjs:81-114`
- Test: `test/thai-results.test.mjs`

**Interfaces:**
- Produces: `parseSanookPage(html, drawDate)`, which throws `sanook: requested <date> but page date differs` unless page metadata identifies the expected Buddhist-era slug/date.

- [ ] **Step 1: Capture a minimal real metadata shape and write failing tests**

Use the current Sanook response to identify a stable canonical URL or heading containing the requested draw slug. Add one fixture with matching metadata and one with a previous draw date. Assert the matching fixture parses and the stale fixture throws `/page date differs/`.

- [ ] **Step 2: Verify RED**

Run: `node --test --test-name-pattern='Sanook.*date' test/thai-results.test.mjs`

Expected: stale content is accepted because the parser currently trusts the caller date.

- [ ] **Step 3: Implement minimal date verification**

Extract the canonical URL or equivalent stable metadata before stripping scripts. Compare it with `isoToSanookSlug(drawDate)` or the exact expected date representation. Throw before constructing a candidate when it does not match.

- [ ] **Step 4: Verify GREEN**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add thai-results.mjs test/thai-results.test.mjs
git commit -m "Verify Sanook draw date before collection"
```

### Task 3: Classify source outcomes and incomplete draws

**Files:**
- Modify: `thai-results.mjs:141-159,192-204`
- Test: `test/thai-results.test.mjs`

**Interfaces:**
- Produces: source outcomes `{ status: 'complete'|'partial'|'unavailable'|'parser_error', source, candidate?, message? }`.
- Produces: `collectVerifiedResult(drawDate, fetchPage, now): Promise<{ status: 'complete', result }|{ status: 'waiting', diagnostics }>`.
- Fatal all-source unavailable/parser outcomes and source mismatches throw.

- [ ] **Step 1: Write failing classification tests**

Add deterministic fetch doubles keyed by `url.includes('sanook')`. Test these cases with fixed clocks:

```js
new Date('2026-08-01T10:59:59.000Z') // 17:59:59 ICT: partial => waiting
new Date('2026-08-01T11:00:00.000Z') // 18:00:00 ICT: partial => throw
```

Also test partial plus rejected fetch returns waiting with diagnostics; two rejected fetches throw `/all sources unavailable/`; malformed parser inputs throw `/parser error/`; and a complete candidate returns `{ status: 'complete', result }`.

- [ ] **Step 2: Verify RED**

Run: `node --test --test-name-pattern='waiting|unavailable|parser error|18:00' test/thai-results.test.mjs`

Expected: tests fail because collection currently returns a result or generic `no complete valid source result`.

- [ ] **Step 3: Implement source-stage classification**

Wrap fetch and parse separately so HTTP/timeout failures become `unavailable`, parse/date-shape failures become `parser_error`, valid candidates become `complete` when `validateResult(candidate).ok`, and positively dated but incomplete candidates become `partial`. Preserve source and error messages in diagnostics.

Only return waiting when at least one outcome is partial and the injected `now` is before `11:00:00Z` for that ICT calendar date. Throw after the cutoff. If no partial or complete outcome exists, throw a diagnostic fatal error.

- [ ] **Step 4: Update `main` for the union result**

For `{ status: 'waiting' }`, log `Waiting for complete result: <diagnostics>` and return without calling `writeIfNewer`. For complete, pass `outcome.result` to `writeIfNewer` and retain the existing publication log.

- [ ] **Step 5: Verify GREEN**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add thai-results.mjs test/thai-results.test.mjs
git commit -m "Classify partial lottery collection outcomes"
```

### Task 4: Serialize workflow and verify end to end

**Files:**
- Modify: `.github/workflows/thai-results.yml:20-25`
- Test: `test/thai-results.test.mjs`

**Interfaces:**
- GitHub Actions concurrency group: `verified-thai-results`, with queued runs retained.

- [ ] **Step 1: Add workflow concurrency**

Insert before `jobs:`:

```yaml
concurrency:
  group: verified-thai-results
  cancel-in-progress: false
```

- [ ] **Step 2: Run complete verification**

Run: `npm test`

Expected: all tests pass.

Run: `DRAW_DATE=2026-08-01 FORCE=1 node thai-results.mjs`

Expected: either `verified result unchanged` or a complete publication message; never a partial write.

Run: `git diff --check`

Expected: no output and exit 0.

- [ ] **Step 3: Inspect publication data**

Run: `node -e "const r=require('./data/thai-latest.json'); console.log(r.drawDate, r.firstPrize, r.secondPrizes.length, r.thirdPrizes.length, r.fourthPrizes.length, r.fifthPrizes.length)"`

Expected: prize counts `5 10 50 100` for a complete payload.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/thai-results.yml
git commit -m "Serialize verified result collection workflow"
```

- [ ] **Step 5: Push and inspect the next workflow run**

Run: `git push origin main`

Then inspect the next `Collect verified Thai lottery results` run. A partial draw before 18:00 ICT must finish successfully with `Waiting for complete result`; complete data must commit `data/thai-latest.json`; source/parser/mismatch errors must remain failures.
