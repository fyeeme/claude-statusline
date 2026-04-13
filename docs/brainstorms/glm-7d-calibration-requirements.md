---
date: 2026-04-13
topic: glm-7d-calibration
---

# GLM 7-Day Usage Calibration

## Problem Frame

GLM (Z.ai/ZHIPU) platform users see the 7-day usage percentage "roll back" — it drops unexpectedly when the 5-hour rolling window resets. This is confusing because a usage counter should only increase within a billing period.

The root cause: the current formula at `src/glm-usage.ts:283` multiplies `tokens7d` by the volatile `fiveHourPct`, creating direct coupling to the 5-hour rolling window. When old tokens age out of the 5h window, the percentage drops and drags the 7d estimate down with it.

**Who is affected**: All GLM platform users viewing the usage bar in claude-hud.

## Requirements

**Calibration Logic**

- R1. When `fiveHourPct` is not null, `fiveHourPct >= 10%`, and `tokens24h > 0`, calibrate the estimated 7d token limit using: `limit7d = (tokens24h / 5) / (fiveHourPct / 100) * 5`, and cache the result in `CachedUsageData`.
- R2. When a cached calibrated limit exists, calculate 7d percentage as: `7d_pct = tokens7d / cachedLimit7d * 100`, clamped to [0, 100].
- R3. When no calibrated limit exists yet, fall back to the current formula `(tokens7d * (fiveHourPct ?? 0)) / (tokens24h * 7)` for the 7d estimate, guarded by the same `tokens7d >= MIN_TOKENS_FOR_7D && tokens24h > 0` conditions.

**Recalibration**

- R4. Periodically recalibrate the estimated limit. Recalibration interval is independent of the cache TTL — use a separate timestamp (`calibratedAt`) stored alongside the limit. Recalibrate when `Date.now() - calibratedAt >= 24h`.

**Display**

- R5. The display behavior in `src/render/lines/usage.ts` remains unchanged. The 7d bar uses whatever `sevenDay` percentage value is provided.

## Success Criteria

- 7d percentage never drops when only the 5h window rolls over (the primary rollback scenario).
- 7d percentage continues to increase as tokens accumulate within a 7-day period.
- Before first calibration, the 7d bar is still visible (using the fallback formula).
- After calibration, the 7d value is decoupled from `fiveHourPct` fluctuations.

## Scope Boundaries

- Does NOT change the 5h percentage display or calculation.
- Does NOT add user-configurable token limits (considered but deferred).
- Does NOT add high-water mark logic (the calibrated limit approach makes this unnecessary).
- Does NOT detect or display the user's plan tier (Lite/Pro/Max).
- Does NOT change the rendering logic in `src/render/lines/usage.ts`.

## Key Decisions

- **Pre-calibration fallback**: Use the current (imperfect) formula rather than hiding the 7d bar. Chosen to keep the display always visible.
- **10% calibration threshold**: Balances speed of first calibration against estimation accuracy. Below 10%, `tokens24h/5` noise would produce unreliable limits.
- **24h recalibration period**: Handles plan tier changes (e.g., Lite → Pro upgrade) without manual intervention.
- **No high-water mark**: The calibrated approach produces monotonically-increasing values by design (tokens only accumulate), making HWM unnecessary.

## Dependencies / Assumptions

- The GLM plan ratio of 1:5 (5h:7d limit) is assumed to remain constant across all plans and future plan changes. This is documented in the official GLM pricing page.
- `tokens24h / 5` is a reasonable approximation of the current 5h window's token usage. This holds well for steady-state usage but is less accurate during burst patterns.
- The GLM API endpoints (`/api/monitor/usage/quota/limit` and `/api/monitor/usage/model-usage`) remain stable.

## Outstanding Questions

### Resolve Before Planning

(none — all product decisions resolved)

### Deferred to Planning

- [Affects R1][Technical] Exact field names and types for `calibratedLimit7d` and `calibratedAt` within `CachedUsageData`.
- [Affects R4][Technical] How to handle recalibration when the cache TTL (5min) is much shorter than the recalibration interval (24h) — the calibrated limit needs to survive across many cache TTL cycles.
- [Affects R2][Needs research] Verify that `tokens7d` from the API is truly monotonically-increasing within a 7-day window, or if the API's "7d" is also a rolling window that could drop old tokens.

## Next Steps

-> `/ce:plan` for structured implementation planning
