# Fork 改动清单 · 相对上游 jarrodwatts/claude-hud

> 用途：记录 fork 分支 `feat/deepseek-provider`（源 `fyeeme/claude-hud`）相对上游的所有**功能性偏离**，供后续合并上游新版本时快速定位冲突点、判断归属与处理策略。

## 元信息

| 项 | 值 |
|---|---|
| 上游基准 | `release-0.2.0` = `b29bd34`（PR #616） |
| 分叉点（merge-base） | `3d9f7b7` feat: add external usage snapshot fallback (#478) |
| fork 独有提交数 | 50+（含 render 共享工具提取、颜色默认值改 none、expanded badge 右移、`terminalWidth`、缓存 0o600 加固） |
| 功能偏离范围 | **全部集中在 `src/`**（含 4 个新 render 共享模块） |
| 元数据偏离 | `package.json` version = **`1.0.0`**（上游 release-0.2.0 为 `0.2.0`；fork 独立版本号）；其余 `plugin.json`/`marketplace.json` 命名为 `claude-statusline`（上游 `claude-hud`） |

**核心改动一句话**：在上游的 statusline 基础上，新增 **GLM / DeepSeek 第三方 provider 的用量显示**（含余额、自然周 token、会话成本估算），并配套重写了 compact 布局、分隔符、颜色与缓存命中率口径；后续又统一了元素配色为裸文本（`none`）、expanded 布局下 badge 右移、引入 `terminalWidth` 权威宽度源，并加固缓存文件权限。

---

## A. 全新模块（fork 独有，上游无对应文件）

这是 fork 的核心增量，**几乎不会与上游冲突**（上游无同名文件），但合并时需注意上游对 `src/index.ts`/`types.ts` 的改动是否影响这些模块的依赖。

| 模块 | 文件 | 职责 |
|---|---|---|
| **平台路由器** | `src/usage/index.ts` | `getUsage()` —— 按 `ANTHROPIC_BASE_URL` 路由到 claude / glm / deepseek，返回结构化 `UsageData` |
| 平台检测 | `src/glm-detect.ts` | `detectPlatform()` / `getGlmBaseDomain()` —— 识别 provider |
| Claude provider | `src/usage/claude/index.ts` | 解析 stdin rate_limits（等价于上游 stdin-only 路径） |
| **GLM provider** | `src/usage/glm/{api,cache,calibration,compute,index,types}.ts` | 调 GLM 配额 API，解析 unit:3/unit:6，5h/7d 缓存（TTL 可配），含窗口类型(fixed/rolling/cycle)与自然周 token |
| **DeepSeek provider** | `src/usage/deepseek/{api,cache,index,pricing}.ts` | 查余额(balance/currency)、自然周 token(weeklyTokens)、5min 缓存、provider 内维护模型定价 |

**合并注意**：上游从未引用 `src/usage/*`，但 fork 通过 `src/index.ts` 接入（见 D）。若上游未来重构入口，需保证 `getUsage` 路由器仍被调用，否则 GLM/DeepSeek 用量将**静默失效**（这是本次合并曾被破坏的根因）。

### A2. 渲染层共享工具模块（fork 独有，上游无对应文件）

从原 `src/render/index.ts` / 各 render line 中提取的共享代码，避免重复。上游无同名文件，合并几乎不冲突，但需保证 import 路径不被上游重构破坏。

| 模块 | 职责 |
|---|---|
| `src/render/measure.ts` | `visualLength()` / `stripAnsi()` / `segmentGraphemes()` / `graphemeWidth()` —— 可见宽度与 ANSI 去壳。`render/index.ts` 的 wrap/truncate 依赖它 |
| `src/render/format.ts` | `formatTokens()` / `formatContextValue()` —— token 格式化与 context 值渲染，被 identity / session-tokens / session-line 共享 |
| `src/render/sanitize.ts` | `sanitize()` / `CONTROL_AND_BIDI_PATTERN` —— 剩除控制/ bidi 字符，被 added-dirs / advisor / project / skills-mcp-line 共享 |
| `src/render/hyperlink.ts` | `safeHyperlink()` —— OSC 8 安全超链接（仅 file:/https: 协议，URL 先 sanitize），被 added-dirs / project 共享 |

> 注：`render/index.ts` 仍保留了本地 `ANSI_ESCAPE_PATTERN`/`ANSI_ESCAPE_GLOBAL`（供 `sliceVisible`/`splitLineBySeparators` 使用），与 `measure.ts` 内的定义一致。这是为避免循环依赖的有意保留，非 bug。

---

## B. 类型系统扩展（`src/types.ts`）

上游对 `UsageData` 的定义被 fork **并集扩展**（只增不改原有字段）：

- 新增类型：`UsageWindowType`（`'fixed'|'rolling'|'cycle'`）、`UsagePlatform`（`'anthropic'|'glm'|'deepseek'`）
- `UsageData` 新增字段：`fiveHourStartAt` / `sevenDayStartAt`（窗口起点）、`fiveHourWindowType` / `sevenDayWindowType`、`platform`、`sevenDayTokens` / `fiveHourTokens`（GLM token 计数）、`balance` / `currency` / `weeklyTokens` / `sessionCostUsd`（DeepSeek）
- `isLimitReached()` 改为 **GLM 感知**：`platform==='glm'` 时**仅 5h===100** 触发（7d 是估算值，不可靠）

**冲突风险：高**。上游若给 `UsageData` 加字段或改 `isLimitReached`，合并时需以 fork 版为基底并集合并。**保留 fork 的 GLM 逻辑**。

---

## C. 配置扩展（`src/config.ts`）

新增配置 + 默认值调整：

**新增项**
- `display.separator`（默认 `' | '`，半角带空格）—— 取代上游各处硬编码的分隔符
- `usage.fiveHourRefreshSec`（30）/ `usage.sevenDayRefreshSec`（180）—— GLM 缓存 TTL
- `terminalWidth`（默认 `null`）—— **权威终端宽度**。statusline 子进程无法检测真实终端尺寸（`stdout.columns`/`COLUMNS` 不可用），设此字段为唯一可靠宽度源，驱动 wrap 与布局。优先级高于 detected width / `maxWidth`（仅 `forceMaxWidth` 能覆盖）。详见 E8
- `colors.*` 全量可配（上游已有部分；fork 补齐 model/project/git/gitBranch/custom/barFilled/barEmpty）

**默认值调整（fork 有意改的，不要被上游覆盖回去）**
| 字段 | 上游默认 | fork 默认 | 原因 |
|---|---|---|---|
| `display.showContextBar` | `true` | **`false`** | 无状态栏 UI 重写，去掉进度条 |
| `display.contextValue` | `'percent'` | **`'both'`** | 同时显示百分比与 token |
| `display.usageBarEnabled` | `true` | **`false`** | 同上 |
| `display.contextWarningThreshold` | `70` | **`65`** | 颜色阈值统一到 65/85 |
| `colors.model` | `cyan` | **`none`** | 裸文本，与其他元素统一（用户可显式配色） |
| `colors.project` | `yellow` | **`none`** | 同上 |
| `colors.git` | `magenta` | **`none`** | 同上 |
| `colors.gitBranch` | `cyan` | **`none`** | 同上 |
| `colors.label` | `dim` | **`none`** | 同上 |

> `colors.* = 'none'` 表示裸终端前景色（不加 ANSI 色码），用户仍可通过 config 显式覆盖。与 E3 的阈值色（warning/critical）无关——阈值色在超阈值时仍生效。

**冲突风险：高**。上游若调默认值，需逐项核对，**优先保留 fork 的有意图改动**（尤其 4 个默认值调整）。

---

## D. 入口接线（`src/index.ts`）

**关键偏离**：入口 usage 获取从「调用 `src/stdin.ts` 的 `getUsageFromStdin`」改为「调用 `src/usage/index.ts` 的 `getUsage` 路由器」。

```diff
- getUsageFromStdin: typeof getUsageFromStdin,
+ getUsage: typeof getUsage,
  ...
- ? deps.getUsageFromStdin(stdin)
+ ? await deps.getUsage(stdin)
```

`getUsageFromStdin`（`src/stdin.ts`）的定义与导出**保留**（仍有测试/外部消费），仅入口不再 import。

**冲突风险：高 · 最关键**。这是 provider 能跑起来的接线点，上游每次改入口都需重点核对：**必须保留 `getUsage` 路由调用**。

---

## E. 渲染层

### E1. `src/render/lines/usage.ts`（+120 行，改动最大）
- **新增 DeepSeek 分支**：`platform==='deepseek'` → `renderDeepSeekUsage()`（`$cost/$balance · 7d:weeklyTokens`，按 balance currency 换算 CNY×7）
- **5h / 7d 分隔符**：`fiveHourPart | sevenDayPart` → `fiveHourPart, <U+200B>sevenDayPart`（逗号 + 零宽空格软断点）
- **GLM 无 unit:6 限额退化**：`sevenDay===null` 但有 `sevenDayTokens` → 显示 `7d:<tokens>`
- `formatUsageWindowPart` 新增 `windowType` / `tokenCount` 参数，支持 rolling/cycle 窗口的 suffix
- `appendBalance` 增加 `separator` 参数

### E2. `src/render/session-line.ts`（compact 布局）
- 改为**单行** `parts.join(' | ')`（上游新增测试锁定单行契约；fork 历史的「identity+metrics 两行」已退让为单行）
- model badge 与 context value 拆为独立 parts

### E3. `src/render/colors.ts`（颜色策略）
| 元素 | 上游默认 | fork 默认 |
|---|---|---|
| Context <阈值 | GREEN | **DIM（灰）** |
| Usage <阈值 | BRIGHT_BLUE | **DIM（灰）** |
| Usage warning 阈值/色 | ≥75 BRIGHT_MAGENTA | **≥65 YELLOW** |
| Usage critical 阈值 | ≥90 | **≥85** |

阈值与 C 节的 `contextWarningThreshold:65` 联动。**自定义 `colors.*` 覆盖机制完全保留**。

### E4. `src/render/lines/session-tokens.ts`（cache 命中率）
- cache 显示新增命中率：`cache: <total>, <rate>%`
- 命中率口径 = `cacheReadTokens / (inputTokens + cacheReadTokens)`（命中占有效输入；`cacheCreation` 不计入分母，避免热缓存恒 100%）

### E5. 分隔符统一（`project.ts` / `environment.ts`）
- 各行 `parts.join` 改用 `display.separator`（默认 `' | '`），取代上游硬编码 `' │ '`（box-drawing）/ `' | '`

### E6. `src/render/index.ts`（换行/合并）
- `splitLineBySeparators` 新增识别**零宽空格 U+200B** 与全角 `｜`（兼容旧输出）作为软断点
- 合并行 join：`' │ '` → `' | '`

### E7. `src/render/width.ts`（宽度计算）
- 新增 `isZeroWidthCodePoint()`：U+200B–200F / U+FEFF 算 **0 宽**（配合 E6 零宽断点）

### E8. `src/render/lines/project.ts` 与 `session-line.ts`（expanded 项目行重排）
- **去掉 `git:` 前缀**：上游 `git:(branch*)` → fork `(branch*)`（紧挨项目名）
- **expanded 布局下 badge 移到行尾**：上游 `[model] | project (git)` → fork `project (git) | [model]`，badge 作为最后一个 segment（effort 作为独立段紧随其后 `[model] | effort`）
- **effort 从 badge 内拆出**：上游 `[model ◔ medium]` → fork `[model] | ◔ medium`
- **compact 布局不变**：仍走 `renderSessionLine`，badge 在行首、effort 内嵌括号

> 设计动机：statusline 子进程无法检测终端宽度，badge 在行尾避免被 wrap 截断到行首的视觉突变；`terminalWidth`（见 C）生效后 wrap 自然处理布局。

### E9. `src/render/index.ts`（宽度解析 + measure 提取）
- 宽度解析新增最高优先级：`config.terminalWidth` > detected > `maxWidth`（`forceMaxWidth` 仍可覆盖）
- `visualLength`/`stripAnsi`/`segmentGraphemes`/`graphemeWidth` 从本文件提取到 `src/render/measure.ts`（见 A2）

**冲突风险：中-高**（usage.ts / colors.ts / index.ts / project.ts 改动密集）。合并时优先保留 fork 版，仅吸收上游对其他渲染行的中性改进。

---

## F. 成本与外部快照

| 文件 | 偏离 |
|---|---|
| `src/cost.ts` | 接入 `findDeepSeekPricing`；`ModelPricing` 新增 `cacheReadMultiplier`/`cacheWriteMultiplier`（deepseek 缓存按官方比例 0.14×/1.0×） |
| `src/external-usage.ts` | `UsageData` 构造补 `fiveHourStartAt`/`sevenDayStartAt: null`（对齐 B 的字段） |
| `src/stdin.ts` | 同上，`getUsageFromStdin` 补 startAt 字段（函数保留） |

**冲突风险：低-中**。

---

## G. i18n（`src/i18n/{en,types,zh-Hans}.ts`）

新增 key：`format.cacheHit`（en: `"hit"` / zh: `"命中"`）。

> ⚠️ **疑似 dead key**：当前 `session-tokens.ts` 的 cache 命中率是直接拼 `${hitRate}%`，**未使用** `t('format.cacheHit')`（fork 历史 `490088d` 留下）。合并后可考虑清理或启用。

---

## H. 非功能偏离（文档 / 脚本 / 测试）

| 类别 | 内容 | 合并策略 |
|---|---|---|
| 部署脚本 | `deploy.sh`（fork 自建：build + rsync 到 `~/.claude/plugins/cache`） | fork 保留，上游无冲突 |
| 命令 | `commands/path.md` | fork 独有 |
| 设计文档 | `docs/`（brainstorms / ideation / plans，含 `2026-06-16-001-fix-deepseek-glm-merge-breakage-plan.md`、`glm-usage-calculation.md` 等） | fork 沉淀，保留；记录每个特性的设计理由 |
| `.serena/` | IDE 项目配置 | fork 工具配置 |
| provider 测试 | `tests/{deepseek-usage,glm-usage,glm-detect,external-usage,usage-cache}.test.js` | fork 独有，需随 provider 模块维护 |
| 测试断言同步 | `tests/{render,config,integration,i18n}.test.js` | 跟随 src 偏离更新断言（separator/colors/阈值/cache 等） |
| `dist/` | 构建产物 | **应忽略**，合并后重新 `npm run build` |

---

## I. 缓存安全与输入净化（fork 加固，上游未做）

缓存文件可能携带 credential / 余额信息，fork 加了文件权限与原子写防护；并对用户可配置的显示文本加了隐藏字符过滤，防 bidi/零宽字符注入。

| 文件 | 偏离 |
|---|---|
| `src/context-cache.ts` | `writeFileSync` 改用 `{ mode: 0o600 }`（仅 owner 可读写） |
| `src/usage/deepseek/cache.ts` | 原子写：先写 `.tmp`（0o600）再 `rename`，最后 `chmod 0o600` best-effort。防并发/中断产生半写文件 |
| `src/usage/glm/cache.ts` | `readState` 简化：删除上游的 5ms busy-wait 重试逻辑（POSIX rename 原子后不再需要）；返回 null 于任何错误 |
| `src/usage/deepseek/index.ts` | `weeklyTokens` 回退从 `||` 改为 `??`：保留合法的 `0` 值（`||` 会把 `0` 当假丢弃） |
| `src/external-usage.ts` | `sanitizeBalanceLabel` 额外剩除 U+00AD（软连字符）/ U+200B（零宽空格）/ U+FEFF（BOM），防 balance label 隐藏字符欺骗 |

**冲突风险：低-中**。这些是防御性加固，上游若重构缓存逻辑需保留 0o600 与原子写意图。

---

## 合并上游的标准流程

1. **拉取上游**：`git fetch upstream && git log upstream/main` 看新版改动。
2. **聚焦 src/ 冲突**：`git diff upstream/<new-tag> -- src/`，**对照本文档逐文件判断归属**：
   - A/A2 节模块（`src/usage/*`、`src/render/{measure,format,sanitize,hyperlink}.ts`）→ 几乎不冲突，保留 fork
   - B/C/D/E-F/I 节的修改文件 → **高冲突区**，以 fork 为基底，吸收上游中性改进，**死守 provider 接线与默认值意图**
3. **接线回归测试**：合并后必须验证——
   - `npm run build` 零错误
   - `npm test` 全绿（已知遗留：`usage-cache.test.js` February 日期边界；`render-width.test.js` 两个 OSC 8 宽度测试 —— 均为预存与功能无关）
   - **provider 专属测试** `node --test tests/deepseek-usage.test.js tests/glm-usage.test.js tests/glm-detect.test.js tests/external-usage.test.js` 全绿
4. **入口接线核对**：确认 `src/index.ts` 仍调用 `getUsage` 路由器（D 节），否则 GLM/DeepSeek 静默失效。
5. **默认值核对**：C 节的默认值调整（含 `colors.* = none`）未被上游覆盖回去。
6. **宽度接线核对**：确认 `render()` 仍把 `config.terminalWidth` 作为最高优先级宽度源（E9），否则 statusline 退化为不可自适应宽度。

## 冲突热点优先级

🔴 **高**：`src/index.ts`（接线）· `src/types.ts` · `src/config.ts`（含 `terminalWidth` / `colors.*` 默认值）· `src/render/lines/usage.ts`
🟡 **中**：`src/render/colors.ts` · `src/render/session-line.ts` · `src/render/index.ts`（宽度解析）· `src/render/lines/project.ts`（badge 重排 / `git:` 移除）
🟢 **低**：`src/usage/*` 与 `src/render/{measure,format,sanitize,hyperlink}.ts`（新模块）· `src/render/width.ts` · `src/render/lines/environment.ts` · `src/cost.ts` · `src/context-cache.ts` · `src/usage/*/cache.ts`（0o600 / 原子写）
