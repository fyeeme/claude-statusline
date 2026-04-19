# GLM 5h/7d 用量计算逻辑

## 概述

Claude HUD 通过 GLM 平台的两个 API 端点获取用量数据，经过校准和缓存后展示在状态栏。

**核心数据流：**

```
API 请求 → 解析 → 校准(7d) → 单调递增保障 → 写缓存 → 渲染
                                                      ↑
                                  下次调用先读缓存（5h TTL 30s / 7d TTL 5min）
```

**两阶段刷新策略：**

```
getGlmUsage() 被调用 (~300ms)
  │
  ├─ 5h+7d 都新鲜 → 返回缓存（无 API 调用）
  │
  ├─ 5h 过期, 7d 新鲜 → 轻量刷新（只调 1 个 quota API）
  │   ├─ 非 10% 里程碑 → 只更新 5h 字段, 保留 7d
  │   └─ 10% 里程碑   → 升级为全量刷新（确保校准准确）
  │
  └─ 7d 过期 → 全量刷新（3 个 API, 校准+计算 7d%）
```

## 涉及的文件

| 文件 | 职责 |
|------|------|
| `src/glm-usage.ts` | 主逻辑：API 调用、校准、百分比计算 |
| `src/usage-cache.ts` | 缓存读写、订阅时间推算、周期计算 |
| `src/glm-detect.ts` | 检测当前是否在 GLM 平台 |
| `src/render/lines/usage.ts` | 渲染用量条到终端 |

---

## API 端点

### 1. 配额端点：`/api/monitor/usage/quota/limit`

返回值中我们使用两个字段：

```json
{
  "data": {
    "limits": [
      {
        "type": "TOKENS_LIMIT",
        "percentage": 45,
        "nextResetTime": 1745089200000
      },
      {
        "type": "TIME_LIMIT",
        "nextResetTime": 1748016000000
      }
    ]
  }
}
```

- `TOKENS_LIMIT.percentage` → **5h 窗口已用百分比**（直接使用，无需计算）
- `TOKENS_LIMIT.nextResetTime` → 5h 窗口重置时间戳（推算 5h 窗口起止时间）
- `TIME_LIMIT.nextResetTime` → 月度重置时间戳（推算订阅时间，用于 7d 周期计算）

### 2. 用量端点：`/api/monitor/usage/model-usage`

查询指定时间范围内的 token 总消耗：

```
?startTime=2026-04-13 07:43:28&endTime=2026-04-19 16:00:00
```

返回格式（两种）：
- 对象格式：`data.totalUsage.totalTokensUsage`
- 数组格式：`data[].totalTokens` 之和

---

## 5h 窗口计算（简单）

5h 数据**不需要计算百分比**，API 直接返回。

### 数据来源

| 数据 | 来源 | 说明 |
|------|------|------|
| `fiveHour` (%) | `TOKENS_LIMIT.percentage` | API 直接返回，无需推算 |
| `tokens5h` | `model-usage` 查询 | 窗口起始 = `nextResetTime - 5h` |
| `fiveHourResetAt` | `TOKENS_LIMIT.nextResetTime` | 窗口结束/重置时刻 |
| `fiveHourStartAt` | `nextResetTime - 5h` | 窗口起始时刻 |

### 5h 窗口的时间模型

```
  fiveHourStartAt              now              fiveHourResetAt
       │                        │                     │
       ├──────── 5h 窗口 ────────┤──────── 剩余 ───────┤
       │                        │                     │
       │◄── tokens5h 查询范围 ──►│                     │
```

**请求顺序（全量刷新时两阶段并行）：**

```
Phase 1 (并行):
  ├── quota/limit → 获取 fiveHourPct + nextResetTime
  └── model-usage (cycleStart → now) → tokens7d

Phase 2 (依赖 Phase 1 的 nextResetTime):
  └── model-usage (nextResetTime - 5h → now) → tokens5h
```

**轻量刷新（仅 5h 过期时）：**

```
只调 1 个 API:
  └── quota/limit → 获取新的 fiveHourPct + nextResetTime

不调 model-usage → 不影响校准和 7d 数据
```

---

## 7d 周期计算（复杂）

### 为什么 7d 很复杂

GLM 的 7d 限额是**固定周期**（从订阅时间开始，每 7 天一个周期），不是滚动窗口。这带来三个挑战：

1. **如何知道周期起点？** → 从 `TIME_LIMIT.nextResetTime` 反推订阅时间
2. **7d 总预算是多少？** → API 不直接返回，需要从 5h 数据推算（校准）
3. **如何避免显示回退？** → 校准值锁定 + 单调递增保障

### 第一步：推算订阅时间

GLM 的 `TIME_LIMIT` 是月度重置，重置时间就是订阅周年日。

```
API 返回: TIME_LIMIT.nextResetTime = 2026-04-30 15:43:28 (UTC)

→ 订阅日 = 每月 30 号 15:43:28 (UTC)
→ 订阅时间戳 (首次) = 2026-03-30 07:43:28 UTC
```

推算算法（`inferSubscriptionTime`）：
1. 从 `TIME_LIMIT.nextResetTime` 提取 day-of-month、hour、minute、second
2. 找到当前时间之前最近的一个该 day+time
3. 处理月末边界（如 31 号在 30 天月份 → 回退到月末）

**只推断一次**，后续从缓存读取。

### 第二步：计算当前周期起点

```typescript
function computeCycleStart(subscriptionTimeMs, nowMs) {
  const n = Math.floor((nowMs - subscriptionTimeMs) / (7 * 24 * 3600 * 1000));
  return subscriptionTimeMs + n * 7d;
}
```

**例子：**

```
订阅时间: 2026-03-30 07:43 UTC
周期边界: 3/30 → 4/6 → 4/13 → 4/20 → 4/27 → ...

当前时间: 2026-04-19 08:00 UTC
→ 当前周期起点: 2026-04-13 07:43 UTC
→ 下次重置:     2026-04-20 07:43 UTC
```

### 第三步：校准 7d 总预算（calibratedLimit7d）

API 不直接返回 7d 的 token 总预算，需要从 5h 数据推算。

**推算公式（单点）：**

```
5h 总预算 = tokens5h × 100 / fiveHourPct
7d 总预算 = 5h 总预算 × 5        （官方比例: 7d 限额 = 5 × 5h 限额）

即: calibratedLimit7d = (tokens5h × 100 × 5) / fiveHourPct
```

**多点平均校准（消除采样偏差）：**

由于 `fiveHourPct`（quota API）和 `tokens5h`（model-usage API）存在采样时差，单点校准有系统性低位偏差（刚跨入 10% 时 tokens 对应 ~9% 用量）。通过在每个里程碑收集多个 `tokens5h` 样本取平均值消除偏差：

```
milestoneSamples = { "10": [100M, 105M], "20": [210M, 215M], ... }

对每个里程碑: avgTokens = sum(samples) / count(samples)
多点平均: calibratedLimit7d = Σ(avgTokens × 500 / pct) / 里程碑数
```

**例子：**

```
milestoneSamples = { "10": [100M], "20": [210M] }

10%: 100M × 500 / 10 = 5000M
20%: 210M × 500 / 20 = 5250M
平均: (5000M + 5250M) / 2 = 5125M

→ calibratedLimit7d = 5125M
```

**校准触发条件（10% 里程碑）：**

```typescript
const isMilestone = fiveHour != null && fiveHour > 0 && fiveHour % 10 === 0;
needsCalibration = calibratedLimit7d == null      // 首次，从未校准过
                || calibratedAtPct == null         // 旧缓存迁移，无百分比记录
                || isMilestone;                    // 5h 百分比是 10 的倍数
```

| 场景 | 是否触发 | 原因 |
|------|---------|------|
| 首次运行 | 触发 | `calibratedLimit7d == null` |
| 5h = 47% | 不触发 | 47 不是 10 的倍数 |
| 5h = 30% | 触发 | 30 是 10 的倍数，同时收集样本 |
| 5h = 10% → 10%（同窗口不同时刻） | 触发 | 每次到达里程碑都采集样本，FIFO 保留最近 10 个 |
| 旧缓存（无 calibratedAtPct） | 触发 | 迁移兼容 |

**采样规则：**
- 每个里程碑最多保留 10 个样本（FIFO）
- 新周期（`sevenDayStartAt` 变化）时清空所有样本
- 非里程碑 full refresh 不采集新样本，但仍使用已有样本计算
- 无样本数据时 fallback 到单点公式

**为什么只在 10% 倍数校准：**

API 返回的 `fiveHourPct` 是整数百分比。同一百分比在不同时刻对应的 token 量不同：
- 早期 20% 时 token 少 → 推算的预算精度低
- 后期 20% 时 token 多 → 推算更准确

限制在里程碑点（10%, 20%, 30%...）校准，既避免中间百分比的噪声，又能在里程碑点获取最新最准的数据。即使同一里程碑多次触发，后期数据会覆盖前期不准确的估算。

### 第四步：计算 7d 百分比

```
7d% = tokens7d / calibratedLimit7d × 100
```

其中 `tokens7d` 通过 `model-usage` API 查询从 `cycleStart` 到 `now` 的 token 总量。

**注意查询范围是固定周期起点，不是 `now - 7d`（滚动窗口）。**

### 第五步：单调递增保障

即使有限制波动，同一周期内的百分比和 token 数也**不允许下降**。

```typescript
if (sevenDayStartAt === prevCycleStart) {  // 同一周期
  sevenDay       = max(sevenDay, prevSevenDay);
  sevenDayTokens = max(sevenDayTokens, prevSevenDayTokens);
}
```

**周期切换时自然重置：**

```
旧周期: sevenDayStartAt = 4/13 07:43  →  sevenDay = 85%, tokens = 2100M
新周期: sevenDayStartAt = 4/20 07:43  →  不同！monotonic 不生效
                                        →  sevenDay = 2%, tokens = 50M (自然值)
```

---

## 缓存机制

### 缓存文件

路径：`~/.claude/.claude-hud/.usage-cache.json`

### 缓存结构

```typescript
interface CachedUsageData {
  // ── 基础数据（TTL 控制）──
  platform: 'glm';
  fiveHour: number | null;           // 5h 百分比
  sevenDay: number | null;           // 7d 百分比
  sevenDayTokens?: number;           // 7d 已用 token 数
  fiveHourTokens?: number;           // 5h 已用 token 数
  timestamp: number;                 // 写入时间戳（控制 7d TTL）
  ttlMs: number;                     // 7d TTL（配置: sevenDayRefreshSec）
  isError?: boolean;                 // 是否是错误状态
  fiveHourFetchedAt?: number;        // 5h 数据刷新时间戳（控制 5h TTL，独立于 timestamp）

  // ── 校准数据（TTL 豁免）──
  calibratedLimit7d?: number;        // 推算的 7d 总预算
  calibratedAt?: number;             // 上次校准时间戳
  calibratedAtPct?: number;          // 上次校准时的 5h 百分比
  subscriptionTimeMs?: number;       // 推算的订阅时间戳

  // ── 窗口时间（TTL 控制）──
  fiveHourStartAt?: number | null;   // 5h 窗口起始
  fiveHourResetAt?: number | null;   // 5h 窗口重置
  sevenDayStartAt?: number | null;   // 7d 周期起始
  sevenDayResetAt?: number | null;   // 7d 周期重置
  milestoneSamples?: Record<string, number[]>; // 里程碑采样 { "10": [tokens, ...] }

  // ── 元数据 ──
  fiveHourWindowType: 'cycle';
  sevenDayWindowType: 'cycle';
}
```

### 两阶段缓存策略

5h 和 7d 使用独立的 TTL，通过配置文件控制：

| 参数 | 配置字段 | 默认值 | 说明 |
|------|---------|--------|------|
| 5h TTL | `usage.fiveHourRefreshSec` | 300s | 5h 百分比刷新间隔 |
| 7d TTL | `usage.sevenDayRefreshSec` | 300s | 7d 数据全量刷新间隔 |

```
getGlmUsage() 被调用（~每 300ms）
  │
  ├─ readCache() ── 7d TTL 检查
  │   ├─ 过期/不存在 → 全量刷新（跳到下面）
  │   └─ 命中且未过期 → 继续 5h 检查
  │       │
  │       ├─ fiveHourAge < fiveHourTtlMs → 返回缓存（不发 API）
  │       │
  │       └─ fiveHourAge ≥ fiveHourTtlMs → 轻量刷新
  │           │
  │           ├─ fetchGlmQuotaOnly() ── 只调 1 个 quota API
  │           │   ├─ fiveHourPct % 10 !== 0 → 轻量更新（只写 5h 字段，保留 7d TTL）
  │           │   └─ fiveHourPct % 10 === 0 → 升级为全量刷新
  │           │
  │           └─ 失败 → 返回缓存的旧数据
  │
  ├─ 全量刷新流程:
  │   ├─ readCalibrationFields() ── TTL 豁免，获取校准值
  │   ├─ fetchGlmApi() ── 3 个 API 请求
  │   │   ├─ Phase 1: quota + 7d usage（并行）
  │   │   └─ Phase 2: 5h usage（依赖 Phase 1 的 nextResetTime）
  │   ├─ 校准 → 计算 7d%
  │   ├─ Monotonic 保障（对比 readCalibrationFields 的前值）
  │   └─ writeCache() → 原子写入
```

**轻量刷新的关键约束：**

- 只调 quota API（1 个请求），不调 model-usage
- 使用 `writeCache(data, cached.timestamp)` 保留 7d TTL 不被重置
- 更新 `fiveHourFetchedAt` 为当前时间，用于下次 5h TTL 检查
- **不动任何校准字段**：`calibratedLimit7d`、`calibratedAt`、`calibratedAtPct` 保持缓存值
- **不动 7d 数据**：`sevenDay`、`sevenDayTokens`、`sevenDayStartAt` 保持缓存值

### TTL 豁免字段

以下字段通过 `readCalibrationFields()` 读取，**不受 TTL 限制**，跨缓存周期持久化：

| 字段 | 用途 |
|------|------|
| `calibratedLimit7d` | 7d 总预算，避免每次重新推算 |
| `calibratedAt` | 上次校准时间（诊断用） |
| `calibratedAtPct` | 上次校准时的 5h 百分比（10% 阈值判断） |
| `subscriptionTimeMs` | 订阅时间（推算周期起点） |
| `milestoneSamples` | 里程碑 token 采样（多点平均校准） |
| `sevenDay` | 上次 7d 百分比（monotonic 保障） |
| `sevenDayTokens` | 上次 7d token 数（monotonic 保障） |
| `sevenDayStartAt` | 上次周期起点（判断是否同一周期） |

### 错误处理中的缓存策略

| 错误类型 | 行为 |
|---------|------|
| 认证失败 (401/403) | 写入错误缓存（45-75s TTL），保留校准字段 |
| 限流/服务器错误 (429/5xx) | 写入错误缓存（指数退避），优先返回未过期的旧缓存 |
| 超时/网络错误 | 优先返回未过期的旧缓存，否则返回 null |
| 无 Auth Token | 写入错误缓存，返回 null |

---

## 完整数据流示例

假设用户订阅时间为 `2026-03-30 07:43 UTC`，当前时间为 `2026-04-19 08:00 UTC`。

### 缓存未命中时的完整流程

```
1. readCache() → null（TTL 过期）

2. readCalibrationFields() → {
     calibratedLimit7d: 2500_000_000,
     calibratedAtPct: 25,
     subscriptionTimeMs: 1743318208000,
     sevenDay: 68,
     sevenDayTokens: 1700_000_000,
     sevenDayStartAt: 1744527808000    // 4/13 07:43 UTC
   }

3. computeCycleStart(subscriptionTime, now)
   → cycleStart = 1744527808000        // 4/13 07:43 UTC（与缓存一致）

4. fetchGlmApi(baseDomain, headers, cycleStart)
   Phase 1 并行:
     ├── quota/limit → TOKENS_LIMIT.percentage = 32, nextResetTime = T1
     └── model-usage(cycleStart → now) → tokens7d = 1800_000_000

   Phase 2:
     └── model-usage(T1 - 5h → now) → tokens5h = 160_000_000

5. 校准判断:
   |32 - 25| = 7 < 10 → 不触发重新校准
   calibratedLimit7d 保持 2500_000_000

6. 计算 7d%:
   7d% = 1800M / 2500M × 100 = 72%

7. Monotonic 保障:
   sevenDayStartAt === prevCycleStart（同一周期）
   72 > 68 → 不需要强制（自然递增）

8. writeCache() → 写入新缓存
```

### 校准触发的场景

```
上次校准: calibratedAtPct = 20, calibratedLimit7d = 2500M

现在 API 返回: fiveHour = 45%, tokens5h = 225M

|45 - 20| = 35 ≥ 10 → 触发重新校准

新 calibratedLimit7d = (225M × 100 × 5) / 45 = 2500M（巧合相同）
calibratedAtPct 更新为 45
```

---

## 防止回退的五道防线

```
防线 1: 10% 里程碑校准
  calibratedLimit7d 只在 fiveHour% 是 10 的倍数时才更新
  → 避免中间百分比带来的噪声

防线 2: 多点平均采样
  每个里程碑收集多个 tokens5h 样本取平均值
  → 消除"刚跨入百分比档位"的系统性低位偏差

防线 3: 单调递增保障
  即使 limit 重新校准导致百分比降低
  同一周期内 sevenDay 取 max(new, prev)
  → 兜底保证

防线 4: 固定周期查询
  查询 model-usage 从 cycleStart（不是 now-7d）
  → 避免"旧周期 token 还在窗口内"导致的膨胀

防线 5: 里程碑触发全量刷新
  轻量刷新发现 5h% 是 10 的倍数时，升级为全量刷新
  → 确保校准始终在里程碑点采集数据，不会因 5h TTL 缩短而错过

周期重置 = 自然清零:
  computeCycleStart 返回新的 sevenDayStartAt
  与前值不同 → monotonic 不生效 → 从 0 重新开始
```

---

## 日志格式

日志文件路径：`~/.claude/plugins/claude-hud/usage.log`，上限 512KB，超出自动截断保留最后 200 行。

### 日志行类型

#### 1. 缓存命中（~10% 概率采样）

约每 10 次缓存命中记录 1 次（`random <=5 || random >=95`），避免每 300ms 一次的噪音。

```
[2026-04-19 16:28:33] cache=HIT 5h=47% 7d=60%(512M) ttl=2m30s
```

| 字段 | 含义 |
|------|------|
| `cache=HIT` | 5h 和 7d 都新鲜，未调用 API |
| `5h=47%` | 缓存的 5h 百分比 |
| `7d=60%(512M)` | 缓存的 7d 百分比和 token 数 |
| `ttl=2m30s` | 7d 缓存剩余有效期 |

#### 2. 轻量刷新（5h 过期、7d 新鲜时）

```
[2026-04-19 16:28:33] cache=5h-REFRESH 5h=33% 7d=60%(512M)
```

| 字段 | 含义 |
|------|------|
| `cache=5h-REFRESH` | 只调了 quota API（1 个请求），未调 model-usage |
| `5h=33%` | 新获取的 5h 百分比 |
| `7d=60%(512M)` | 保留的 7d 数据（未变） |

#### 3. 里程碑触发全量刷新

```
[2026-04-19 16:28:33] cache=5h-MILESTONE 5h=30% → full refresh
```

| 字段 | 含义 |
|------|------|
| `cache=5h-MILESTONE` | 轻量刷新检测到 5h% 是 10 的倍数 |
| `5h=30%` | 触发全量刷新的里程碑百分比 |
| `→ full refresh` | 升级为全量刷新（后续跟 cache=MISS 的三行日志） |

#### 4. API 调用成功（每次记录，三行）

```
[2026-04-19 16:33:33] cache=MISS
[2026-04-19 16:33:33] api 5hPct=47 tokens5h=73M tokens7d=512M reset5h=04-19T17:02 resetTime=04-30T15:43
[2026-04-19 16:33:33] calc limit7d=855M@47% subMs=1744856592 cycle=04-13T15:43 7d=60%(512M) mono=- prev7d=60%(512M)
```

**`api` 行 — API 原始返回值：**

| 字段 | 来源 | 含义 |
|------|------|------|
| `5hPct` | `TOKENS_LIMIT.percentage` | 5h 百分比原始值 |
| `tokens5h` | `model-usage(5h窗口)` | 5h 窗口实际消耗 token |
| `tokens7d` | `model-usage(周期起点→now)` | 当前周期实际消耗 token |
| `reset5h` | `TOKENS_LIMIT.nextResetTime` | 5h 窗口重置时间 |
| `resetTime` | `TIME_LIMIT.nextResetTime` | 月度重置时间（推算订阅时间的依据） |

**`calc` 行 — 7d 计算过程：**

| 字段 | 来源 | 含义 |
|------|------|------|
| `limit7d` | `calibratedLimit7d` | 推算的 7d 总预算 |
| `@47%` | `calibratedAtPct` | 校准时的 5h 百分比 |
| `subMs` | `subscriptionTimeMs` | 推算的订阅时间戳（秒） |
| `cycle` | `sevenDayStartAt` | 当前周期起点 |
| `7d` | 最终 `sevenDay%` | 最终 7d 百分比和 token 数 |
| `mono` | 单调递增 | `-` 未触发，`55%→60%` 表示被提升 |
| `prev7d` | `calibration.sevenDay` | 上一轮缓存的 7d 值（对比用） |

#### 5. 错误（每次记录）

```
[2026-04-19 16:33:33] error=auth limit7d=855M@47% subMs=1744856592 msg=Auth failed: 401
[2026-04-19 16:33:33] error=retryable limit7d=855M@47% subMs=1744856592 msg=Server/rate-limit error: 429
```

错误日志保留校准缓存状态，方便判断问题是否由校准丢失引起。
