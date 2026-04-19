---
title: "feat: 5h/7d 分离 TTL + 里程碑触发全量刷新"
type: feat
status: active
date: 2026-04-19
---

# feat: 5h/7d 分离 TTL + 里程碑触发全量刷新

## Overview

将 5h 和 7d 的缓存 TTL 分离：5h 用 30 秒，7d 保持 5 分钟。当轻量刷新检测到 5h% 是 10% 的倍数时，自动触发全量刷新以确保校准数据准确。

## Problem Frame

当前 5h 和 7d 共用 5 分钟 TTL，5h 百分比最长延迟 5 分钟才更新。用户希望 5h 更及时（30 秒），但不能影响 7d 的校准逻辑（始终基于 10% 里程碑）。

## Key Technical Decisions

- **轻量刷新只调 quota API**（1 个请求），不调 model-usage
- **里程碑触发**：轻量刷新发现 `fiveHourPct % 10 === 0` 时，升级为全量刷新
- **字段分区**：轻量刷新只更新 5h 相关字段，不碰校准和 7d 字段

## Implementation Units

- [ ] **Unit 1: 添加 `fetchGlmQuotaOnly` 函数**

**Goal:** 新增只获取 quota 端点的轻量函数

**Files:**
- Modify: `src/glm-usage.ts`

**Approach:** 新增 `fetchGlmQuotaOnly(baseDomain, headers, appendLog)` 返回 `{ fiveHourPct, tokensLimitResetTime, timeLimitResetTime }`

---

- [ ] **Unit 2: 扩展缓存结构和 deps 接口**

**Goal:** 支持 5h 独立 TTL 和 `fiveHourFetchedAt` 时间戳

**Files:**
- Modify: `src/usage-cache.ts` — `CachedUsageData` 添加 `fiveHourFetchedAt?: number`
- Modify: `src/glm-usage.ts` — `GlmUsageDeps` 添加 `fiveHourTtlMs: number` 和 `fetchGlmQuotaOnly`

---

- [ ] **Unit 3: 实现两阶段刷新逻辑**

**Goal:** 在 `getGlmUsage()` 中实现：缓存命中时检查 5h TTL → 轻量刷新 or 全量刷新

**Files:**
- Modify: `src/glm-usage.ts` — `getGlmUsage()` 函数

**Approach:**
1. 缓存命中后，检查 `Date.now() - fiveHourFetchedAt > fiveHourTtlMs`
2. 5h 过期 → 调 `fetchGlmQuotaOnly`
3. 如果 `fiveHourPct % 10 === 0` → 升级为全量刷新（调 `fetchGlmApi`）
4. 否则 → 只更新 5h 字段，保留 7d 和校准数据

---

- [ ] **Unit 4: 更新测试**

**Goal:** 覆盖两阶段刷新逻辑和里程碑触发

**Files:**
- Modify: `tests/glm-usage.test.js`

**Test scenarios:**
- 轻量刷新：5h 过期、7d 未过期 → 只更新 5h 字段
- 里程碑触发：轻量刷新发现 5h=30% → 触发全量刷新
- 全量刷新：7d 过期 → 现有逻辑不变
- 缓存命中：都未过期 → 直接返回
