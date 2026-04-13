---
title: Fix GLM 7-Day Usage Rollback via Calibrated Limit
type: fix
status: active
date: 2026-04-13
origin: docs/brainstorms/glm-7d-calibration-requirements.md
---

# Fix GLM 7-Day Usage Rollback via Calibrated Limit

## Overview

Replace the current 7-day usage percentage formula in `src/glm-usage.ts` with a two-phase approach: (1) calibrate the 7d token limit once from observable data, then (2) use pure `tokens7d / cachedLimit` for ongoing calculations. This decouples the 7d percentage from the volatile 5-hour rolling window.

## Problem Frame

GLM platform users see the 7-day usage bar "roll back" when the 5-hour window resets. The current formula `(tokens7d * fiveHourPct) / (tokens24h * 7)` directly multiplies by the volatile `fiveHourPct`, so any 5h drop causes a 7d drop. (See origin: `docs/brainstorms/glm-7d-calibration-requirements.md`)

## Requirements Trace

- R1. When `fiveHourPct` is not null, `>= 10%`, and `tokens24h > 0`, calibrate the 7d limit and cache it
- R2. When a cached calibrated limit exists, calculate `7d_pct = tokens7d / cachedLimit * 100`, clamped to [0, 100]
- R3. When no calibrated limit exists, fall back to the current formula with null guards
- R4. Periodically recalibrate every 24h using a `calibratedAt` timestamp
- R5. Display logic unchanged

## Scope Boundaries

- Does NOT change 5h display or calculation
- Does NOT add user-configurable limits
- Does NOT add high-water mark logic
- Does NOT detect plan tier
- Does NOT change rendering in `src/render/lines/usage.ts`

## Context & Research

### Relevant Code and Patterns

- `src/glm-usage.ts:275-312` — current 7d calculation and cache write
- `src/usage-cache.ts:7-20` — `CachedUsageData` interface (needs extension)
- `src/usage-cache.ts:44-69` — `readCache()` with TTL check (the TTL conflict)
- `src/usage-cache.ts:72-96` — `writeCache()` with atomic write pattern
- `tests/glm-usage.test.js` — existing test suite with `createMockDeps()` pattern
- GLM plan ratio: all plans have fixed 5h:7d = 1:5 limit ratio

### Key Technical Decisions

- **Calibration persistence**: Store `calibratedLimit7d` and `calibratedAt` in the existing cache file, but read them with a new `readCalibrationFields()` function that **ignores TTL**. This avoids adding new files while solving the P0 cache TTL conflict identified in document review.
- **Calibration formula**: `limit7d = (tokens24h / 5) / (fiveHourPct / 100) * 5` — estimates 5h token limit from percentage, then applies the 1:5 ratio. Simplifies to `tokens24h * 100 / fiveHourPct`.
- **Recalibration logic**: On each cache write, check `Date.now() - calibratedAt >= 24h`. If recalibration is due AND `fiveHourPct >= 10%`, recalculate. Otherwise carry forward the existing calibration.
- **Fallback behavior**: Before first calibration, use the current formula (the rollback-prone one). This keeps the 7d bar visible during the warm-up period.

## Open Questions

### Resolved During Planning

- **Cache TTL conflict (P0 from review)**: Solved with `readCalibrationFields()` — a TTL-exempt read that extracts only calibration data from expired cache entries. The regular `readCache()` path is unchanged.
- **Where to store calibration data**: Inside `CachedUsageData` as optional fields. Read via separate function, carried forward on each write.

### Deferred to Implementation

- **tokens7d monotonicity (P1 from review)**: Verify during testing that the GLM API's 7d token count is cumulative within a billing period. If it's also a rolling window, the calibrated approach will still reduce rollback frequency from ~5h to ~7d.
- **Calibration accuracy in burst patterns**: The `tokens24h/5` approximation is acknowledged as approximate. The 24h recalibration provides periodic correction.

## Implementation Units

- [x] **Unit 1: Extend cache schema with calibration fields and TTL-exempt read**

**Goal:** Add `calibratedLimit7d` and `calibratedAt` to the cache interface, and provide a way to read calibration data that survives TTL expiration.

**Requirements:** R1, R4

**Dependencies:** None

**Files:**
- Modify: `src/usage-cache.ts`
- Modify: `tests/usage-cache.test.js`

**Approach:**
- Add optional fields `calibratedLimit7d?: number` and `calibratedAt?: number` to `CachedUsageData`
- Add new exported function `readCalibrationFields()` that reads the cache file, parses it, and returns only `calibratedLimit7d` and `calibratedAt` — ignoring the TTL check
- Update `cacheToUsageData()` to carry forward the new fields
- The regular `readCache()` remains unchanged

**Patterns to follow:**
- Existing `readCache()` pattern in `src/usage-cache.ts:44-69`
- Existing `writeCache()` atomic write pattern in `src/usage-cache.ts:72-96`

**Test scenarios:**
- Happy path: `readCalibrationFields()` returns calibration data from a non-expired cache entry
- Edge case: `readCalibrationFields()` returns calibration data from an expired cache entry (TTL bypass)
- Edge case: `readCalibrationFields()` returns null when cache file does not exist
- Edge case: `readCalibrationFields()` returns null when cache has no calibration fields
- Edge case: `readCalibrationFields()` returns null on corrupt JSON

**Verification:**
- `readCalibrationFields()` can retrieve calibration data from expired cache entries
- Existing `readCache()` behavior is unchanged (still respects TTL)

---

- [x] **Unit 2: Implement calibration logic in glm-usage.ts**

**Goal:** Replace the current 7d formula with calibration-based calculation. On each API fetch, either calibrate/recalibrate the limit, use the cached limit, or fall back to the old formula.

**Requirements:** R1, R2, R3, R4

**Dependencies:** Unit 1

**Files:**
- Modify: `src/glm-usage.ts`
- Modify: `tests/glm-usage.test.js`

**Approach:**

The calibration state machine:

```
On cache miss → API fetch → get results
  ↓
Read calibration via readCalibrationFields()
  ↓
Has calibration? ─── No ──→ Attempt calibration (if fiveHourPct >= 10% && tokens24h > 0)
  │                              ↓
  │                         Calibrated? ── Yes → Use calibrated limit
  │                              ↓
  │                          No → Use fallback formula (R3)
  ↓
Yes ──→ Is calibratedAt >= 24h ago?
           ↓                    ↓
          Yes                  No
           ↓                    ↓
     Attempt recalibration    Use existing limit
     (if fiveHourPct >= 10%)
           ↓
     Success? ── Yes → Update calibration
           ↓
          No → Keep existing calibration
```

Key implementation points:
- Import `readCalibrationFields` from `usage-cache.js`
- After API fetch succeeds, read calibration state
- Calibration formula: `calibratedLimit7d = (tokens24h * 100) / fiveHourPct` (simplified from R1)
- 7d percentage when calibrated: `tokens7d / calibratedLimit7d * 100`, clamped [0, 100]
- Fallback when no calibration: `(tokens7d * (fiveHourPct ?? 0)) / (tokens24h * 7)` (same as current)
- When writing cache, always carry forward `calibratedLimit7d` and `calibratedAt` from previous calibration read

**Patterns to follow:**
- Existing `getGlmUsage()` error handling in `src/glm-usage.ts:312-350`
- Existing `createMockDeps()` test pattern in `tests/glm-usage.test.js:43-61`
- Existing `writeCache()` calls throughout `getGlmUsage()`

**Test scenarios:**
- Happy path: First calibration triggers when fiveHourPct=15%, tokens24h>0, produces correct limit
- Happy path: After calibration, 7d% = tokens7d / calibratedLimit * 100 (no fiveHourPct dependency)
- Happy path: 7d% does NOT change when fiveHourPct drops (the core rollback fix)
- Edge case: Calibration skipped when fiveHourPct < 10% (falls back to old formula)
- Edge case: Calibration skipped when fiveHourPct is null
- Edge case: Calibration skipped when tokens24h is 0
- Edge case: Existing calibration carried forward when fiveHourPct < 10%
- Edge case: Recalibration triggers after 24h when fiveHourPct >= 10%
- Edge case: Recalibration skipped after 24h when fiveHourPct < 10% (keeps old calibration)
- Edge case: 7d% clamped to 100 when tokens7d > calibratedLimit
- Edge case: 7d% returns 0 when calibratedLimit is 0 (div-by-zero guard)
- Error path: Auth error does not destroy calibration data
- Error path: Retryable error falls back to cached calibration if available
- Integration: Full flow — no calibration → first calibration → subsequent reads → recalibration at 24h

**Verification:**
- When fiveHourPct changes (e.g., 50% → 20% due to 5h window rollover), the 7d percentage remains stable after calibration
- The 7d percentage only changes based on tokens7d movement, not fiveHourPct movement

---

- [x] **Unit 3: Update existing tests and verify end-to-end**

**Goal:** Update existing test assertions that relied on the old formula, and add regression tests for the rollback scenario.

**Requirements:** All (R1-R5)

**Dependencies:** Unit 2

**Files:**
- Modify: `tests/glm-usage.test.js`

**Approach:**
- The test at line 125 (`assert.equal(result.sevenDay, 8)`) uses the old formula. Update it to match the new calibrated calculation.
- The test at line 159 ("clamps 7d percentage to 100") needs updating since the formula changes.
- Add a regression test: verify that after calibration, changing fiveHourPct alone does NOT change sevenDay.
- Add a test for the calibration state machine transitions.
- Run full test suite and verify the expected output fixture if applicable.

**Patterns to follow:**
- Existing `createMockDeps()` mock pattern
- Existing test structure in `tests/glm-usage.test.js`

**Test scenarios:**
- Regression: After calibration with fiveHourPct=50%, a second call with fiveHourPct=10% (same tokens) produces the same 7d%
- Regression: 7d% increases proportionally when tokens7d increases between calls
- Existing test assertions updated to match new formula

**Verification:**
- `npm test` passes with all new and updated tests
- `npm run build` succeeds

## System-Wide Impact

- **Interaction graph:** `glm-usage.ts` is called from the main render pipeline via `getGlmUsage()`. The `readCalibrationFields()` function adds a new read path to `usage-cache.ts`.
- **Error propagation:** Calibration data loss (corrupt file, permissions) gracefully falls back to the old formula. No new error types needed.
- **State lifecycle risks:** Calibration data could be stale if the user changes plans. Mitigated by 24h recalibration and the fact that calibration only improves over time.
- **Unchanged invariants:** 5h display, rendering logic, cache file location, and Anthropic platform behavior are all unchanged.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `tokens24h/5` approximation inaccurate during burst usage | 24h recalibration provides periodic correction; first calibration at >=10% reduces noise |
| tokens7d is also a rolling window (not cumulative) | Calibrated approach still reduces rollback frequency from ~5h to ~7d; verify during testing |
| GLM changes the 1:5 plan ratio | 24h recalibration auto-corrects; worst case is 24h of slightly inaccurate display |
| Plan downgrade inflates calibrated limit | Low probability event; resolves within 24h via recalibration |

## Sources & References

- **Origin document:** [glm-7d-calibration-requirements.md](docs/brainstorms/glm-7d-calibration-requirements.md)
- **Ideation document:** [glm-7d-calculation.md](docs/ideation/glm-7d-calculation.md)
- Related code: `src/glm-usage.ts`, `src/usage-cache.ts`
- GLM plan docs: https://docs.bigmodel.cn/cn/coding-plan/overview
