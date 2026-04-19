---
title: "feat: 增强 GLM usage 日志，记录 API 原始值和计算变量"
type: feat
status: active
date: 2026-04-19
---

# feat: 增强 GLM usage 日志

## Overview

在现有的 `appendUsageLog` 单行日志基础上，扩展为三种日志行类型，记录 API 原始返回值、7d 计算的中间变量、缓存命中状态，方便排查 7d 用量回退问题。

## Problem Frame

7d 百分比偶尔出现回退（如 60%→55%），需要从日志中确认：是 API 返回值变化、校准触发、还是单调递增保障失效。当前日志缺少原始 API 数据和计算中间变量，无法定位根因。

## Scope Boundaries

- 只修改日志输出内容，不改变任何计算逻辑
- 日志写入性能不应影响 statusline 的 ~300ms 刷新周期
- 不添加日志级别的控制（全部写入）

## Key Technical Decisions

- **三行日志结构**：cache=HIT 单行、cache=MISS 成功三行、cache=MISS 错误两行
- **缩写约定**：用简短字段名（5hPct、tokens5h 等），保持一行可读
- **缓存命中不每次记录**：每 300ms 触发一次，只有 miss（~5 分钟一次）才写完整日志；hit 只在每次首次命中时记录一行

## Implementation Units

- [ ] **Unit 1: 添加 cache=HIT 日志行**

**Goal:** 缓存命中时记录一行，显示缓存中的 5h/7d 值和 TTL 剩余时间

**Dependencies:** None

**Files:**
- Modify: `src/glm-usage.ts` — `getGlmUsage()` 函数 cache hit 返回路径（~L271）

**Approach:**
在 `if (cached && !cached.isError) { return cacheToUsageData(cached); }` 前添加一行 `appendUsageLog`，格式：
```
cache=HIT 5h=47% 7d=60%(512M) ttl=2m30s
```
TTL 计算：`(cached.ttlMs - (Date.now() - cached.timestamp))` 转为 `XmYs` 格式。

**Test scenarios:**
- Happy path: 缓存命中时日志包含 cache=HIT 和正确的 TTL

**Verification:**
- `npm run build` 成功
- 手动 `tail -f` 观察日志输出

---

- [ ] **Unit 2: 扩展 cache=MISS 成功日志为三行**

**Goal:** API 调用成功后，记录 API 原始值、计算中间变量、最终结果三行

**Dependencies:** None

**Files:**
- Modify: `src/glm-usage.ts` — 替换当前的 `appendUsageLog` 调用块（~L399-415）

**Approach:**
替换当前的单行日志为三行：

**行 1 — 来源标记：**
```
cache=MISS
```

**行 2 — API 原始值（从 `results` 对象）：**
```
api 5hPct=47 tokens5h=73.5M tokens7d=512M reset5h=04-19T17:02 resetTime=04-30T15:43
```
字段来源：
- `5hPct` ← `results.fiveHourPct`
- `tokens5h` ← `results.tokens5h`
- `tokens7d` ← `results.tokens7d`
- `reset5h` ← `results.tokensLimitResetTime`（格式化为 MM-DDTHH:MM）
- `resetTime` ← `results.timeLimitResetTime`（格式化为 MM-DDTHH:MM）

**行 3 — 计算过程：**
```
calc limit7d=855M@47% subMs=1744856592 cycle=04-13T15:43 7d=60%(512M) mono=- prev7d=60%(512M)
```
字段来源：
- `limit7d` ← `calibratedLimit7d`（/1e6 取 M），`@` 后是 `calibratedAtPct`
- `subMs` ← `effectiveSubscriptionTime`（Unix 秒，方便交叉验证）
- `cycle` ← `sevenDayStartAt`（格式化为 MM-DDTHH:MM）
- `7d` ← 最终 `sevenDay`% 和 `sevenDayTokens`（/1e6 取 M）
- `mono` ← 单调递增：`-` 表示未触发，`55%→60%` 表示从 preMono7d 提升到 sevenDay
- `prev7d` ← `calibration?.sevenDay`% 和 `calibration?.sevenDayTokens`（上一轮值，用于对比）

**Test scenarios:**
- Happy path: API 成功时日志包含三行（cache=MISS、api、calc）
- Monotonic 生效时 mono 字段显示 `旧%→新%`
- Monotonic 未生效时 mono 字段显示 `-`
- prev7d 显示上一轮缓存的值

**Verification:**
- `npm run build` 成功
- `npx vitest run tests/glm-usage.test.js` 全部通过
- 手动 `tail -f` 验证日志格式

---

- [ ] **Unit 3: 增强错误日志行**

**Goal:** 错误时也记录校准缓存状态，方便判断是否是校准丢失导致的问题

**Dependencies:** None

**Files:**
- Modify: `src/glm-usage.ts` — 两个 `appendUsageLog` 错误路径（auth ~L432, retryable ~L450）

**Approach:**
在错误日志中增加校准缓存状态：
```
error=auth limit7d=855M@47% subMs=1744856592
error=retryable limit7d=855M@47% subMs=1744856592
```
字段来源：`calibration?.calibratedLimit7d`、`calibration?.calibratedAtPct`、`calibration?.subscriptionTimeMs`

**Test scenarios:**
- Happy path: auth 错误日志包含缓存的 limit7d 值
- Happy path: retryable 错误日志包含缓存的 limit7d 值
- Edge case: 无校准缓存时显示 `limit7d=-`

**Verification:**
- `npm run build` 成功
- 现有测试不受影响

---

- [ ] **Unit 4: 更新文档**

**Goal:** 在 `docs/glm-usage-calculation.md` 中添加日志格式说明

**Dependencies:** Unit 2

**Files:**
- Modify: `docs/glm-usage-calculation.md`

**Approach:**
添加"日志格式"章节，说明三种日志行类型和各字段含义。包括日志文件路径、轮转策略。

**Test expectation:** none — 文档修改

**Verification:**
- 文档内容准确反映实际日志格式

## System-Wide Impact

- **日志文件增长**：cache miss ~5 分钟一次（三行），cache hit ~300ms 一次（一行但频率高）。建议 hit 行不在每次命中时都记录，只在 TTL 内首次命中时记录一行
- **无 API/接口变更**：纯日志输出，不影响缓存结构或计算逻辑
- **无错误传播变更**

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| cache=HIT 日志过于频繁（~300ms 一次） | 只在 TTL 窗口首次命中时记录，后续命中跳过 |
| 日志文件过大 | 已有 512KB 轮转机制，足够 |
