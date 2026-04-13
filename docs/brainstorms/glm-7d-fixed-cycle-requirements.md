---
date: 2026-04-13
topic: glm-7d-fixed-cycle
---

# GLM 7-Day Fixed-Cycle Token Query

## Problem Frame

GLM platform's weekly token limit operates on a **fixed 7-day cycle** from the subscription time (e.g., 3/30 → 4/6 → 4/13 → 4/20 at 15:43 UTC+8). Our code queries tokens using a **rolling 7-day window** (`now - 7d` to `now`). These only align perfectly once per cycle, causing the 7d percentage to be inflated for ~5 days after each cycle reset.

Verified with live data (2026-04-13, a cycle boundary day):

| Metric | Value |
|--------|-------|
| Platform TOKENS_LIMIT | 1% (cycle just reset) |
| Rolling 7d query tokens | 407.3M (entire previous cycle) |
| Actual current cycle tokens | 26.8M (8 hours into new cycle) |

Origin: `docs/ideation/glm-7d-calculation.md` (Phase 2 discovery)

## Requirements

**Subscription Time Inference**

- R1. Extract `TIME_LIMIT.nextResetTime` from the `quota/limit` API response. This field contains the monthly reset timestamp, which aligns with the subscription anniversary (verified: monthly reset 4/30 15:43 UTC+8 ↔ subscription 3/30 15:43 UTC+8).
- R2. Infer subscription time from `TIME_LIMIT.nextResetTime`: extract day-of-month, hour, minute from the monthly reset timestamp. The subscription occurs on the same day and time each month.
- R3. Cache the inferred subscription time in the existing usage cache file alongside calibration data. This persists across cache TTL cycles (same pattern as `readCalibrationFields()`).

**Cycle Boundary Computation**

- R4. From the (cached or freshly inferred) subscription time, compute the current 7-day cycle start: the most recent `subscriptionTime + n * 7d` that is ≤ now. Use this as the start time for the 7-day token query instead of `now - 7d`.

**Token Query**

- R5. Query the `model-usage` API with `startTime = cycleStart` and `endTime = now` (instead of `startTime = now - 7d`). The returned tokens represent actual usage within the current fixed cycle.
- R6. Continue using the calibrated limit (`calibratedLimit7d`) for the denominator. The calibration estimates the 7d token limit from 5h% and 24h tokens — this is still needed because the API does not expose the exact 7d token limit.

**Fallback Behavior**

- R7. When `TIME_LIMIT.nextResetTime` is absent from the API response **and** no cached subscription time exists, set `sevenDay` to `null` (hide the 7d bar). Do not fall back to the rolling 7d query — showing inaccurate data is worse than showing no data.

**Display**

- R8. When using fixed-cycle tokens (R5), set `sevenDayWindowType` to `'cycle'` (new value added to `UsageWindowType`). When falling back (R7), `sevenDay` is null so window type is irrelevant.

## Success Criteria

- At cycle reset (minute 0 of new cycle): 7d% reflects only new-cycle tokens (near 0%), matching the platform's TOKENS_LIMIT reset behavior.
- Mid-cycle: 7d% increases proportionally as tokens accumulate within the fixed cycle.
- No 7d display at all when subscription time cannot be determined.
- Existing 5h display and calculation unchanged.

## Scope Boundaries

- Does NOT change 5h percentage display or calculation
- Does NOT change the calibration approach for estimating the 7d token limit (`calibratedLimit7d`)
- Does NOT add user-configurable subscription time
- Removes `'estimated'` from `UsageWindowType` (replaced by `'cycle'` for 7d). The `'rolling'` type is kept for 5h only. `UsageWindowType` becomes `'fixed' | 'rolling' | 'cycle'`.
- Does NOT display cycle reset countdown in this iteration (future consideration)
- Does NOT attempt to detect plan tier limits from `level` field

## Key Decisions

- **Fallback = hide 7d**: When subscription time is unknown, do not show 7d data at all. Avoids displaying inaccurate rolling-window data that misrepresents the fixed-cycle limit. (Chosen over rolling fallback)
- **Cache subscription time**: A single successful inference is sufficient because subscription time rarely changes. Caching avoids dependency on every API call returning TIME_LIMIT data.
- **New 'cycle' window type**: Distinguishes fixed-cycle tokens from the previous 'estimated' (rolling-window approximation). Enables future display enhancements like showing cycle reset countdown.
- **Keep calibration for limit estimation**: The fixed-cycle query fixes the numerator (tokens used), but the denominator (7d token limit) is still estimated via calibration since the API doesn't expose it directly.

## Dependencies / Assumptions

- `TIME_LIMIT.nextResetTime` field in the `quota/limit` API response is stable and reliably represents the monthly subscription anniversary. Verified on 2026-04-13 with Pro plan.
- Subscription time is consistent across all GLM plan tiers (Lite, Pro, Max). The monthly reset pattern should be the same.
- The `model-usage` API accepts arbitrary `startTime`/`endTime` parameters and returns accurate token counts for any range (verified with cycle-boundary-aligned queries).
- Month-length edge cases (e.g., subscription on 31st, February) are handled by using the actual `nextResetTime` timestamp rather than reconstructing the date from day-of-month alone.

## Outstanding Questions

### Resolve Before Planning

(none — all product decisions resolved)

### Deferred to Planning

- [Affects R4][Technical] How to handle month-length edge cases in cycle computation: subscription on the 31st means February has no matching day. The `nextResetTime` approach sidesteps this, but the cached timestamp may need periodic refresh.
- [Affects R5][Technical] The `fetchGlmApi` function currently runs quota + 24h-usage + 7d-usage in parallel. Computing the cycle start requires the quota response first. Whether to serialize or compute cycle start from cached subscription time (parallel-friendly).
- [Affects R8][Technical] Whether `'cycle'` window type in `formatUsageWindowPart` should display differently from `'estimated'` (e.g., show cycle reset countdown instead of token count).

## Next Steps

-> `/ce:plan` for structured implementation planning
