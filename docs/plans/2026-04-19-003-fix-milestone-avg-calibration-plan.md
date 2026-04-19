---
title: "fix: 里程碑多点采样平均校准 7d 百分比"
type: fix
status: active
date: 2026-04-19
---

# fix: 里程碑多点采样平均校准 7d 百分比

## Overview

修复 GLM 7d 百分比从 ~60% 直接跳到 100% 的问题。根因是 `calibratedLimit7d` 的校准公式 `tokens5h × 500 / fiveHourPct` 中，`tokens5h` 在里程碑采样时有系统性低位偏差（刚跨入 10% 档位时采样，tokens 对应 ~9.x% 的用量）。通过在每个里程碑收集多个 `tokens5h` 样本取平均值，消除采样噪声，使 `calibratedLimit7d` 更接近真实值。

## Problem Frame

GLM 的 7d 限额 = 5h 限额 × 5（官方比例），公式本身正确。但 `tokens5h`（model-usage API 查询的 5h 窗口 token 数）与 `fiveHourPct`（quota API 返回的百分比）之间存在采样时差：

- `fiveHourPct` 是实时值，跳变到 10% 时立即被采样
- `tokens5h` 是从 `resetTime - 5h` 到 `now` 的查询，可能滞后
- 结果：在 10% 里程碑采样时，`tokens5h` 对应的可能是 ~9% 的实际用量

**数据验证**：同一个 5h 窗口内推算的 `5h_limit` 从 78M（at 50%）到 88M（at 60%）不一致，证明采样有系统性低位偏差。百分比越高偏差越大 → `calibratedLimit7d` 偏小 → 7d% 被高估到 100%。

## Requirements Trace

- R1. 在每个 10% 里程碑收集多个 `tokens5h` 样本，取加权平均值校准 `calibratedLimit7d`
- R2. 样本数据持久化到缓存，跨 TTL 周期存活（与 `calibratedLimit7d` 一样 TTL 豁免）
- R3. 同一周期重置后清空样本（新周期不应使用旧周期数据）
- R4. 现有测试不回归，新增采样逻辑的单元测试

## Scope Boundaries

- **不改** ×5 比例（这是 GLM 官方比例）
- **不改** 5h 百分比的获取方式（继续用 quota API）
- **不改** 轻量刷新逻辑（只改 full refresh 的校准部分）
- **不改** `isLimitReached` 逻辑（已在上次修复中处理）

## Key Technical Decisions

- **采样存储**：在缓存中新增 `milestoneSamples: Record<string, number[]>` 字段，key 为 `"10"`, `"20"`, ... 字符串化的百分比值
- **采样时机**：每次 full refresh 在里程碑点（`fiveHourPct % 10 === 0`）时记录 `tokens5h`；非里程碑点的 full refresh 不记录样本但使用已有样本计算
- **校准公式**：`calibratedLimit7d = avgTokens5h × 500 / avgPct`，其中 avgTokens5h 和 avgPct 来自所有里程碑样本的加权平均
- **样本上限**：每个里程碑最多保留 10 个样本（FIFO），防止数组无限增长
- **周期清理**：当 `sevenDayStartAt` 变化时（新周期），清空所有样本

## Implementation Units

- [x] **Unit 1: 扩展缓存数据结构**

**Goal:** 在 `CachedUsageData` 中新增 `milestoneSamples` 字段，更新相关读写函数

**Requirements:** R2

**Dependencies:** None

**Files:**
- Modify: `src/usage-cache.ts`
- Modify: `src/types.ts`（如果需要导出类型）

**Approach:**
- 在 `CachedUsageData` 接口中新增 `milestoneSamples?: Record<string, number[]>`
- 更新 `readCalibrationFields()` 返回值包含 `milestoneSamples`
- 更新 `writeCache()` 类型签名接受 `milestoneSamples`
- `milestoneSamples` 与其他校准字段一样 TTL 豁免

**Test scenarios:**
- Happy path: `readCalibrationFields()` 返回包含 `milestoneSamples` 的数据
- Edge case: 旧缓存无 `milestoneSamples` 字段时不崩溃（backward compatible）
- Edge case: `milestoneSamples` 为空对象时正常处理

**Verification:** 现有 usage-cache 测试全部通过

---

- [x] **Unit 2: 实现里程碑采样与平均校准逻辑**

**Goal:** 在 full refresh 的校准流程中收集样本并使用平均值计算 `calibratedLimit7d`

**Requirements:** R1, R3, R4

**Dependencies:** Unit 1

**Files:**
- Modify: `src/glm-usage.ts`

**Approach:**

校准流程改造（`getGlmUsage` 中 full refresh 部分）：

1. 从 `calibration` 读取现有 `milestoneSamples` 和 `sevenDayStartAt`
2. 如果 `sevenDayStartAt` 变化（新周期），清空 `milestoneSamples`
3. 在里程碑点时（`fiveHourPct % 10 === 0` 且 `tokens5h > 0`）：
   - 将 `tokens5h` 追加到 `milestoneSamples[fiveHourPct]`
   - FIFO 截断到最多 10 个样本
4. 计算校准值：
   - 遍历 `milestoneSamples` 所有 key-value 对
   - 对每个里程碑的样本数组取平均值得到 `avgTokens5h_at_pct`
   - 使用所有里程碑的平均值计算 `calibratedLimit7d = Σ(avgTokens × 500 / pct) / count`
   - 如果无样本，fallback 到单点公式
5. 将 `milestoneSamples` 写入缓存

**Technical design:**

```
// 采样收集
if (isMilestone && canCalibrate) {
  const key = String(fiveHour);
  const samples = { ...(calibration?.milestoneSamples ?? {}) };
  if (!samples[key]) samples[key] = [];
  samples[key].push(results.tokens5h);
  if (samples[key].length > 10) samples[key] = samples[key].slice(-10);
  milestoneSamples = samples;
}

// 平均校准
const allKeys = Object.keys(milestoneSamples ?? {});
if (allKeys.length > 0) {
  let sum = 0, count = 0;
  for (const pctStr of allKeys) {
    const pct = Number(pctStr);
    const arr = milestoneSamples[pctStr];
    if (arr.length > 0 && pct > 0) {
      const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
      sum += (avg * 500) / pct;
      count++;
    }
  }
  if (count > 0) calibratedLimit7d = sum / count;
}
```

**Test scenarios:**
- Happy path: 单个里程碑多个样本 → 平均值校准
- Happy path: 多个里程碑各一个样本 → 多点平均
- Edge case: 无样本数据 → fallback 到单点公式
- Edge case: 新周期 → 清空旧样本
- Edge case: 样本数超过 10 → FIFO 截断
- Edge case: 非里程碑 full refresh → 不记录样本但使用已有样本

**Verification:** `npm run build` 通过，现有测试不回归

---

- [x] **Unit 3: 新增单元测试**

**Goal:** 为里程碑采样和平均校准逻辑添加完整的测试覆盖

**Requirements:** R4

**Dependencies:** Unit 2

**Files:**
- Modify: `tests/glm-usage.test.js`

**Approach:**
- 在现有 `createMockDeps` 中支持 `milestoneSamples`
- 新增测试用例覆盖 Unit 2 中列出的所有场景

**Test scenarios:**
- `collects samples at milestones and calibrates with average`: 10% 和 20% 各采样 2 次，校准值接近真实值
- `falls back to single-point when no milestone samples`: 无样本时使用单点公式
- `clears samples on new cycle`: `sevenDayStartAt` 变化后样本清空
- `truncates samples to max 10 per milestone`: 同一里程碑追加 12 个样本，只保留最后 10 个
- `uses existing samples during non-milestone full refresh`: 非里程碑 full refresh 仍使用已收集的样本计算
- `backward compatible with old cache without milestoneSamples`: 旧缓存无字段时正常工作

**Verification:** 所有测试通过，`npm test` 绿色

---

- [x] **Unit 4: 更新文档**

**Goal:** 同步 `docs/glm-usage-calculation.md` 中的校准逻辑描述

**Requirements:** R1

**Dependencies:** Unit 2

**Files:**
- Modify: `docs/glm-usage-calculation.md`

**Approach:**
- 更新"第三步：校准 7d 总预算"章节，说明多点平均校准
- 更新 `CachedUsageData` 结构表，新增 `milestoneSamples` 字段
- 更新防线描述

**Test expectation:** none — 文档更新

**Verification:** 文档内容与代码实现一致

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| 旧缓存无 `milestoneSamples` 字段 | `milestoneSamples ?? {}` 默认空对象，backward compatible |
| 样本数据跨周期残留 | `sevenDayStartAt` 变化时清空 |
| 平均值样本太少时不如单点 | 至少需要 1 个样本才使用平均公式，否则 fallback |
