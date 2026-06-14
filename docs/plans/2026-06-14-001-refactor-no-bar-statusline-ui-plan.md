---
title: 去 bar 化 statusline UI 重写
type: refactor
status: active
date: 2026-06-14
origin: docs/ideation/ui-rewrite-no-bar.md
---

# 去 bar 化 statusline UI 重写

## Summary

把 claude-hud 的 statusline 从「进度条 + 半角 ` | `」改为「数字 + 文字 + 全角 `｜` 分隔」的紧凑格式。compact 模式重构为身份段 + 用量段两段分层；expanded 模式保持多行卡片式但移除所有 `coloredBar`/`quotaBar` 调用。context/usage 的预警语义从进度条填充长度迁移到现有的数字颜色阶梯（`getContextColor`/`getQuotaColor`）。进度条开关保留（默认关）以兼容老用户；GLM 7d cycle 的 token 数与速率显示完整保留。

---

## Problem Frame

当前 statusline 用 `█`/`░` 字符渲染 context bar 与 usage bar（`identity.ts`、`usage.ts`、`session-line.ts`）。在 statusline 每 ~300ms 刷新的场景下，bar 的微小填充变化是不可感知的噪音，而 `45%` 这样的数字已精确传达同等信息——bar 占用 10+ 列宽度却无额外价值。模块间用半角 `' | '` 分隔，视觉上模块边界不够清晰。参考 ccstatusline 风格的纯数字格式（见 origin 文档）证明 statusline 可以更紧凑、更可读。

---

## Requirements

- R1. context 与 usage 的进度条默认不渲染；预警语义（接近上限）通过数字颜色阶梯保留（绿/黄/红）。
- R2. 所有模块间分隔符默认改为全角 `｜`（U+FF5C），并可通过配置回退半角。
- R3. compact 模式输出为两段分层：身份段（model + project + git + config counts）+ 用量段（ctx + usage + tokens + duration + speed），段间换行，段内 `｜` 分隔。
- R4. expanded 模式保持多行卡片式，每行内用 `｜` 分隔子模块；session token 明细行完整保留 in/out/cache/hit breakdown。
- R5. GLM 7d cycle 窗口的 token 累计数（如 `76M`）与剩余时间（如 `5d 3h`）显示不变；5h cycle 剩余时间显示不变。不新增 per-M 速率字段（参考格式的 `2.9%/M` 来自外部工具，claude-hud 现状不产生）。
- R6. 向后兼容：`showContextBar`/`usageBarEnabled` 开关保留，置 `true` 时回退旧行为；已显式配置这些字段的用户不受默认值变更影响（`migrateConfig` 已保留显式值）。
- R7. 宽度自适应：复用现有 `wrapLineToWidth`/`visualLength`，全角 `｜` 的 width=2 被 `graphemeWidth`（`isWideCodePoint` 覆盖 `0xFF00–0xFF60`）正确计入，窄终端自动换行。

---

## Scope Boundaries

- 不改数据采集层：`stdin.ts`/`transcript.ts` 的解析逻辑、token 计数、usage 抓取保持不变。
- 不新增 statusline 模块（tools/agents/todos/environment/memory/prompt-cache/cost 行的渲染逻辑不动，仅其内部 join 分隔符跟随 U1 统一）。
- 不引入阈值符号方案（`·/▲/■`）——ideation 已确认仅数字颜色预警。
- 不改 `coloredBar`/`quotaBar` 函数定义本身（保留供 opt-in 回退）；只改调用点的默认行为。
- 不调整 `showDuration`/`showSpeed`/`showSessionTokens` 的默认值（本就为 `false`）；这些字段开启时按新格式渲染。

### Deferred to Follow-Up Work

- 分隔符字符的可配置化（`display.separator`）若后续需要中日韩字体对齐微调，可在 follow-up 增加 `separatorWidth` 补偿。本期 `graphemeWidth` 已正确处理 width=2，不额外补偿。

---

## Context & Research

### Relevant Code and Patterns

- `src/render/colors.ts` — `coloredBar`/`quotaBar`（bar 渲染）、`getContextColor`（70/85 阈值）、`getQuotaColor`（75/90 阈值）。去 bar 后颜色函数直接套用到数字。
- `src/render/lines/identity.ts` — expanded context 行，`coloredBar` 调用在 line 38；`formatContextValue` 支持 `percent`/`tokens`/`remaining`/`both`，`both` 即 `45% (90k/200k)`。
- `src/render/lines/usage.ts` — expanded usage 行，`quotaBar` 调用在 `formatUsageWindowPart`；GLM rolling/cycle 窗口逻辑（`windowType`/`tokenCount`）在 line 197+。
- `src/render/session-line.ts` — compact 单行渲染，`parts.join(' | ')` 在 line 303；usage 分支（line 161+）与 token 段（line 253+）内嵌。
- `src/render/lines/session-tokens.ts` — expanded token 明细行，`label(\`Tokens ...\`)` 在 line 54。
- `src/render/index.ts` — `splitLineBySeparators`（line 195，硬编码 `' | '`）、expanded merge join（line 431）、`wrapLineToWidth`/`visualLength`/`graphemeWidth`（全角宽度处理）。
- `src/render/lines/project.ts` — expanded project 行，`parts.join(' | ')` 在 line 124。
- `src/config.ts` — `DEFAULT_CONFIG.display`（line 149+）：`showContextBar:true`、`usageBarEnabled:true`、`contextValue:'percent'`；`migrateConfig`（line 445+）保留用户显式值。
- `tests/render.test.js` — `node:test` + `node:assert/strict`，`captureRenderLines` 捕获 `stripAnsi` 后断言；`baseContext()` 提供完整 fixture。
- `tests/render-width.test.js` — 宽度/换行测试（`withColumns` helper）。

### Institutional Learnings

- 仓库无 `docs/solutions/`。`docs/plans/` 历史计划均为 GLM usage 校准相关（7d 计算、fixed cycle、5h split），与本次 UI 重写无直接重叠，但印证 GLM 双窗口逻辑是该 fork 的重点保护对象。

### External References

- 无。statusline 格式是项目特定决策，无外部 best-practice 适用。

---

## Key Technical Decisions

- **分隔符可配置、默认 `｜`**：新增 `display.separator`（默认 `'｜'`），所有模块级 join 与 `splitLineBySeparators` 统一读取。保留回退半角能力。理由：用户明确要求 `｜`，但可配置避免硬编码；`splitLineBySeparators` 必须同步否则 wrap 断行失效。
- **预警语义迁移到数字颜色**：去 bar 后 `getContextColor`/`getQuotaColor` 直接包裹数字（如 `${getContextColor(percent)}${contextValue}${RESET}`），阈值不变。理由：颜色阶梯已存在，零语义损失。
- **contextValue 默认改 `'both'`**：新默认显示 `45% (90k/200k)`，贴近参考格式，比纯 `45%` 信息量更高。理由：用户接受「同步调整默认」。
- **compact 两段分层 = 段间换行**：身份段与用量段各自成行（宽终端也不合并），用 `｜` 分隔段内模块。理由：方案 B 原样，用户已确认；改变 compact 历史单行契约但分层可读性收益更大。
- **bar 开关保留、默认关**：`showContextBar`/`usageBarEnabled` 默认 `false`，置 `true` 回退旧 bar 渲染。理由：零成本兼容老用户与回退路径。
- **token breakdown 子分隔用 `·`**：session token 明细的 in/out/cache/hit 之间用中点 `·`（如 `in 29k · out 99 · cache 128 · 0.4%`），与模块级 `｜` 区分层级。理由：避免两种分隔符语义混淆。

---

## Open Questions

### Resolved During Planning

- compact 形态：两段分层（用户确认，方案 B 原样）。
- 默认配置：同步调整（用户确认，fork 场景）。
- 分隔符字符：全角 `｜`（用户原话「使用｜隔离」）。
- 预警补偿：仅数字颜色（ideation 确认）。
- 5h/7d 标签：保留标签（与参考格式 `7d:76M` 一致，可读性优于纯位置消歧）。
- 85% context breakdown 分隔符：迁移到 `·`（与 token 明细层级一致），U2 实现时改 `identity.ts` 现有逗号为 `·`。
- limit-reached（5h=100）：本期沿用现有 `isLimitReached` 整段替换（用量段整体变 `⚠ Limit`），不保留 7d 数据；保留 7d 留 follow-up。
- 40 列窄终端：本期接受多行换行（不做字段 drop），明确为决策非 deferred；字段优先级 drop 留 follow-up。
- compact 身份段字段：以 U5 Goal 为权威（含 session name/CC version，默认关闭时不显示）；R3 描述同步补齐。
- token 命中率标签：i18n 驱动（`t('format.cacheHit')`），compact 纯数字 `0.4%`，expanded 带 i18n 标签（如中文 `命中 0.4%`）。
- separator 字段限定单 grapheme（运行时校验，多 grapheme 回退默认 `｜`），避免多字符 split 算法复杂度。
- context_window.size=0 或 current_usage 缺失：渲染 `ctx --`（沿用 usage 的 `--` 缺省符号），不显示误导的 `ctx 0%` 绿色。
- 上游同步：全角 `｜` 默认作为 fork 专用 patch，上游 merge 时人工 resolve separator 默认值与 join 点（已知 trade-off，记入 Risks）。

### Deferred to Implementation

- `display.separator` 的具体 config schema 形态（字符串字段 vs 枚举 `'fullwidth'|'halfwidth'`）：实现时按 `config.ts` 现有字段风格（多为扁平布尔/字符串）选择最简形式，倾向直接字符串字段。
- compact 两段在极窄终端（<40c）是否进一步折叠用量段：依赖实际 `wrapLineToWidth` 行为验证，可能需要补充字段优先级 drop 逻辑。

---

## High-Level Technical Design

> *方向性示意，供 review 验证呈现形状，非实现规格。*

**呈现矩阵**（默认配置下；格式对齐 claude-hud 代码现状，非外部参考工具）：

| 模式 | 行 | 内容 |
|---|---|---|
| compact | 1（身份） | `[GLM-4.6] ｜ claude-hud git:(feat/gml-0.13*)` |
| compact | 2（用量） | `ctx 45% (90k/200k) ｜ 5h: 9% (3h39m) ｜ 7d: 76M (5d 3h)` |
| expanded | 1（身份） | `[GLM-4.6] claude-hud git:(feat/gml-0.13*)` |
| expanded | 2（用量） | `Context 45% (90k/200k) ｜ 5h: 9% (3h39m) ｜ Weekly: 76M (5d 3h)` |
| expanded | 3（明细） | `Tokens 29k (in 29k · out 99 · cache 128 · 命中 0.4%)` |
| compact (limit) | 2 | `⚠ Limit (3h39m)` — 沿用现有 `isLimitReached` 整段替换（见 Open Questions） |

脚注：
- `duration`/`speed`（`showDuration`/`showSpeed`）默认关；开启时并入用量段末尾，如 `｜ out: 6.6 tok/s`。
- compact 用 `7d:` 短码，expanded 用 i18n `Weekly:`（现状标签，本期不统一）。
- 7d 段为 `<token累计> (<剩余时间>)`，对应代码 `(76M, 5d 3h)`；**无 per-M 速率字段**（参考格式的 `2.9%/M` 来自外部工具，claude-hud 现状不产生，本期不新增）。
- context ≥85% 的 token breakdown 也用 `·` 子分隔（如 `(in 99k · cache 88k)`），与明细层级一致。

**分隔符层级**：模块级 `｜`（来自 `display.separator`）> 明细级 `·`（token breakdown、85% breakdown）> 括号 `()`（辅助标注，如剩余时间、token 上限）。

---

## Implementation Units

### U1. 分隔符统一 + 配置默认值

**Goal:** 引入可配置分隔符（默认 `｜`），统一所有模块级 join 与 `splitLineBySeparators`；同步调整 `DEFAULT_CONFIG` 的 bar/contextValue 默认值。

**Requirements:** R1, R2, R6, R7

**Dependencies:** None（基础单元，U2–U5 依赖）

**Files:**
- Modify: `src/config.ts`（`DisplayConfig` 加 `separator: string`；`DEFAULT_CONFIG.display` 设 `separator:'｜'`、`showContextBar:false`、`usageBarEnabled:false`、`contextValue:'both'`；`migrateConfig` 加 `separator` 字段迁移）
- Modify: `src/render/index.ts`（`splitLineBySeparators` 从 config 读 separator；`splitWrapParts` 的 fallback `?? ' | '`（line 226）一并改读 separator；expanded merge join 用 separator）
- Modify: `src/render/lines/project.ts`、`src/render/session-line.ts`、`src/render/lines/usage.ts`、`src/render/lines/environment.ts`、`src/render/tools-line.ts` 内所有 `parts.join(' | ')` 与模板字符串 `| ` 改读 separator
- Test: `tests/render.test.js`、`tests/render-width.test.js`

**Approach:**
- 在渲染入口（`render` 或各 line 函数）从 `ctx.config?.display?.separator` 解析分隔符，默认 `｜`；提供一个 `resolveSeparator(config)` helper 集中取值。
- `splitLineBySeparators` 改为接收 separator 参数，识别对应字符断行。
- `DEFAULT_CONFIG` 默认值变更只影响未显式配置该字段的用户（`migrateConfig` 已保留显式值）。

**Patterns to follow:**
- `config.ts` 现有扁平字段 + `migrateConfig` 的 `typeof x === 'string' ? x : DEFAULT` 迁移模式。

**Test scenarios:**
- Happy path: 默认配置下 compact/expanded 输出包含 `｜`，不含 ` | `。
- Happy path: `display.separator: ' | '` 时输出回退半角。
- Edge case: separator 含特殊字符时不破坏 `splitLineBySeparators` 断行。
- Integration: 全角 `｜` 经 `visualLength` 计为 width=2，`wrapLineToWidth` 在窄终端正确换行（复用 `withColumns` helper）。
- Integration: `migrateConfig` 对老配置（无 separator 字段）填充默认 `｜`，对显式设 `separator` 的配置保留用户值。

**Verification:**
- 现有 `tests/render.test.js`、`render-width.test.js` 全绿（更新断言后）；新 separator 场景覆盖。

---

### U2. expanded context 行去 bar

**Goal:** `renderIdentityLine` 默认不渲染 `coloredBar`，输出 `Context <数字(颜色)> (<tokens>)`；`showContextBar:true` 时回退。

**Requirements:** R1, R4, R6

**Dependencies:** U1

**Files:**
- Modify: `src/render/lines/identity.ts`
- Test: `tests/render.test.js`

**Approach:**
- `showContextBar !== false` 分支保留 bar 逻辑（回退路径）；默认分支（`false`）只输出 `progressLabel + contextValueDisplay`。
- `contextValueDisplay` 已用 `getContextColor` 着色，去 bar 后颜色直接作用于数字，预警语义保留。
- `contextValue` 默认 `'both'`（U1 已改）→ `45% (90k/200k)`。
- `percent >= 85` 的 token breakdown 逻辑保留。

**Patterns to follow:**
- 现有 `getContextColor` + `RESET` 包裹数字的写法（`identity.ts` line 34）。

**Test scenarios:**
- Happy path: 默认配置输出 `Context 45% (90k/200k)`，无 `█`/`░` 字符。
- Happy path: `showContextBar:true` 时输出含 bar（回退路径）。
- Edge case: context 86% 时数字红色 + 附带 token breakdown 括号。
- Edge case: `contextValue:'percent'` 时输出 `Context 86%`（无 token 数）。
- Edge case: `context_window_size` 缺失时 `'both'` 退化为 `45%`（不输出 `45% (/0)`）。

**Verification:**
- `renderIdentityLine` 默认输出无 bar 字符；颜色阶梯在 70/85 边界正确切换。

---

### U3. expanded usage 行去 bar

**Goal:** `renderUsageLine` 默认不渲染 `quotaBar`，输出 `5h <%(颜色)> (<reset>) ｜ 7d <tokens> <rate>`；GLM cycle 逻辑完整保留；`usageBarEnabled:true` 回退。

**Requirements:** R1, R5, R6

**Dependencies:** U1

**Files:**
- Modify: `src/render/lines/usage.ts`
- Test: `tests/render.test.js`、`tests/glm-usage.test.js`

**Approach:**
- `formatUsageWindowPart` 的 `usageBarEnabled` 分支保留 bar（回退）；默认分支（`false`）输出 `${styledLabel} ${usageDisplay}${suffix}`。
- GLM cycle 的 `suffix` 逻辑（`windowType==='cycle'` 显示 token 数 + 剩余时间）不动。
- `usageDisplay` 已用 `getQuotaColor` 着色，预警语义保留。
- 5h/7d 两窗口的 join 改用 separator（U1）。

**Patterns to follow:**
- 现有 `formatUsagePercent` + `getQuotaColor` 着色写法。

**Test scenarios:**
- Happy path: 默认配置 5h 输出 `9%` 带颜色，无 bar；含 reset 时间 `(3h39m)`。
- Happy path: GLM 7d cycle 输出含 token 累计 `76M` 与速率 `2.9%/M`。
- Happy path: `usageBarEnabled:true` 时输出含 `quotaBar`（回退）。
- Edge case: `isLimitReached` 时输出 `⚠` critical（不受去 bar 影响）。
- Edge case: `fiveHour === null && sevenDay !== null` 时仅显示 weekly 段。
- Integration: 5h + 7d 同时显示时两者间用 `｜` 分隔。

**Verification:**
- `glm-usage.test.js` 更新断言后全绿；GLM cycle 的 token/速率字段未被破坏。

---

### U4. session tokens 双格式

**Goal:** expanded token 明细行用 `·` 子分隔（`Tokens 29k (in 29k · out 99 · cache 128 · 0.4%)`）；compact 折叠为 `tok 29k 0.4%`。

**Requirements:** R4

**Dependencies:** U1

**Files:**
- Modify: `src/render/lines/session-tokens.ts`（expanded 明细，子分隔改 `·`）
- Modify: `src/render/session-line.ts`（compact token 段，line 268 的 `label(\`tok: ...\`)` push 点，折叠格式）
- Test: `tests/render.test.js`

**Approach:**
- expanded：保持 `label(\`Tokens ...\`)` 外壳，内部 `parts.join(', ')` 改 `parts.join(' · ')`。
- compact：token 段简化为 `tok ${formatTokens(total)} ${cacheHitRate}%`（无 cache 时省略命中率）。
- cache 命中率计算（`calcCacheHitRate`）逻辑不变。

**Patterns to follow:**
- 现有 `formatTokens`（k/M 缩写）与 `calcCacheHitRate`。

**Test scenarios:**
- Happy path: expanded 输出 `Tokens 29k (in 29k · out 99 · cache 128 · 命中 0.4%)`（i18n 标签按语言）。
- Happy path: compact 输出 `tok 29k 0.4%`。
- Edge case: 无 cache token 时省略 cache 段与命中率。
- Edge case: total=0 时不输出该段（现有行为保留）。

**Verification:**
- expanded/compact 两种 token 格式均符合矩阵；i18n 标签正确（中/英）。

---

### U5. compact 两段分层重构

**Goal:** `renderSessionLine` 输出两段：身份段（model + project + git + config counts + session name + CC version）+ 用量段（ctx + usage + tokens + duration + speed + prompt-cache + cost + custom），段间换行，段内 `｜` 分隔。

**Requirements:** R3, R7

**Dependencies:** U1, U2, U3, U4

**Files:**
- Modify: `src/render/session-line.ts`
- Test: `tests/render.test.js`、`tests/render-width.test.js`

**Approach:**
- 拆分现有单一 `parts` 数组为 `identityParts` 与 `metricsParts`。
- context 段：去 bar（`showContextBar !== false` 保留 bar 回退），`contextValue` 默认 `'both'`；前缀短标签 `ctx`（或 i18n）。
- usage 段：复用 U3 的紧凑格式逻辑（`usageCompact` 风格，5h `9% (3h39m)`、7d `76M 2.9%/M`）。
- token 段：复用 U4 compact 折叠格式。
- 两段用 `\n` 连接；每段内 `join(separator)`。
- `render` 调用方（`renderCompact`）已支持多行返回，无需改 `render/index.ts` 的 compact 分支。

**Execution note:** 此单元改动最大、回归风险最高，建议先跑现有 `render.test.js` 的 compact 用例做 characterization（记录当前输出），再重构，确保信息无丢失。

**Patterns to follow:**
- `render/index.ts` `renderCompact` 已接受多行 `lines[]`；`session-line.ts` 现有分段组装逻辑。

**Test scenarios:**
- Happy path: 默认配置输出两行——行1 `[GLM-4.6] ｜ claude-hud git:(main*)`，行2 `ctx 45% (90k/200k) ｜ 5h 9% (3h39m) ｜ 7d 76M 2.9%/M`。
- Happy path: 段内模块间用 `｜`，无 ` | `。
- Edge case: 无 gitStatus 时身份段省略 git 部分。
- Edge case: 无 usageData 时用量段省略 usage 部分。
- Edge case: `showDuration:false` 时用量段省略 duration。
- Integration: 窄终端（`withColumns(60)`）用量段正确换行，不截断关键字段。
- Integration: 开启 `showSessionTokens` 时用量段含 `tok 29k 0.4%`。

**Verification:**
- compact 输出严格两段；信息字段与重构前等价（无丢失）；窄终端可读。

---

## System-Wide Impact

- **Interaction graph:** `render` → `renderCompact`/`renderExpanded` → 各 line 函数。分隔符变更通过 U1 的 `resolveSeparator` 单点扩散，所有 line 函数的 join 行为同步变化。
- **Error propagation:** 渲染层无错误传播（纯字符串拼接）；config 字段缺失走 `migrateConfig` 默认值兜底。
- **State lifecycle risks:** 无持久状态；`migrateConfig` 在启动时一次性迁移老配置，`separator` 字段缺失时填默认 `｜`。
- **API surface parity:** compact 与 expanded 两种布局共享同一套分隔符与颜色规则，风格统一；`/claude-hud:configure` 命令若暴露 `separator` 需同步（本期 config 字段先行，命令 UI 可 follow-up）。
- **Integration coverage:** 跨 layout 的一致性（compact 用量段格式 == expanded 用量行格式）需集成测试覆盖，单测各 line 函数无法证明。
- **Unchanged invariants:** `coloredBar`/`quotaBar` 函数定义、`getContextColor`/`getQuotaColor` 阈值、GLM cycle 的 token/速率计算逻辑、`wrapLineToWidth` 的全角宽度处理——均不动。

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| 全角 `｜` 在部分非等宽字体对齐抖动 | `graphemeWidth` 已将 U+FF5C 计为 width=2，`visualLength`/`wrapLineToWidth` 正确处理；可配置回退半角 |
| 改 `DEFAULT_CONFIG` 影响现有用户呈现 | `migrateConfig` 保留显式值；仅未配置 bar/separator 的用户受影响（fork 场景可接受） |
| compact 两段改变单行契约，用户感知突变 | 开关 `showContextBar`/`usageBarEnabled` 回退；本期为 fork 主分支，无外部消费者 |
| `splitLineBySeparators` 改动破坏 wrap 断行 | U1 同步 separator 与 split；`render-width.test.js` 覆盖窄终端换行 |
| GLM usage 测试断言带 bar 格式 | U3 更新 `glm-usage.test.js` 断言，保留 token/速率字段验证 |

---

## Documentation / Operational Notes

- `CLAUDE.md` 的「Output Format」章节展示了带 bar 的旧示例，需在实现后更新为无 bar + `｜` 格式。
- `/claude-hud:configure` 命令若需暴露 `separator`/`contextValue` 选项，作为 follow-up（本期不强制）。
- 无部署/监控影响（纯客户端 statusline 插件）。

---

## Sources & References

- **Origin document:** [docs/ideation/ui-rewrite-no-bar.md](docs/ideation/ui-rewrite-no-bar.md)
- Related code: `src/render/lines/identity.ts`、`src/render/lines/usage.ts`、`src/render/session-line.ts`、`src/render/index.ts`、`src/config.ts`
- Related tests: `tests/render.test.js`、`tests/render-width.test.js`、`tests/glm-usage.test.js`
