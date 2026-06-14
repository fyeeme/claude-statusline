---
title: deepseek provider 移植 + 颜色统一 65/85
type: feat
status: active
date: 2026-06-14
origin: pi-statusline 参考实现（packages/extensions/pi-statusline/index.ts，外部 repo）
---

# deepseek provider 移植 + 颜色统一 65/85

## Summary

参考 pi-statusline 的多 provider 设计，为 claude-hud 新增 **deepseek provider**（账户余额 / 当前会话费用 / 自然周 token 使用量），保留现有 glm（5h + 周配额）与 anthropic 路径，并把 context/usage 的颜色阈值**统一为 65%(warning 黄)/85%(error 红)**、正常态默认 dim（不加额外颜色）。策略模式沿用现有 `getUsage` + `detectPlatform` 路由（每 provider 独立模块），不重写为 formal `UsageProvider` interface/registry——3 个 provider 的路由分支已是合理的策略模式实现。

---

## Problem Frame

claude-hud 当前只支持 anthropic（stdin rate_limits）和 glm（API fetch）两个 usage 来源。用户同时使用 deepseek（通过 Claude Code 的 `ANTHROPIC_BASE_URL=api.deepseek.com`），但 statusline 对 deepseek 不显示任何 usage 信息（无余额、无费用、无 token 量）。同时 context 与 usage 的预警阈值不一致（context 70/85、quota 75/90），颜色档位多（绿/黄/红 + 蓝/品红/红），与"简洁清晰"的目标冲突。pi-statusline 已验证了 deepseek 余额 API + 自然周 token 扫描 + 65/85 颜色的可行性，本次把它移植到 claude-hud。

---

## Requirements

- R1. 当 `ANTHROPIC_BASE_URL` 指向 deepseek 域名时，`detectPlatform` 返回 `'deepseek'`，`getUsage` 路由到 deepseek provider。
- R2. deepseek provider 展示三项：**账户余额**（`GET /user/balance`，复用 `ANTHROPIC_API_KEY`）、**当前会话费用**（基于 deepseek 模型定价估算）、**自然周 token 使用量**（扫描当前项目本周的 session JSONL）。
- R3. glm provider **简化周额度逻辑**：删除 EMA 校准与基于 limit 反推的 7d% 计算；7d% 直接用 API unit:6 weekly percentage（有周额度时），或自然周 token 扫描（无周额度时，参考 pi-statusline ZaiProvider）。5h cycle 行为保留。
- R4. `UsageData` 容纳 deepseek 的余额导向数据（balance/currency/weeklyTokens/sessionCost），同时不破坏 glm/anthropic 的百分比字段。
- R5. context 与 usage 百分比的颜色阈值统一：`<65% dim`（默认不加额外颜色）/ `≥65% warning`（黄）/ `≥85% error`（红）。替换现有 `getContextColor`(70/85 绿黄红) 与 `getQuotaColor`(75/90 蓝品红红)。
- R6. deepseek fetch 带 5 分钟缓存（statusline 每 ~300ms 调用，不能每次扫 session 文件 + 打 API）。
- R7. API 失败 / 无 key / 无 session 文件时优雅降级（返回部分数据或 null，不抛错）。

---

## Scope Boundaries

- 不重构现有 `usage/claude/`、`usage/glm/` 为 formal `UsageProvider` interface + registry。3 provider 的 `detectPlatform` + `getUsage` 路由分支已是策略模式；引入 interface/registry 是 over-engineering，且会破坏 GLM 现有测试与 deps 注入模式。
- 不改 glm 的 5h cycle 逻辑；但**删除 7d 的 EMA 校准与 compute7d**（简化为直接用 API unit:6 weekly percentage，或自然周 token）。`calibration.ts` 的 `updateCalibration` 与 `compute.ts` 的 `compute7d` 删除；`inferSubscriptionTime`/`computeCycleStart`/`applyMonotonicGuard` 按是否仍被引用评估保留。
- 不改 anthropic（stdin rate_limits）路径。
- deepseek 不实现 EMA 校准 / monotonic guard（glm 才需要；deepseek balance 是绝对值，无需校准）。
- 不加 deepseek 的 /currency 命令或币种切换（沿用现有 deepseek→¥ 约定）。

### Deferred to Follow-Up Work

- deepseek 模型定价表的精确值（实现时填入 deepseek-chat / deepseek-reasoner 的实际单价；plan 给占位）。
- 自然周 token 扫描的性能优化（增量扫描 / 文件 mtime 缓存），若 5min TTL 缓存下首次扫描仍慢。

---

## Context & Research

### Relevant Code and Patterns

- `src/usage/index.ts` — `getUsage(stdin, deps)` + `detectPlatform()` 路由（anthropic/glm）。deepseek 在此加分支。
- `src/glm-detect.ts` — `detectPlatform(baseUrl)` 按 `ANTHROPIC_BASE_URL` 域名匹配（api.z.ai/open.bigmodel.cn/dev.bigmodel.cn）。deepseek 加 `api.deepseek.com` + `api.deepseek.com` 子域。
- `src/usage/glm/index.ts` — `getGlmUsage(deps)` 状态机 + deps 注入（testable）。**deepseek provider 参考其 deps 注入模式与 cache 模式，但不复制 EMA/校准复杂度。**
- `src/usage/glm/cache.ts` — `readCache/writeCache`（platform-keyed）。deepseek 复用 cache 机制或新建简单 cache。
- `src/cost.ts` — `SessionCostEstimate` 基于 `ANTHROPIC_MODEL_PRICING` 估算。**加 deepseek 模型定价条目**。
- `src/types.ts` — `UsageData`（百分比导向）+ `UsagePlatform = 'anthropic'|'glm'`。扩展。
- `src/render/colors.ts` — `getContextColor`(70/85) + `getQuotaColor`(75/90)。统一 65/85。
- `src/render/lines/usage.ts` + `src/render/session-line.ts` — usage 渲染。加 deepseek 分支。
- `src/transcript.ts` — 解析当前 transcript JSONL。自然周扫描参考其 JSONL 解析逻辑。
- `src/claude-config-dir.ts` — Claude config 目录定位（`~/.claude`）。session 历史在 `~/.claude/projects/<cwd-hash>/`。
- pi-statusline `DeepSeekProvider`（外部参考）：`GET {origin}/user/balance` Bearer key → `balance_infos[0].total_balance/currency`；`scanWeeklyTokens` 扫 session 目录本周（周一 UTC 起）。
- Claude Code session 历史：`~/.claude/projects/<cwd-with-dashes>/<session-uuid>.jsonl`，cwd 的 `/`→`-` 作为目录名。

### Institutional Learnings

- `docs/plans/` 历史 plan 均为 GLM usage 校准（EMA/cycle/7d）。deepseek 无需校准（balance 绝对值），不应套用 glm 的复杂状态机。

### External References

- deepseek balance API：pi-statusline 已验证 `GET https://api.deepseek.com/user/balance`，`Authorization: Bearer <key>`，响应 `balance_infos[0].{currency,total_balance}`。无需额外外部研究。

---

## Key Technical Decisions

- **策略模式 = 现有路由分支，不引入 formal interface**：claude-hud 已有 `getUsage` 的 `detectPlatform` 路由 + 每 provider 独立模块（`usage/claude/`、`usage/glm/`）。加 deepseek = 新增 `usage/deepseek/` 模块 + 路由分支。3 provider 的 if/else 是合理的策略模式，formal `UsageProvider` interface + registry 对 3 个 provider 是 over-engineering，且会破坏 GLM 的 deps 注入测试模式。（call-out 1 决策：最小扩展）
- **deepseek 自然周 token 扫 Claude Code session 历史**：扫 `~/.claude/projects/<当前项目 cwd-hash>/*.jsonl`，过滤本周（周一 00:00 UTC 起，按文件名日期），累计 assistant message 的 usage tokens。带 5min TTL 缓存（首次扫描后缓存，避免每 300ms 重扫）。（call-out 2 决策：session 历史扫描 + 缓存，而非仅当前 transcript——后者不满足"自然周全量"）
- **UsageData 扩展加可选字段，不新建联合类型**：加 `balance?: string`、`currency?: string`、`weeklyTokens?: number`、`sessionCostUsd?: number`。渲染层按 `platform === 'deepseek'` 判断显示。glm/anthropic 路径不填这些字段，零破坏。
- **deepseek API key 复用 `ANTHROPIC_API_KEY`**：Claude Code 用 deepseek 时设 `ANTHROPIC_BASE_URL=api.deepseek.com` + `ANTHROPIC_API_KEY=<deepseek-key>`。provider 从 `process.env.ANTHROPIC_API_KEY` 取 key，origin 从 `ANTHROPIC_BASE_URL` 取（复用 `getGlmBaseDomain` 的 URL 解析逻辑，或新建 `getBaseDomain`）。
- **deepseek 会话费用用 cost.ts 估算**：加 deepseek-chat / deepseek-reasoner 的 pricing 条目到 `ANTHROPIC_MODEL_PRICING`（或新建 deepseek pricing 表），复用现有估算逻辑。不引入 native cost（Claude Code stdin 不提供 deepseek 费用）。
- **颜色统一 65/85，正常态 dim**：`getContextColor` + `getQuotaColor` 改为 `<65% dim / 65-85 warning / >=85 error`。移除 context 的绿档、quota 的蓝/品红档（用户要求"默认不加额外颜色"）。
- **glm 简化：删 EMA，直接用 API unit:6 percentage**：参考 pi-statusline ZaiProvider——GLM API 的 unit:6 TOKENS_LIMIT 直接给 weekly percentage，无需 EMA 反推 limit。claude-hud 当前 `parseLimits` 只取单个 TOKENS_LIMIT（5h），需扩展为区分 unit:3（5h）/ unit:6（weekly）。有 unit:6 → 7d% = API weeklyPct；无 → 自然周 token（与 deepseek 共享 scanWeeklyTokens）。删除 `updateCalibration` + `compute7d`。

---

## Open Questions

### Resolved During Planning

- 策略模式范围：最小扩展（加 deepseek 模块 + 路由分支），保留现有 claude/glm。
- 自然周 token 来源：扫 session 历史 + 5min 缓存。
- UsageData 容纳方式：扩展加可选字段。
- deepseek API key：`ANTHROPIC_API_KEY`。
- 颜色阈值：65/85，正常态 dim。

### Deferred to Implementation

- deepseek 模型定价精确值（plan 给占位，实现时查 deepseek 官方定价）。
- 自然周扫描的 cwd-hash 计算细节（Claude Code 的 `/`→`-` 规则，可能有特殊字符处理）。
- deepseek cache 复用 glm cache 还是新建（实现时看 `usage/glm/cache.ts` 的 platform-keyed 设计是否方便加 'deepseek'）。

---

## High-Level Technical Design

> *方向性示意，供 review 验证形状，非实现规格。*

**provider 路由**：
```
getUsage(stdin, deps):
  platform = detectPlatform()          // anthropic | glm | deepseek
  if platform == 'anthropic': return getUsageFromStdin(stdin)
  if platform == 'glm':      return getGlmUsage(deps.glm)
  if platform == 'deepseek': return getDeepSeekUsage(deps.deepseek)  // 新增
```

**UsageData 扩展**（加可选字段，向后兼容）：
```
UsageData {
  // 现有（百分比导向，glm/anthropic）
  fiveHour, sevenDay, ...resetAt, windowType, platform, sevenDayTokens
  // 新增（余额导向，deepseek）
  balance?: string           // "50.00"
  currency?: string          // "CNY"
  weeklyTokens?: number      // 自然周累计
  sessionCostUsd?: number    // 当前会话估算费用
}
```

**颜色统一**（getContextColor + getQuotaColor 同一逻辑）：
```
< 65%  → dim       // 默认不加额外颜色
≥ 65%  → warning   // 黄
≥ 85%  → error     // 红
```

**deepseek 渲染**（usage line / session line 的 deepseek 分支）：
```
¥0.12/¥50.00 · 7d:1.2M
// sessionCost/balance · weeklyTokens（参考 pi-statusline DeepSeekProvider.formatForFooter）
```

---

## Implementation Units

### U1. detectPlatform + UsagePlatform 加 deepseek

**Goal:** `detectPlatform` 识别 deepseek 域名，`UsagePlatform` 类型加 `'deepseek'`。

**Requirements:** R1

**Dependencies:** None

**Files:**
- Modify: `src/glm-detect.ts`（`GLM_DOMAINS` 旁加 `DEEPSEEK_DOMAINS = ['api.deepseek.com']`；`detectPlatform` 加 deepseek 匹配分支，返回 `'deepseek'`）
- Modify: `src/types.ts`（`UsagePlatform = 'anthropic' | 'glm' | 'deepseek'`）
- Test: `tests/glm-detect.test.js`

**Approach:**
- `detectPlatform` 现有逻辑：先匹配 GLM 域名，否则 anthropic。改为：先 GLM，再 deepseek，否则 anthropic。
- 函数名 `glm-detect.ts` 保留（重命名是 tangential），但加 deepseek 域名列表。

**Test scenarios:**
- Happy path: `ANTHROPIC_BASE_URL=https://api.deepseek.com` → `'deepseek'`。
- Happy path: `ANTHROPIC_BASE_URL=https://api.deepseek.com/v1` → `'deepseek'`（带 path）。
- Edge case: 子域 `https://sub.api.deepseek.com` → `'deepseek'`（若需支持）或 anthropic（确认策略）。
- Regression: GLM 域名（api.z.ai 等）仍返回 `'glm'`；无 env 返回 `'anthropic'`。

**Verification:**
- `detectPlatform` 对 deepseek/GLM/anthropic 三类 URL 正确分流；现有 glm-detect 测试全绿。

---

### U2. UsageData 扩展可选字段

**Goal:** `UsageData` 加 `balance?/currency?/weeklyTokens?/sessionCostUsd?` 可选字段，向后兼容。

**Requirements:** R4

**Dependencies:** U1（UsagePlatform 加 deepseek 后，类型层一致）

**Files:**
- Modify: `src/types.ts`（`UsageData` 加 4 个可选字段 + JSDoc）
- Test: `tests/` 类型层（无独立测试文件，由 U3/U6 的使用验证）

**Approach:**
- 全部可选（`?`），glm/anthropic 的 `toUsageData` 不填这些字段，零破坏。
- 渲染层按 `platform === 'deepseek'` 判断是否用这些字段。

**Test scenarios:**
- Test expectation: none -- 纯类型扩展，无行为变化；由 U3/U6 集成测试覆盖。

**Verification:**
- `tsc` 编译通过；现有 usage 测试不因新字段失败。

---

### U3. deepseek provider 模块

**Goal:** 新建 `src/usage/deepseek/`：balance API fetch + 自然周 token 扫描 + 5min cache + `getDeepSeekUsage(deps)`。

**Requirements:** R2, R6, R7

**Dependencies:** U1, U2

**Files:**
- Create: `src/usage/deepseek/api.ts`（`fetchBalance(origin, apiKey)` → `{totalBalance, currency}`；`scanWeeklyTokens(projectDir)` 扫本周 session JSONL）
- Create: `src/usage/deepseek/cache.ts`（`readCache/writeCache`，5min TTL，platform='deepseek'；可复用 glm cache 的 platform-keyed 设计）
- Create: `src/usage/deepseek/index.ts`（`getDeepSeekUsage(deps)`：取 key+origin → cache 检查 → fetch balance + scan tokens → 写 cache → 返回 `UsageData` with deepseek 字段）
- Test: `tests/deepseek-usage.test.js`

**Approach:**
- deps 注入（参考 `GlmUsageDeps`）：`getApiKey`, `getBaseDomain`, `getProjectSessionsDir`, `readCache/writeCache`, `fetchBalance`, `scanWeeklyTokens`, `now`, `cacheTtlMs`。便于测试。
- `fetchBalance`：`GET {origin}/user/balance`，`Authorization: Bearer <key>`，5s timeout，解析 `balance_infos[0]`。失败返回 null。
- `scanWeeklyTokens`：周一 00:00 UTC 为周起始；扫 `<projectDir>/*.jsonl`，按文件名日期（YYYY-MM-DD）过滤本周，累计 assistant message `usage.totalTokens`。参考 pi-statusline `scanWeeklyTokens` + claude-hud `transcript.ts` 的 JSONL 解析。
- cache：5min TTL；cache hit 直接返回；miss 则 fetch + scan。

**Patterns to follow:**
- `src/usage/glm/index.ts` 的 deps 注入 + cache 模式（不复制 EMA/校准）。
- pi-statusline `DeepSeekProvider.fetchUsage` + `scanWeeklyTokens`。

**Test scenarios:**
- Happy path: balance API 返回 `{balance_infos:[{currency:'CNY',total_balance:'50.00'}]}` + session 扫描得 1.2M → `UsageData{platform:'deepseek', balance:'50.00', currency:'CNY', weeklyTokens:1200000, ...}`。
- Happy path: cache hit（5min 内）→ 直接返回缓存，不 fetch。
- Edge case: balance API 失败（非 200 / timeout）→ 返回 null（优雅降级）。
- Edge case: 无 `ANTHROPIC_API_KEY` → 返回 null。
- Edge case: session 目录不存在 / 无本周文件 → `weeklyTokens: 0`（balance 仍显示）。
- Edge case: cache 过期（>5min）→ 触发 refresh。
- Integration: `getDeepSeekUsage` 返回的 `UsageData` 含 deepseek 字段，glm 字段（fiveHour/sevenDay）为 null。

**Verification:**
- `tests/deepseek-usage.test.js` 覆盖 happy/edge/error；deps 注入可 mock fetch + 文件扫描。

---

### U4. getUsage 路由 + cost.ts deepseek 定价

**Goal:** `getUsage` 加 deepseek 路由分支；`cost.ts` 加 deepseek 模型定价估算会话费用。

**Requirements:** R1, R2（会话费用部分）

**Dependencies:** U1, U2, U3

**Files:**
- Modify: `src/usage/index.ts`（`getUsage` 加 `if platform === 'deepseek' return getDeepSeekUsage(deps.deepseek)`；`UsageStrategyDeps` 加 `deepseek?: Partial<DeepSeekUsageDeps>`）
- Modify: `src/cost.ts`（加 deepseek-chat / deepseek-reasoner pricing 条目；`sessionCostUsd` 估算）
- Test: `tests/`（getUsage 路由 + cost 估算）

**Approach:**
- `getUsage` 路由：anthropic / glm / deepseek 三分支。
- `cost.ts`：deepseek 模型定价（实现时填精确值，plan 占位 `deepseek-chat: {input: 0.27, output: 1.10}` per million CNY→USD 折算，或直接 CNY）。`SessionCostEstimate` 已有估算逻辑，加 deepseek pattern。
- deepseek 的 `sessionCostUsd` 在 `getDeepSeekUsage` 内调 cost 估算填充到 `UsageData.sessionCostUsd`。

**Test scenarios:**
- Happy path: `detectPlatform() === 'deepseek'` → `getUsage` 调 `getDeepSeekUsage`。
- Happy path: cost.ts 对 `deepseek-chat` 模型名估算出非零费用。
- Regression: anthropic/glm 路由不受影响（现有 usage 测试全绿）。

**Verification:**
- `getUsage` 三路由正确分流；deepseek 会话费用估算非零（有定价时）。

---

### U5. 渲染层 deepseek 显示分支

**Goal:** `usage.ts`（expanded）+ `session-line.ts`（compact）加 deepseek 显示分支：`¥<sessionCost>/¥<balance> · 7d:<weeklyTokens>`。

**Requirements:** R2

**Dependencies:** U2, U3, U4

**Files:**
- Modify: `src/render/lines/usage.ts`（`renderUsageLine` 加 `if platform === 'deepseek'` 分支，显示 balance + sessionCost + weeklyTokens）
- Modify: `src/render/session-line.ts`（compact usage 部分加 deepseek 分支）
- Test: `tests/render.test.js`

**Approach:**
- deepseek 分支：`¥{sessionCostUsd}/{currency}{balance} · 7d:{fmt(weeklyTokens)}`（参考 pi-statusline `DeepSeekProvider.formatForFooter`，用户已确认保持合并格式 `¥0.12/¥50.00 · 7d:1.2M`）。
- 复用现有 `formatTokens`（k/M 缩写）。
- 当 `sessionCostUsd` 为 0 时只显示 `¥{balance}`。
- currency 符号：CNY→¥，否则→$。

**Patterns to follow:**
- pi-statusline `DeepSeekProvider.formatForFooter`。
- 现有 `usage.ts` 的 glm 分支结构。

**Test scenarios:**
- Happy path: deepseek `UsageData`（balance/currency/weeklyTokens/sessionCostUsd）→ 渲染 `¥0.12/¥50.00 · 7d:1.2M`。
- Edge case: sessionCostUsd 为 0 → 只显示 `¥50.00 · 7d:1.2M`。
- Edge case: weeklyTokens 为 0 → 省略 `7d:` 段。
- Edge case: currency 非 CNY → `$50.00`。
- Regression: glm/anthropic 的 usage 渲染不受影响。

**Verification:**
- deepseek ctx 渲染含余额/费用/周token；现有 glm/anthropic usage 测试全绿。

---

### U6. 颜色统一 65/85

**Goal:** `getContextColor` + `getQuotaColor` 阈值统一为 `<65 dim / 65-85 warning / >=85 error`，正常态默认 dim（不加额外颜色）。

**Requirements:** R5

**Dependencies:** None（独立）

**Files:**
- Modify: `src/render/colors.ts`（`getContextColor`：70/85→65/85，绿档→dim；`getQuotaColor`：75/90→65/85，蓝/品红档→dim/warning）
- Test: `tests/render.test.js`、`tests/glm-usage.test.js`（颜色断言更新）

**Approach:**
- `getContextColor(percent, colors)`：`>=85 error / >=65 warning / else dim`。
- `getQuotaColor(percent, colors)`：同上（移除蓝/品红，统一 dim/warning/error）。
- 现有测试若断言绿/蓝/品红色码需更新为 dim/warning。

**Test scenarios:**
- Happy path: context 50% → dim；65% → warning；85% → error。
- Happy path: usage 50% → dim；65% → warning；85% → error。
- Edge case: 边界 64% → dim，65% → warning，84% → warning，85% → error。
- Regression: 现有 glm-usage 颜色断言更新后全绿。

**Verification:**
- context/usage 在 65/85 边界正确切换 dim/warning/error；现有测试更新后全绿。

---

### U7. 简化 glm 周额度（删 EMA，直用 API percentage）

**Goal:** 删除 glm 的 EMA 校准与 limit 反推，7d% 直接用 API unit:6 weekly percentage；无 unit:6 时自然周 token 扫描（参考 pi-statusline ZaiProvider）。

**Requirements:** R3

**Dependencies:** U3（scanWeeklyTokens util，glm 无 unit:6 时复用 deepseek 的自然周扫描；若抽为共享 util 则两者共用）

**Files:**
- Modify: `src/usage/glm/api.ts`（`parseLimits` 区分 unit:3（5h）/ unit:6（weekly），分别取 percentage + nextResetTime；`fetchFull`/`fetchQuota` 返回 weeklyPct + weeklyResetTime）
- Modify: `src/usage/glm/types.ts`（`FetchedData`/`QuotaData` 加 `weeklyPct`/`weeklyResetTime`）
- Modify: `src/usage/glm/index.ts`（删 `updateCalibration`/`compute7d`/`applyMonotonicGuard`；有 unit:6 → `sevenDay = weeklyPct` + 7d tokens；无 → `sevenDay = null` + `scanWeeklyTokens` 自然周 + `sevenDayWindowType = 'rolling'`）
- Delete/simplify: `src/usage/glm/calibration.ts`（删 `updateCalibration`；`inferSubscriptionTime`/`computeCycleStart` 按引用评估——无 unit:6 自然周不需要 cycle 计算，可能整文件删）
- Delete/simplify: `src/usage/glm/compute.ts`（删 `compute7d`；`applyMonotonicGuard` 按引用评估）
- Modify: `tests/glm-usage.test.js`（删 EMA/校准/monotonic 测试；加 weeklyPct 直用 + 自然周退化测试）

**Approach:**
- `parseLimits` 现状：`limits.find(l => l.type === 'TOKENS_LIMIT')` 取首个（5h）。改为 `limits.find(l => l.type === 'TOKENS_LIMIT' && l.unit === 3)`（5h）与 `l.unit === 6`（weekly）分别取。
- 有 unit:6 weeklyPct → `sevenDay = weeklyPct`，`sevenDayTokens = API tokens7d`（保留 model-usage fetch），`sevenDayWindowType = 'cycle'`，reset 时间用 API nextResetTime。
- 无 unit:6 → 自然周：`sevenDay = null`，`weeklyTokens = scanWeeklyTokens`，`sevenDayWindowType = 'rolling'`（自然周语义）。
- 删 `CalibrationState.calibratedLimit7d` 相关逻辑（readState/writeState 简化或删）。

**Execution note:** 这是破坏性重构（删 EMA）。先跑现有 `glm-usage.test.js` 做 characterization（记录当前 7d% 行为），再删 EMA，确保新逻辑（weeklyPct 直用）覆盖原场景。

**Patterns to follow:**
- pi-statusline `ZaiProvider`（`fetchQuota` 区分 unit:3/unit:6 + `isNaturalWeek` 退化）。

**Test scenarios:**
- Happy path: API 返回 unit:6 weeklyPct=76 → `sevenDay = 76`（直接，无 EMA 平滑）。
- Happy path: API 无 unit:6 → 自然周 scanWeeklyTokens，`sevenDay = null`，`weeklyTokens` 显示。
- Edge case: unit:6 weeklyPct 边界 0 / 100。
- Edge case: 5h（unit:3）行为不变（回归）。
- Deleted: EMA 校准 / monotonic guard / calibratedLimit 相关测试移除。

**Verification:**
- glm 7d% 直接来自 API unit:6（有周额度）或自然周 token（无）；无 EMA 计算；`glm-usage.test.js` 更新后全绿。

---

## System-Wide Impact

- **Interaction graph:** `getUsage`（index.ts）→ provider 模块（claude/glm/deepseek）→ `UsageData` → 渲染层（usage.ts/session-line.ts）。deepseek 新增一路，不影响现有两路。
- **Error propagation:** deepseek fetch/scan 失败返回 null（优雅降级），不抛错；statusline 在 deepseek 不可用时退化为无 usage 显示。
- **API surface parity:** compact 与 expanded 两种 layout 都需 deepseek 分支（U5 覆盖两者）。
- **Integration coverage:** deepseek 的 balance API + session 扫描 + cache 需集成测试（mock fetch + 临时 session 目录），单测无法证明完整链路。
- **Unchanged invariants:** glm 的 EMA 校准 / monotonic guard / cache 状态机不动；anthropic stdin 解析不动；`UsageData` 现有字段语义不变（新字段全可选）。

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| 自然周扫描每 300ms 调用慢 | 5min TTL cache（U3）；首次扫描后缓存，cache hit 直接返回 |
| deepseek API key 不可得（用户未设 ANTHROPIC_API_KEY） | 优雅降级返回 null（U3 R7） |
| cwd-hash 计算与 Claude Code 实际目录名不一致 | 实现时验证 `~/.claude/projects/` 实际目录名规则；Deferred |
| deepseek 模型定价不准（影响会话费用） | 占位值 + Deferred 实现时查官方定价；费用是估算，不阻塞核心 |
| 颜色改 dim 后 context/usage 正常态失去绿/蓝区分 | 用户明确要求"默认不加额外颜色"，接受；65% 起黄足以区分预警 |
| 现有 glm-usage/render 测试因颜色阈值失败 | U6 同步更新断言 |
| glm 简化删 EMA 后 `glm-usage.test.js` 大量 EMA/校准/monotonic 测试失效 | U7 先 characterization 记录行为，再删 EMA，重写为 weeklyPct 直用测试 |

---

## Sources & References

- **Origin / 参考实现:** pi-statusline `packages/extensions/pi-statusline/index.ts`（外部 repo，`DeepSeekProvider` + `scanWeeklyTokens` + `colorForPct` 65/85）
- Related code: `src/usage/index.ts`、`src/glm-detect.ts`、`src/usage/glm/index.ts`、`src/cost.ts`、`src/types.ts`、`src/render/colors.ts`、`src/render/lines/usage.ts`、`src/render/session-line.ts`
- Related tests: `tests/glm-detect.test.js`、`tests/glm-usage.test.js`、`tests/render.test.js`
