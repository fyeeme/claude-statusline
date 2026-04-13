---
title: GLM Fixed-Cycle 7d Token Query
type: feat
status: active
date: 2026-04-13
origin: docs/brainstorms/glm-7d-fixed-cycle-requirements.md
---

# GLM Fixed-Cycle 7d Token Query

## Overview

Replace the rolling 7-day token query (`now - 7d` to `now`) with a fixed-cycle query aligned to the user's subscription time. The subscription time is inferred from the `TIME_LIMIT.nextResetTime` field in the `quota/limit` API response, which represents the monthly reset timestamp matching the subscription anniversary.

## Problem Frame

GLM platform's weekly token limit operates on a fixed 7-day cycle from subscription time (e.g., 3/30 → 4/6 → 4/13 → 4/20). Our code queries tokens using a rolling 7-day window. These only align once per cycle, causing the 7d percentage to be inflated for ~5 days after each cycle reset. Verified with live data: at cycle boundary, platform shows 1% while our rolling query returns the entire previous cycle's 407.3M tokens. (See origin: `docs/brainstorms/glm-7d-fixed-cycle-requirements.md`)

## Requirements Trace

- R1. Extract `TIME_LIMIT.nextResetTime` from the `quota/limit` API response
- R2. Infer subscription time from the monthly reset timestamp (day-of-month + time-of-day)
- R3. Cache the inferred subscription time in the usage cache file (TTL-exempt)
- R4. Compute current 7-day cycle start: most recent `subscriptionTime + n * 7d` that is ≤ now
- R5. Query `model-usage` API with `startTime = cycleStart, endTime = now` (not rolling 7d)
- R6. Continue using calibrated limit (`calibratedLimit7d`) for the denominator
- R7. When subscription time is unavailable and not cached, set `sevenDay` to `null`
- R8. Use `'cycle'` window type for display (replacing `'estimated'`)

## Scope Boundaries

- Does NOT change 5h percentage display or calculation
- Does NOT change the calibration approach for estimating the 7d token limit (`calibratedLimit7d`)
- Does NOT add user-configurable subscription time
- Removes `'estimated'` from `UsageWindowType` (replaced by `'cycle'` for 7d). `'rolling'` kept for 5h only. `UsageWindowType` becomes `'fixed' | 'rolling' | 'cycle'`.
- Does NOT display cycle reset countdown in this iteration (future consideration)
- Does NOT attempt to detect plan tier limits from `level` field

## Context & Research

### Relevant Code and Patterns

- `src/glm-usage.ts:131-197` — `fetchGlmApi()`: parallel quota + 24h + 7d queries. Currently only extracts `TOKENS_LIMIT.percentage`. Needs to also extract `TIME_LIMIT.nextResetTime`.
- `src/glm-usage.ts:134` — `const ago7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);` — rolling 7d query range. Replace with `cycleStart`.
- `src/glm-usage.ts:14-17` — `QuotaLimit` and `QuotaResponse` types. Need to add `nextResetTime` field.
- `src/glm-usage.ts:125-129` — `GlmApiResults` interface. Need to add `timeLimitResetTime`.
- `src/glm-usage.ts:278-280` — Calibration read before API call (same pattern for subscription time read).
- `src/usage-cache.ts:7-24` — `CachedUsageData` interface. Add `subscriptionTimeMs` field.
- `src/usage-cache.ts:77-98` — `readCalibrationFields()` (TTL-exempt read). Extend to also return `subscriptionTimeMs`.
- `src/types.ts:67` — `UsageWindowType` type. Remove `'estimated'`, add `'cycle'`.
- `src/render/lines/usage.ts:130-139` — `isSemanticWindow` and suffix building. Update to handle `'cycle'` instead of `'estimated'`.
- `tests/glm-usage.test.js` — All tests using `'estimated'` window type need updating.
- `tests/usage-cache.test.js` — All tests using `'estimated'` window type need updating.

### API Response Structure (verified 2026-04-13)

```json
{
  "data": {
    "limits": [
      {
        "type": "TOKENS_LIMIT",
        "unit": 3, "number": 5,
        "percentage": 1,
        "nextResetTime": 1776111361388
      },
      {
        "type": "TIME_LIMIT",
        "unit": 5, "number": 1,
        "nextResetTime": 1777534992998,
        "percentage": 9
      }
    ],
    "level": "pro"
  }
}
```

Key field: `TIME_LIMIT.nextResetTime` = monthly reset timestamp (e.g., 2026-04-30 15:43 UTC+8). This is the subscription anniversary.

## Key Technical Decisions

- **Subscription time inference from TIME_LIMIT.nextResetTime**: The monthly reset happens on the same day and time as the original subscription. Verified: monthly reset 4/30 15:43 UTC+8 matches subscription 3/30 15:43 UTC+8 exactly. (see origin: R1, R2)

- **Cycle computation uses subscription day as reference**: The subscription day is a 7-day-aligned reference point. Cycles are `subscriptionTime + n * 7d`. Find the largest `n` such that the boundary is ≤ now. (see origin: R4)

- **Cached subscription time enables parallel fetch pattern**: Read cached `subscriptionTimeMs` before API call → compute `cycleStart` → pass to `fetchGlmApi`. This keeps the existing parallel pattern (quota + 24h + 7d in parallel) because `cycleStart` is pre-computed from cache, not from the live quota response. First API call uses rolling 7d but hides the result; second call uses fixed-cycle. (see origin: R3, R5, R7)

- **Fallback: hide 7d entirely (not rolling)**: When subscription time is unknown, return `sevenDay: null`. No inaccurate rolling-window data. The user accepted this conservative approach. (see origin: R7)

- **'cycle' window type replaces 'estimated'**: Remove `'estimated'` from `UsageWindowType`. All GLM 7d data now uses `'cycle'`. The `'rolling'` type remains for 5h only. (see origin: R8)

- **'cycle' rendering shows token count**: Treat `'cycle'` the same as `'estimated'` was for rendering — show token count suffix like `(310M / 7d)`. The difference is semantic (fixed-cycle vs estimated), not visual. Future: cycle reset countdown.

## Open Questions

### Resolved During Planning

- **How to handle parallel fetch with cycle dependency**: Pre-compute `cycleStart` from cached `subscriptionTimeMs` before API call. First call has no cache → uses rolling query but hides result → caches subscription time. Second call uses cache for `cycleStart`.
- **'cycle' rendering behavior**: Same visual output as 'estimated' (token count suffix), different semantic type.

### Deferred to Implementation

- **Month-end edge cases in subscription inference**: Subscription on the 31st means February has no matching day. The inference function should handle this by using the last day of the month. The `nextResetTime` is an absolute timestamp, so the day-of-month extraction is straightforward in most cases.
- **Timezone consistency**: GLM is UTC+8 without DST. The `nextResetTime` is epoch-based so timezone handling is implicit. Implementation should use UTC methods consistently.

## Implementation Units

- [ ] **Unit 1: Types, cache schema, and cycle computation utilities**

**Goal:** Add the `'cycle'` window type, extend the cache with subscription time, and implement the subscription inference + cycle boundary computation functions.

**Requirements:** R2, R3, R4, R8 (partial — type change)

**Dependencies:** None

**Files:**
- Modify: `src/types.ts`
- Modify: `src/usage-cache.ts`
- Modify: `tests/usage-cache.test.js`

**Approach:**
- In `src/types.ts`: change `UsageWindowType` from `'fixed' | 'rolling' | 'estimated'` to `'fixed' | 'rolling' | 'cycle'`.
- In `src/usage-cache.ts`:
  - Add `subscriptionTimeMs?: number` to `CachedUsageData` interface
  - Extend `readCalibrationFields()` to also return `subscriptionTimeMs` (still TTL-exempt)
  - Add exported function `inferSubscriptionTime(timeLimitResetMs: number): number` — extracts day-of-month and time-of-day from the monthly reset timestamp, finds the most recent occurrence of that day+time before now. Uses UTC methods for consistency.
  - Add exported function `computeCycleStart(subscriptionTimeMs: number, nowMs: number): number` — computes `subscriptionTimeMs + n * 7d` where `n = Math.floor((nowMs - subscriptionTimeMs) / (7 * 24 * 60 * 60 * 1000))`. Returns the most recent cycle boundary ≤ now.
  - Update `cacheToUsageData()` to carry forward `subscriptionTimeMs`
- Update all `'estimated'` references in `tests/usage-cache.test.js` to `'cycle'`

**Patterns to follow:**
- Existing `readCalibrationFields()` TTL-exempt read pattern
- Existing `CachedUsageData` field extension pattern (same as `calibratedLimit7d` addition)

**Test scenarios:**
- Happy path: `inferSubscriptionTime()` extracts correct subscription time from monthly reset timestamp
- Edge case: `inferSubscriptionTime()` handles month-end dates (30th in February → uses Feb 28/29)
- Happy path: `computeCycleStart()` returns correct boundary when now is mid-cycle
- Edge case: `computeCycleStart()` returns subscription time itself when now is exactly at a cycle boundary
- Edge case: `computeCycleStart()` returns subscription time when now is exactly the subscription time
- Happy path: `readCalibrationFields()` returns `subscriptionTimeMs` alongside calibration data
- Edge case: `readCalibrationFields()` returns null when no subscription time in cache

**Verification:**
- `computeCycleStart(subscriptionTime, now)` returns a timestamp that is `subscriptionTime + n * 7d` and ≤ now
- `readCalibrationFields()` reads `subscriptionTimeMs` from expired cache entries

---

- [ ] **Unit 2: Integrate subscription inference and fixed-cycle query into getGlmUsage**

**Goal:** Extract `TIME_LIMIT.nextResetTime` from the quota API, infer and cache subscription time, replace rolling 7d query with fixed-cycle query, and handle the fallback (hide 7d when subscription time unknown).

**Requirements:** R1, R2, R3, R4, R5, R6, R7, R8

**Dependencies:** Unit 1

**Files:**
- Modify: `src/glm-usage.ts`
- Modify: `tests/glm-usage.test.js`

**Approach:**

**Step A — Extend quota parsing:**
- Update `QuotaLimit` interface to include optional `nextResetTime?: number`
- In `fetchGlmApi()`, extract `TIME_LIMIT` entry from limits array in addition to `TOKENS_LIMIT`
- Extract `nextResetTime` from the TIME_LIMIT entry
- Return `timeLimitResetTime` in `GlmApiResults`

**Step B — Change 7d query range:**
- `fetchGlmApi()` gains an optional parameter: `cycleStart?: number`
- When `cycleStart` is provided, the 7d query uses `startTime = cycleStart, endTime = now`
- When `cycleStart` is not provided, falls back to rolling `now - 7d` (only for first call before subscription is cached)

**Step C — Integrate into getGlmUsage:**
- Before API call: read `subscriptionTimeMs` from `readCalibrationFields()`
- If subscription time exists: compute `cycleStart = computeCycleStart(subscriptionTimeMs, nowMs)` and pass to `fetchGlmApi`
- If subscription time does not exist: call `fetchGlmApi` without `cycleStart` (will use rolling range, but result hidden per R7)
- After API call: if `timeLimitResetTime` is present and no cached subscription time: infer subscription time via `inferSubscriptionTime(timeLimitResetTime)` and include in cache write
- Use `'cycle'` as `sevenDayWindowType` when using fixed-cycle tokens
- When no subscription time (neither cached nor inferred): set `sevenDay = null` (hide 7d bar per R7)
- Carry forward `subscriptionTimeMs` in all cache writes (same pattern as calibration fields)

**Step D — Remove old fallback formula:**
- The old fallback formula `(tokens7d * fiveHourPct) / (tokens24h * 7)` is removed
- With the new approach, 7d is either calculated with fixed-cycle tokens + calibrated limit, or hidden entirely
- The `CALIBRATION_THRESHOLD_PCT` check is simplified: if we have calibrated limit AND subscription time, show 7d; otherwise hide

**Patterns to follow:**
- Existing `readCalibrationFields()` usage pattern in `getGlmUsage()`
- Existing cache-write with field carry-forward pattern (calibration fields)
- Existing `createMockDeps()` test pattern with `readCalibrationFields` override

**Test scenarios:**
- Happy path: First call with TIME_LIMIT.nextResetTime → infers subscription time → caches it → hides 7d (R7, first call)
- Happy path: Second call with cached subscription time → computes cycleStart → uses fixed-cycle query → shows 7d with 'cycle' type
- Happy path: Fixed-cycle query returns correct tokens for current cycle
- Edge case: TIME_LIMIT not present in quota response → no subscription inference → 7d hidden
- Edge case: Subscription time cached but quota API fails → still uses cached subscription time for cycle query
- Edge case: Cycle start at boundary (now is exactly cycle start) → cycleStart = now → tokens7d = 0 or very small
- Regression: After cycle reset, 7d% shows near 0% (not previous cycle's inflated value)
- Regression: 7d% increases as tokens accumulate within the fixed cycle
- Integration: Full flow — no cache → first call (hide 7d, cache subscription) → second call (show 7d with cycle)
- Integration: Calibration + fixed-cycle: calibrated limit estimates denominator, fixed-cycle tokens for numerator

**Verification:**
- When subscription time is known, 7d tokens come from `cycleStart → now` range
- When subscription time is unknown, `sevenDay` is `null`
- `subscriptionTimeMs` is persisted in cache and survives TTL expiration

---

- [ ] **Unit 3: Rendering update and test migration**

**Goal:** Update the rendering code to handle `'cycle'` window type, remove all `'estimated'` references, and migrate existing tests.

**Requirements:** R8

**Dependencies:** Unit 2

**Files:**
- Modify: `src/render/lines/usage.ts`
- Modify: `tests/glm-usage.test.js` (remaining assertions)
- Modify: `tests/fixtures/expected/render-basic.txt` (if it contains GLM 7d output)

**Approach:**
- In `formatUsageWindowPart()`:
  - Update `isSemanticWindow` check: replace `'estimated'` with `'cycle'`
  - Update suffix building: `windowType === 'cycle'` shows token count (same visual as `'estimated'` was)
  - Remove the `'estimated'` branch, add `'cycle'` branch with identical token-count display
- In all test files: replace `sevenDayWindowType: 'estimated'` with `sevenDayWindowType: 'cycle'`
- Update assertions: `assert.equal(result.sevenDayWindowType, 'cycle')` instead of `'estimated'`
- Run full test suite to verify no regressions

**Patterns to follow:**
- Existing `formatUsageWindowPart()` suffix pattern for `'estimated'`

**Test scenarios:**
- Happy path: `'cycle'` type renders token count suffix like `(310M / 7d)`
- Happy path: `'rolling'` type still renders label suffix like `(5h)`
- Edge case: `sevenDayWindowType` is `undefined` (null sevenDay) → no suffix rendered
- Existing test migration: all `'estimated'` assertions → `'cycle'`

**Verification:**
- `npm test` passes with all updated assertions
- `npm run build` succeeds
- Visual output unchanged for existing usage patterns (same token count display)

## System-Wide Impact

- **Interaction graph:** `getGlmUsage()` adds `readCalibrationFields()` call for subscription time (pre-existing pattern). `fetchGlmApi()` gains an optional parameter. No new entry points.
- **Error propagation:** Subscription time inference failure (no TIME_LIMIT in response) → `sevenDay = null`. This is the intended fallback, not an error state.
- **State lifecycle risks:** First API call after install always hides 7d (subscription time not yet cached). Resolves on second call (~5 min later). Low impact since 7d display appears after one cache cycle.
- **API surface parity:** `UsageWindowType` change affects all consumers of the type. `'estimated'` is only used for GLM 7d, so no cross-platform impact.
- **Unchanged invariants:** 5h display, Anthropic platform behavior, cache file location, calibration approach.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| GLM removes `TIME_LIMIT.nextResetTime` from API | Fallback: hide 7d. Low probability — field is core to their quota system. |
| Month-end subscription (31st) in February | `inferSubscriptionTime()` handles by using last day of month. Edge case, low impact. |
| Subscription time changes (plan renewal at different date) | Old cache becomes stale. New `TIME_LIMIT.nextResetTime` in next API call updates it. |
| First-call 7d hidden (up to 5 min) | Acceptable per user decision. Only affects first use after install. |
| `fetchGlmApi` interface change adds `cycleStart` parameter | Optional parameter with fallback. No breaking change to existing callers. |

## Sources & References

- **Origin document:** [glm-7d-fixed-cycle-requirements.md](docs/brainstorms/glm-7d-fixed-cycle-requirements.md)
- **Ideation document:** [glm-7d-calculation.md](docs/ideation/glm-7d-calculation.md)
- **Prior plan (calibration, implemented):** [2026-04-13-001-fix-glm-7d-calibration-plan.md](docs/plans/2026-04-13-001-fix-glm-7d-calibration-plan.md)
- Related code: `src/glm-usage.ts`, `src/usage-cache.ts`, `src/types.ts`, `src/render/lines/usage.ts`
- GLM quota API: `https://api.z.ai/api/monitor/usage/quota/limit`
