---
title: "fix: 恢复 deepseek/glm provider 在上游 release-0.2.0 合并后的破坏"
type: fix
status: active
created: 2026-06-16
branch: feat/deepseek-provider
---

# fix: 恢复 deepseek/glm provider 在上游 release-0.2.0 合并后的破坏

## 问题框架

分支 `feat/deepseek-provider`（fork `fyeeme/claude-hud`）合并上游 `jarrodwatts/claude-hud` 的
release-0.2.0（PR #616）后，deepseek/glm provider patch 受到**双层破坏性影响**：

1. **类型/配置层**：合并冲突解决时 `src/types.ts` 被上游版本整体覆盖，丢失 patch 对类型系统的全部
   扩展（`UsagePlatform`/`UsageWindowType`/`fiveHourStartAt`/`platform`/`sevenDayTokens`/`balance`/
   `currency`/`weeklyTokens`/`sessionCostUsd`）；`src/config.ts` 丢失 `display.separator` 与 `usage`
   子配置。→ 导致 14 个 TypeScript 编译错误，`npm run build` 失败，测试无法运行。

2. **接线层（隐藏致命）**：上游 `src/index.ts` 入口只调用 stdin-only 的 `getUsageFromStdin`
   （来自 `src/stdin.ts`），patch 的平台路由器 `src/usage/index.ts`（claude/glm/deepseek）从未被
   调用。即使修好类型，deepseek/glm 用量也永远不会执行。

**对照实验证据**：合并前 HEAD (`72c33ff`) 构建成功、全量测试 536/534 通过、provider 专属测试
52/52 全绿；合并后构建失败、测试无法运行。破坏 100% 来自这次合并。

## 范围

**目标**：在不丢失上游 release-0.2.0 中性改进的前提下，完整恢复 deepseek/glm provider patch 的
端到端用量显示，并移植上游新增的 `usageValue`（百分比/剩余模式）与 `usageCompact`（紧凑显示）
特性到 patch 的渲染行。

**不修复**：上游对其他渲染行（project/environment/session-time 等）的中性重构、上游新增的
`balanceLabel` 字段在 anthropic 外部快照路径下的逻辑（与 provider 路径并行保留，不冲突）。

### Deferred to Follow-Up Work

- `src/stdin.ts` 的 `getUsageFromStdin`（上游新增，与 `src/usage/claude/index.ts` 的同名函数功能
  重叠）：恢复路由器接线后，若它对入口路径成为孤儿，单独清理并确认无测试依赖。
- 若上游 `src/index.ts` 还引入了 patch 不需要的其它上游特性被接线逻辑影响，逐处核对。

## 关键技术决策

- **以 patch 的 provider 数据流为骨架**：恢复 `getUsage` 路由器接线 + 结构化 `UsageData`（带
  platform/balance/weeklyTokens/windowType 等），这是 patch 的核心价值。
- **渲染策略 = 方案 2（恢复 + 移植）**：以 HEAD 版 `render/lines/usage.ts`（消费结构化字段、含
  deepseek 分支与 GLM 窗口类型）为基础，把上游新增的 `usageValueMode`/`elapsed` 时间格式/紧凑
  模式移植进来，使两种显示模式都兼容 provider。
- **类型扩展采用并集而非替换**：在上游 `UsageData` 基础上 ADD 回 patch 字段，同时保留上游新增的
  `balanceLabel`/`balance_label`，二者并行不冲突。
- **采用上游 `shouldHideUsage` 作为隐藏守卫**：经验证它仅对 Bedrock 返回 true，deepseek/glm（自定义
  `ANTHROPIC_BASE_URL`）返回 false，不会误伤 provider 渲染。

---

## 实施单元

### U1. 恢复 types.ts 的类型扩展

**Goal**: 在上游覆盖后的 `types.ts` 上恢复 patch 对 usage 类型系统的全部扩展，并保留上游新增字段。

**Dependencies**: 无（基础单元，解锁 U2/U3/U4 的编译）。

**Files**:
- 修改 `src/types.ts`

**Approach**:
- 恢复类型导出：`UsageWindowType`（'fixed'|'rolling'|'cycle'）、`UsagePlatform`
  （'anthropic'|'glm'|'deepseek'）。
- 在 `UsageData` 上 ADD 回：`fiveHourStartAt`、`sevenDayStartAt`、`platform?`、
  `fiveHourWindowType?`、`sevenDayWindowType?`、`sevenDayTokens?`、`fiveHourTokens?`、`balance?`、
  `currency?`、`weeklyTokens?`、`sessionCostUsd?`（参照 HEAD 版定义与注释）。
- 保留上游已有的 `fiveHourResetAt`、`sevenDayResetAt`、`balanceLabel?`（不删除）。
- 恢复 GLM 感知的 `isLimitReached`（platform==='glm' 时仅 5h 100% 触发）。

**Test scenarios**:
- 编译通过（`src/usage/glm/types.ts`、`src/usage/glm/cache.ts`、`src/usage/glm/index.ts`、
  `src/glm-detect.ts`、`src/external-usage.ts`、`src/stdin.ts` 中对上述类型的引用全部解析）。
- 行为：`isLimitReached` 对 glm platform 仅在 fiveHour===100 时为 true；对其它 platform 5h 或 7d
  ===100 时为 true。

**Verification**: `npm run build` 不再报 `UsagePlatform`/`UsageWindowType`/`fiveHourStartAt`/
`platform` 相关的 12 个 TS2561/TS2305 错误。

### U2. 恢复 config.ts 的配置扩展

**Goal**: 恢复 patch 的 `display.separator` 与 `usage` 子配置，同时保留上游新增的 `usageValue`。

**Dependencies**: U1（`UsageValueMode` 等类型已在上游 config 中存在，U1 完成后编译环境稳定）。

**Files**:
- 修改 `src/config.ts`

**Approach**:
- 在 `display` 类型与 `DEFAULT_CONFIG.display` 上 ADD 回 `separator`（默认 `'｜'`）。
- 恢复顶层 `usage` 子配置（`fiveHourRefreshSec`、`sevenDayRefreshSec`，默认 30/180）及对应
  `DEFAULT_CONFIG.usage`、migrate 逻辑（参照 HEAD 版第 122-191、540-551 行）。
- 保留上游新增的 `usageValue: UsageValueMode`（默认 'percent'）与 `validateUsageValue`。

**Test scenarios**:
- 编译通过（`src/usage/glm/index.ts` 引用 `DEFAULT_CONFIG.usage.*RefreshSec`、
  `src/render/lines/project.ts` 与 `environment.ts` 引用 `display.separator` 全部解析）。
- 行为：默认 config 含 `display.separator==='｜'` 与 `usage.fiveHourRefreshSec===30`；migrate 对
  旧配置正确回填默认值。

**Verification**: `npm run build` 不再报 `separator`/`usage` 相关的 TS2339 错误；`tests/config.test.js`
通过。

### U3. 在 index.ts 重新接入 provider 路由器

**Goal**: 恢复 HEAD 版入口接线，使 `getUsage` 路由器（claude/glm/deepseek）被执行——这是 patch
能实际运行的接线修复。

**Dependencies**: U1、U2（路由器依赖的类型与配置就绪）。

**Files**:
- 修改 `src/index.ts`

**Approach**:
- 将入口的 usage 获取从「调用 `src/stdin.ts` 的 `getUsageFromStdin`」改回「调用
  `src/usage/index.ts` 的 `getUsage` 路由器」（参照 HEAD 版第 12-13、24、43、90-94 行的 deps 与
  调用结构）。
- 保留上游入口的其它结构（stdin 读取、external-snapshot fallback、render 调度、deps 注入风格），
  仅替换 usage 获取这一段。
- `getUsage` 为 async，确保入口处正确 await（HEAD 已是 async 调用，对齐之）。
- `src/stdin.ts` 的 `getUsageFromStdin` 若因接线变更对入口路径成为孤儿：保留其定义与导出（仍有
  测试/外部消费），仅在 index.ts 不再 import 它。孤儿清理移入 Deferred。

**Test scenarios**:
- 行为：anthropic 平台（无 `ANTHROPIC_BASE_URL`）→ `getUsage` 内部走 claude 分支，等价于
  stdin rate_limits 解析。
- 行为：设置 GLM/DeepSeek 的 `ANTHROPIC_BASE_URL` → `getUsage` 路由到对应 provider 并返回结构化
  `UsageData`（platform/balance/weeklyTokens 等）。
- 集成：fallback 链——provider 返回 null 时回退到 external snapshot。

**Verification**: 手动/集成测试覆盖 provider 路由；`tests/integration.test.js`、
`tests/index.test.js` 通过。

### U4. 移植 usageValue/elapsed/compact 到 patch 的渲染行

**Goal**: 以 HEAD 版 `render/lines/usage.ts` 为基础，把上游新增的显示特性移植进来，使两种显示模式
都兼容 provider（方案 2）。

**Dependencies**: U1（`UsageWindowType`、provider 字段）、U2（`usageValue`、`separator`）。

**Files**:
- 修改 `src/render/lines/usage.ts`

**Approach**（以 HEAD 版为基底合并上游特性）:
- 保留 HEAD 版的 provider 能力：`platform==='deepseek'` → `renderDeepSeekUsage`（balance/
  weeklyTokens/sessionCostUsd）、`formatUsageWindowPart` 的 `windowType`（fixed/rolling/cycle）与
  `tokenCount`（GLM 「7d:138M, 5d 3h」）、`separator`（'｜'）、`isLimitReached` GLM 逻辑。
- 移植上游 `usageValueMode`：给 `formatUsagePercent` 加 `mode` 参数（'remaining' 时显示 100-percent），
  并在 `formatUsageWindowPart`/`formatCompactWindowPart` 及所有调用点透传 `display.usageValue`。
- 移植上游 `formatWindowTime`/`formatElapsedWindow`（elapsed / elapsedAndAbsolute 时间格式）：给
  `formatUsageWindowPart` 的 reset 计算接入 windowMs + elapsed 分支（fixed 窗口走 reset 文案，
  rolling/cycle 窗口的 suffix 逻辑保留 HEAD 版）。
- 把隐藏守卫从 `isBedrockModelId` 换成上游 `shouldHideUsage`（仅 Bedrock 隐藏，不误伤 provider）。
- 兼容 `balanceLabel`：对 anthropic 外部快照路径，保留 `appendBalance`-style 追加（与 provider 结构化
  balance 并行，互不干扰）。

**Test scenarios**:
- Happy path：deepseek platform → 渲染 `$cost/$balance | 7d:weeklyTokens`（或 CNY `¥` 换算）。
- Happy path：glm platform + cycle 窗口 → 渲染含 tokenCount 与剩余时间的 quotaBar。
- Happy path：anthropic platform → 渲染 5h/7d 百分比 + reset 时间（与上游一致）。
- `usageValue='remaining'` → 所有窗口显示剩余百分比（含 provider 的 anthropic 退化路径）。
- `usageCompact=true` → 紧凑 `5h: 45% (3h)`｜`7d: 30% (5d)` 格式。
- `timeFormat='elapsed'` → 显示 elapsed 百分比。
- Edge：`sevenDay===null` 且有 `sevenDayTokens` → 显示 `7d:<tokens>`。
- Edge：Bedrock（shouldHideUsage=true）→ 返回 null；deepseek/glm → 正常渲染。

**Verification**: `tests/render.test.js`、`tests/glm-usage.test.js`、`tests/deepseek-usage.test.js`
通过；`npm run build` 渲染行零错误。

### U5. 验证：构建 + 全量测试

**Goal**: 证明破坏已修复——构建零错误、provider 专属测试与上游测试均绿。

**Dependencies**: U1、U2、U3、U4。

**Files**: 无（验证单元）。

**Approach**:
- `npm run build` → 0 TS 错误（对齐合并前基线）。
- `npm test` → 全量通过；重点核对 provider 专属测试恢复全绿：`tests/deepseek-usage.test.js`、
  `tests/glm-detect.test.js`、`tests/glm-usage.test.js`、`tests/external-usage.test.js`（合并前 52
  个全过）。
- 核对上游新增测试不受影响：`tests/session-time.test.js`、`tests/env-disable.test.js` 等。

**Verification**: 构建退出码 0；`node --test` 的 pass 数 ≥ 合并前基线（534），fail 数 ≤ 合并前
（仅遗留的 `usage-cache` February 日期边界无关失败，若有）。

---

## 系统级影响

- **最终用户**：使用 GLM / DeepSeek 自定义 endpoint 的用户恢复用量显示；Anthropic 用户获得上游
  新增的 usageValue/usageCompact/elapsed 显示能力。
- **开发者**：分支可正常构建与测试，解除合并阻塞。
- 不涉及持久化数据迁移、外部 API 契约变更或破坏性配置变更（`separator`/`usage` 子配置为 ADD 回
  patch 原有项，对仅用上游的用户透明）。

## 风险与缓解

- **风险**：移植 usageValue/elapsed 到 provider 渲染路径时，剩余模式或 elapsed 格式与 provider 的
  窗口类型语义冲突（如 GLM cycle 窗口无固定 reset 起点）。
  **缓解**：U4 测试场景显式覆盖 provider × usageValue × timeFormat 组合；对 rolling/cycle 窗口，
  elapsed 以 API 提供的 reset 时间为锚，缺值时退化为不显示。
- **风险**：`getUsageFromStdin` 双实现（`src/stdin.ts` vs `src/usage/claude/index.ts`）造成混淆。
  **缓解**：U3 明确入口只走路由器；双实现的清理记入 Deferred，不在本次强行删除以防误伤。
