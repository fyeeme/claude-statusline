# Ideation: GLM 7-Day Usage Calculation Optimization

**Date**: 2026-04-13
**Status**: Selected → Implemented → Discovery (new findings require follow-up)
**Focus**: Fix 7d percentage accuracy — rolling window vs fixed cycle discrepancy

## Phase 1: Original Problem (Solved)

The GLM 7-day usage percentage "rolls back" because the original formula couples it to the volatile 5-hour rolling window percentage.

**Solution implemented**: Calibration approach (`calibratedLimit7d`) — decouples 7d% from `fiveHourPct` by calibrating the limit once and caching it. See `docs/plans/2026-04-13-001-fix-glm-7d-calibration-plan.md`.

## Phase 2: New Discovery — Rolling Window vs Fixed Cycle (2026-04-13)

### Finding: Our token query window doesn't match the platform's limit cycle

Cross-referencing official GLM docs, API data, and user subscription info revealed:

**Official GLM definitions:**
- "每周限额（自下单时开启，以 7 天为一个周期额度刷新重置）" — Fixed 7-day cycle from subscription time
- "每 5 小时限额（动态刷新，额度在请求消耗 5 小时后刷新重置）" — Rolling 5-hour window

**Our code behavior:**
```typescript
// src/glm-usage.ts:134
const ago7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
// Queries tokens from (now - 7d) to now — ROLLING window
```

**The discrepancy:**
- Platform limit: Fixed cycle (e.g., 4/6 15:43 → 4/13 15:43 → 4/20 15:43)
- Our token query: Rolling (now-7d → now)
- These only align perfectly once every 7 days

### Actual Data (2026-04-13, cycle boundary day)

| Metric | Value |
|--------|-------|
| Subscription time | 2026-03-30 15:43:28 (UTC+8) |
| Plan level | Pro |
| Previous fixed cycle (4/6→4/13) | 407.3M tokens |
| Current fixed cycle (4/13→now, ~8h in) | 26.8M tokens |
| Our rolling 7d query | 407.3M tokens (= prev cycle total!) |
| Platform TOKENS_LIMIT | 1% (just reset) |

**At cycle boundaries, our rolling query returns the ENTIRE previous cycle's tokens while the platform shows near-zero.**

### Impact Timeline (from cycle reset)

| Days since reset | Rolling query includes old cycle | Accuracy |
|-----------------|----------------------------------|----------|
| 0-1 | ~7 days of old tokens | Severely inflated |
| 2-3 | ~5 days of old tokens | Significantly inflated |
| 4-5 | ~3 days of old tokens | Moderately inflated |
| 6-7 | ~1 day of old tokens | Slightly inflated |
| 7+ | 0 days of old tokens | Accurate |

### Why calibration only partially helps

- At cycle reset: `fiveHourPct` drops to ~1% (below 10% threshold) → calibration skipped → fallback formula gives ~1% (accidentally correct)
- 2-4 hours later: User starts using tokens, `fiveHourPct` rises to ≥10% → new calibration triggers → but `tokens7d` still has old cycle tokens → 7d% is inflated
- 5-7 days later: Old cycle tokens finally age out of rolling window → accuracy restored

### Key Discovery: TIME_LIMIT.nextResetTime reveals subscription time

```
API response: quota/limit
├── TOKENS_LIMIT.nextResetTime: 2026-04-14 04:16 UTC+8  (5h window reset)
├── TIME_LIMIT.nextResetTime:   2026-04-30 15:43 UTC+8  (monthly reset = subscription anniversary!)
└── level: "pro"
```

From `TIME_LIMIT.nextResetTime`:
- Monthly reset on the 30th at 15:43 UTC+8
- → Subscription time = 30th of each month at 15:43 UTC+8
- → 7-day cycle boundaries: 30th, 6th, 13th, 20th, 27th (at 15:43 UTC+8)

**Verification**: Inferred cycle boundaries match exactly with real subscription time (3/30 15:43 UTC+8).

## Improvement Ideas

### S1: Fixed-Cycle Token Query (Recommended)

**Core idea**: Replace rolling `now - 7d` query with fixed-cycle query using subscription time inferred from `TIME_LIMIT.nextResetTime`.

**Algorithm**:
1. From `TIME_LIMIT.nextResetTime`, extract subscription day-of-month and time-of-day
2. Compute current 7-day cycle start: most recent boundary ≤ now
3. Query `model-usage` API from cycle start to now (not rolling 7d)
4. Calculate: `7d% = cycleTokens / calibratedLimit7d * 100`

**Pros**: Perfect alignment with platform; accuracy independent of cycle position
**Cons**: Depends on `TIME_LIMIT` API field stability; edge cases for month-end subscriptions
**Complexity**: Medium

### S2: Cycle Boundary Detection via 5h% Drops

**Core idea**: Detect cycle resets by monitoring sudden drops in `fiveHourPct`. When it drops from ≥20% to ≤5%, infer a cycle boundary and reset the 7d baseline.

**Pros**: No dependency on TIME_LIMIT field; works with any subscription time
**Cons**: Heuristic — may false-positive on genuine low-usage periods; requires tracking history
**Complexity**: Low-Medium

### S3: Hybrid — Infer + Validate

**Core idea**: Use TIME_LIMIT for initial inference, then validate by checking if the TOKENS_LIMIT percentage is consistent with the inferred cycle position.

**Pros**: More robust than S1 alone; self-correcting
**Cons**: More complex implementation
**Complexity**: Medium-High

### S4: Two-Window Blending

**Core idea**: Query both rolling 7d and current-cycle tokens. Use current-cycle tokens when cycle is <7d old, blend toward rolling as cycle progresses past 7d.

**Pros**: Graceful transition; no hard cutoff
**Cons**: Over-engineering for the actual problem
**Complexity**: High

## Recommendation

**S1 (Fixed-Cycle Token Query)** is the strongest approach because:
1. TIME_LIMIT.nextResetTime provides reliable subscription time inference
2. The API already supports arbitrary time range queries
3. It eliminates the fundamental misalignment rather than working around it
4. The calibration approach (already implemented) remains useful for estimating the limit

### Implementation Sketch for S1

```typescript
// In fetchGlmApi or getGlmUsage:
// 1. Fetch TIME_LIMIT.nextResetTime from quota API
// 2. Infer subscription time: dayOfMonth, hours, minutes from monthly reset
// 3. Compute current cycle start:
//    - Find this month's subscription day at the inferred time
//    - Walk back in 7-day steps to find most recent boundary ≤ now
// 4. Query model-usage from cycleStart to now (instead of now-7d to now)
// 5. Use cycleTokens for 7d% calculation
```

### Risk: TIME_LIMIT Field Stability

The biggest risk is that GLM might change the API or remove `TIME_LIMIT.nextResetTime`. Mitigation:
- Fall back to rolling 7d if TIME_LIMIT is unavailable
- Cache the inferred subscription time (like calibratedLimit7d)
- Subscription time rarely changes, so even a single successful read is valuable

## Session Log

- 2026-04-13: Original ideation — calibration approach selected
- 2026-04-13: Implementation completed (3 units, all tests passing)
- 2026-04-13: Discovery phase — identified rolling vs fixed cycle discrepancy
- 2026-04-13: Cross-validated with live API data, subscription time, and official docs
- 2026-04-13: Discovered TIME_LIMIT.nextResetTime as subscription time oracle
- 2026-04-13: S1 recommended as follow-up improvement
