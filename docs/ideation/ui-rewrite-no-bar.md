# Ideation: 去 bar 化 UI 重写（数字 + 文字 + ｜ 分隔）

- **日期**: 2026-06-14
- **模式**: repo-grounded（claude-hud UI 渲染层）
- **Focus**: 参考紧凑数字式 statusline（`tokens 29k(in 29k, out 99, cache 128,0.4%) · Usage 9%(3h39m) · 7d:76M · 2.9%/1.0M · 14s 6.6tok/s`），去掉进度条，用简洁数字+文字 + `｜` 分隔，提升可读性。
- **生成方式**: focus 高度具体，未 fan-out 6 sub-agents；集中生成 6 个有区分度的完整方案后逐一批判。

---

## 1. Grounding：当前 UI 现状

### bar 的两处来源
| 位置 | 函数 | 文件 | 当前形态 |
|---|---|---|---|
| context bar | `coloredBar()` | `render/lines/identity.ts:38`, `render/session-line.ts:33` | `Context █████░░░░░ 45%` |
| usage bar | `quotaBar()` | `render/lines/usage.ts:223`, `render/session-line.ts` usage 分支 | `Usage ██░░░░░░░░ 9% (3h39m / 5h)` |

两者都用 `█`（填充）+ `░`（空）字符渲染。

### 分隔符现状
- 半角 `' | '`，出现在 `render/index.ts:431`（expanded merge group）与 `session-line.ts:303`（compact join）。
- 用户目标：改用全角 `｜`。

### 两种 layout
- **compact**（`renderSessionLine`）：单行，所有信息 ` | ` 串接。
- **expanded**（默认，`renderExpanded`）：多行，按 elementOrder 逐行；可 merge group 合并到一行。

### 已有的颜色阶梯（去 bar 后承担预警语义）
- `getContextColor`：`<70%` 绿 / `70–85%` 黄 / `>85%` 红。
- `getQuotaColor`：`<75%` 蓝 / `75–90%` 品红 / `>90%` 红。

### 已有的相关配置开关
- `showContextBar`、`usageBarEnabled`、`contextValue`(percent/tokens/remaining/both)、`usageCompact`、`sevenDayThreshold`、`showTokenBreakdown`。

### GLM fork 特色（必须保留）
- 7d 窗口为 rolling/cycle，显示**累计 token 数**（`76M`）与**速率**（`2.9%/1.0M`）——上游 Anthropic 窗口无此信息。
- 5h 窗口为 cycle，显示剩余时间（`3h39m`）。

---

## 2. Topic Axes

| Axis | 含义 |
|---|---|
| **A1 信息架构** | 哪些模块保留/合并；context% 与 session tokens 的关系；5h+7d 双窗口如何并存 |
| **A2 分隔与分组** | `｜` 的粒度；模块边界；单行 vs 多行 |
| **A3 数值格式化** | 单位（k/M）、紧凑度、括号嵌套层数 |
| **A4 视觉强调** | 去 bar 后如何用颜色/阈值符号补偿"接近上限"的预警语义 |
| **A5 布局模式** | compact / expanded 如何统一新风格；宽度自适应 |

---

## 3. 候选方案

> 统一示例数据集（贴近真实环境，便于横向对比）：
> model `GLM-4.6` · project `claude-hud` · git `feat/gml-0.13*` · context `45% (90k/200k)` · 5h `9% (3h39m)` · 7d `76M, 2.9%/M` · session tokens `29k (in 29k, out 99, cache 128, 0.4%)` · `14s` · `6.6 tok/s`

### 方案 A：单行流式（忠实参考 + ｜）
```
[GLM-4.6] claude-hud git:(feat/gml-0.13*) ｜ ctx 45% (90k/200k) ｜ 5h 9% (3h39m) ｜ 7d 76M 2.9%/M ｜ tok 29k (in 29k, out 99, cache 0.4%) ｜ 14s 6.6t/s
```
- **Basis**: `external:` 参考格式（ccstatusline 风格）+ `direct:` 用户明确要求 `｜` 分隔。
- **设计**: 把参考行的 `·` 换成 `｜`，前置 model/project/git 身份段。
- **优点**: 与用户参考最接近，认知迁移成本最低。
- **缺点**: 信息全展开会超 100 列，窄终端必折行；context% 与 session tokens 同时出现略冗余。

### 方案 B：两段分层（身份段 + 用量段）
```
[GLM-4.6] ｜ claude-hud git:(feat/gml-0.13*)
ctx 45% (90k/200k) ｜ 5h 9% (3h39m) ｜ 7d 76M 2.9%/M ｜ tok 29k 0.4% ｜ 14s 6.6t/s
```
- **Basis**: `direct:` claude-hud 已有 compact/expanded 双 layout；`reasoned:` 身份（model+project+git）与用量（token/quota/duration）是两类认知负载，分层降低扫读成本。
- **设计**: 第 1 行只放"我是谁/在哪"；第 2 行用 `｜` 串所有数字指标。
- **优点**: 每行宽度可控；身份与用量分离，扫读清晰；天然映射现有 expanded 多行。
- **缺点**: 占 2 行（部分用户喜欢单行）；session token 的 cache 命中率折叠成 `0.4%` 损失 breakdown 细节。

### 方案 C：极简数字优先（去标签）
```
[GLM-4.6] claude-hud:feat/gml-0.13* ｜ 45% 90k ｜ 9% 3h39m ｜ 76M ｜ 29k·0.4% ｜ 14s 6.6t/s
```
- **Basis**: `reasoned:` statusline 每 ~300ms 刷新，标签（ctx/5h/7d）是冗余装饰；位置+颜色已能消歧。
- **设计**: 删掉所有文字标签，只留数字与最少分隔符。
- **优点**: 最紧凑，窄终端友好。
- **缺点**: 可读性依赖记忆"第几个字段是什么"；新用户无法理解；违背"数字**+文字**"的明确要求。**与用户诉求冲突。**

### 方案 D：阈值符号补偿（保留一眼预警）
```
[GLM-4.6] claude-hud git:(feat/gml-0.13*) ｜ ctx 45% (90k/200k) ｜ 5h ▲9% (3h39m) ｜ 7d 76M ｜ tok 29k ｜ 14s 6.6t/s
```
- **Basis**: `reasoned:` bar 的核心价值是"一眼看出程度"；去 bar 后用单字符阈值符号（`·`<70% / `▲`70–85% / `■`>85%）+ 颜色补偿，宽度成本仅 1 字符。
- **设计**: 每个百分比前缀一个程度符号，颜色照旧。
- **优点**: 保留 bar 的"程度感知"优点，几乎不占宽度；满足"数字+文字"。
- **缺点**: 引入新符号语义，用户需学习；符号选择有主观性；可能被视为"另一种 bar"。

### 方案 E：自适应密度（width-driven 三档）
- **宽终端（≥100c）**: 方案 A 单行全展开
- **中终端（70–99c）**: 方案 B 两段分层
- **窄终端（<70c）**: 折叠到关键字段 `ctx 45% ｜ 5h 9% ｜ 7d 76M`
- **Basis**: `direct:` `render/index.ts` 已有 `wrapLineToWidth` + 终端宽度检测机制；`reasoned:` statusline 调用环境宽度不固定，静态布局必有一档失败。
- **设计**: 不是独立视觉风格，而是 A/B/C 的**调度层**。
- **优点**: 健壮，任意宽度都可读；复用现有宽度基础设施。
- **缺点**: 实现复杂度最高；三档边界需调参；本身不回答"主风格是什么"。

### 方案 F：模块卡片式（expanded 多行去 bar）
```
[GLM-4.6] claude-hud git:(feat/gml-0.13*) ｜ 14s 6.6t/s
ctx 45% (90k/200k) ｜ 5h 9% (3h39m) ｜ 7d 76M 2.9%/M
tok 29k (in 29k · out 99 · cache 128 · 0.4%)
```
- **Basis**: `direct:` 现有 expanded 默认布局就是多行；`direct:` `session-tokens.ts` 已有完整 token breakdown 格式。
- **设计**: expanded 模式下，project 行 + 用量行 + token 明细行；行内用 `｜` 分子模块，行间用换行分大类。
- **优点**: 信息分层最清晰；token breakdown 完整保留；与现有 expanded 架构改动最小。
- **缺点**: 占 3 行；compact 用户用不上。

---

## 4. 批判性评估

### 横向对比

| 方案 | 可读性 | 紧凑度 | 预警补偿(A4) | 与现有架构契合 | 适配宽度 |
|---|---|---|---|---|---|
| A 单行流式 | 中 | 高（宽终端） | 仅颜色 | 中（compact） | 差（窄） |
| B 两段分层 | **高** | 中 | 仅颜色 | **高** | 中 |
| C 极简 | 差 | **极高** | 仅颜色 | 低 | 好 |
| D 阈值符号 | 高 | 高 | **颜色+符号** | 中 | 好 |
| E 自适应 | 高 | 动态 | 取决于内层 | **高（复用）** | **极好** |
| F 卡片式 | **极高** | 低 | 仅颜色 | **高（expanded）** | 中 |

### 被拒思路及理由

- **C 极简数字优先 → 拒**：违背用户"数字**+文字**"的明确要求；statusline 面向快速扫读，无标签的认知负担不可接受。即便最紧凑，也不应牺牲可读性。
- **A 单行流式作为唯一方案 → 部分拒**：作为 compact 模式主风格可接受，但信息全展开必超宽。claude-hud 同时有 model+project+git+context+5h+7d+session token+duration+speed 九类信息，比参考格式（来自按 token 计费的工具）更密。**不能作为唯一方案**，必须配合宽度降级。
- **完全照搬参考格式的 `tokens 29k` 替代 context% → 拒**：参考工具没有 context window 概念；claude-hud 的核心价值是 `context%`（距 compact 多远）。`tokens 29k`（session 累计）是不同维度，应**并存**而非替代。
- **保留 bar 仅作为 opt-in → 不在本次范围**：用户明确要"去掉多余无用的进度条"。可保留 `showContextBar`/`usageBarEnabled` 开关让旧用户回退，但**默认全关**。

### 去 bar 的核心 trade-off（必须诚实呈现）
- **bar 的价值**：填充长度提供 ~100ms 的"程度感知"（一眼看出 45% vs 90%），颜色变化提供趋势。
- **bar 的成本**：占 10+ 列宽度；300ms 刷新下微小变化是噪音；数字 `45%` 已精确传达同样信息。
- **用户判断**：成本 > 价值。**同意**，前提是用颜色阶梯（已有）+ 可选阈值符号（方案 D）补偿预警语义。纯去 bar 不补偿会丢失"接近上限"的直观警示——这是去 bar 唯一的真实风险。

---

## 5. 推荐方案

**主方案：B（两段分层）+ F（expanded 卡片式）+ E（自适应宽度调度）+ 可选 D（阈值符号）**

理由：
1. **B/F 分别覆盖 compact/expanded**——claude-hud 两种 layout 都要改，B 和 F 恰好是各自的去 bar 版本，且共用同一套 `｜` 分隔与颜色规则，风格统一。
2. **E 作为调度层**解决宽度问题，复用现有 `wrapLineToWidth`，不重新发明。
3. **D 作为可选增强**（配置开关，默认关）：给需要"一眼程度感"的用户保留选项，但不强加符号学习成本。
4. **保留 context%** 作为核心字段，session tokens breakdown 作为 expanded 第三行（方案 F）。

### 推荐方案的默认呈现

**compact（单/双行自适应）**：
```
[GLM-4.6] ｜ claude-hud git:(feat/gml-0.13*)
ctx 45% (90k/200k) ｜ 5h 9% (3h39m) ｜ 7d 76M 2.9%/M ｜ 14s 6.6t/s
```

**expanded（卡片式）**：
```
[GLM-4.6] claude-hud git:(feat/gml-0.13*) ｜ 14s 6.6t/s
ctx 45% (90k/200k) ｜ 5h 9% (3h39m) ｜ 7d 76M 2.9%/M
tok 29k (in 29k · out 99 · cache 128 · 0.4%)
```

---

## 6. 决策记录（2026-06-14）

已确认：
- ✅ **主方案 = B + F + E**：compact 用两段分层，expanded 用卡片式，E 按宽度调度。
- ✅ **预警补偿 = 仅数字颜色**：context/usage 数字直接套用现有绿/黄/红阶梯，不引入阈值符号。`showContextBar`/`usageBarEnabled` 开关保留（默认关），老用户可回退。

待定（留到 brainstorm/plan）：
- ⏳ **session tokens 位置**：compact 里折叠成 `tok 29k 0.4%`（省宽），还是完整 `tok 29k (in 29k, out 99, cache 0.4%)`？
- ⏳ **分隔符字符**：全角 `｜`（U+FF5C，省 1 列）还是带空格半角 ` | `（等宽稳定）。注意全角在中日韩字体可能对齐抖动。
- ⏳ **5h/7d 表达**：带标签 `5h 9% (3h39m) ｜ 7d 76M 2.9%/M`，还是去标签靠位置 `9% 3h39m ｜ 76M 2.9%/M`？
- ⏳ **改动范围**：仅渲染层，还是同时调整默认配置（默认关 bar、换分隔符）。

---

## 7. 下一步

本文档为 ideation 产物，不包含实现计划。推荐路径：
- `ce-brainstorm`：精化 4 个待定项 + 字段顺序/折叠规则/配置开关语义。
- `ce-plan`：出实现计划（涉及 `identity.ts`/`usage.ts`/`session-line.ts`/`session-tokens.ts`/`render/index.ts` 分隔符 + 默认配置）。
