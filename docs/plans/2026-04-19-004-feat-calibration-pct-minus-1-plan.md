# 优化 5h 校准逻辑：pct-1 计算公式 + 100% 采样 + 单调递增保障

## 背景

当前校准机制在 milestone+1（11%, 21%, 31%...）时采样 tokens5h，归因到前一个里程碑（10%, 20%, 30%），然后用 `tokens5h × 100 / pct × 5` 推算 7d 总预算。

**问题：**
- 采样归因到 milestone（10%, 20%），但校准公式中除数也是 milestone pct — 这意味着 11% 时的 tokens 被当作 10% 的 token 量使用，实际上 11% 的 token 已经比 10% 多了一些
- 100% 时不触发采样，错过了最准确的校准机会（几乎用完整个 5h 窗口）
- `calibratedLimit7d` 没有单调递增保障，新计算值可能小于旧值导致 7d% 跳变

## 改动

### 1. `isMilestone` 触发条件增加 100%

**文件：** `src/glm-usage.ts`（两处：轻量刷新 ~L369 和全量刷新 ~L490）

```typescript
// 现状
const isMilestone = fiveHour != null && fiveHour > 1 && fiveHour % 10 === 1;

// 改为
const isMilestone = (fiveHour != null && fiveHour > 1 && fiveHour % 10 === 1)
  || fiveHour === 100;
```

### 2. 100% 采样走独立分支

**文件：** `src/glm-usage.ts` ~L491

100% 时不走里程碑采样框架（不归因到 99%），而是直接计算 `tokens5h × 5`：

```typescript
if (fiveHour === 100 && canCalibrate) {
  const hundredPctLimit = results.tokens5h * 5;
  if (calibratedLimit7d != null && hundredPctLimit < calibratedLimit7d) {
    deps.appendLog(
      `warning=CALIBRATION_REGRESSION old=${Math.floor(calibratedLimit7d / 1e6)}M new=${Math.floor(hundredPctLimit / 1e6)}M at 100%`,
    );
    // 保留旧值
  } else {
    calibratedLimit7d = hundredPctLimit;
    calibratedAt = nowMs;
    calibratedAtPct = 100;
  }
} else if (isMilestone && canCalibrate) {
  // 原有里程碑采样逻辑不变
}
```

### 3. 里程碑校准的单调递增保障

**文件：** `src/glm-usage.ts` ~L506-535（`needsCalibration` 分支计算完成后）

在所有校准路径（多点半均 + 单点 fallback）计算完 `calibratedLimit7d` 后，增加单调递增检查：

```typescript
if (calibration?.calibratedLimit7d != null
    && calibratedLimit7d != null
    && calibratedLimit7d < calibration.calibratedLimit7d) {
  deps.appendLog(
    `warning=CALIBRATION_REGRESSION old=${Math.floor(calibration.calibratedLimit7d / 1e6)}M new=${Math.floor(calibratedLimit7d / 1e6)}M at ${fiveHour}%`,
  );
  calibratedLimit7d = calibration.calibratedLimit7d;
  calibratedAt = calibration.calibratedAt;
  calibratedAtPct = calibration.calibratedAtPct;
}
```

### 4. 轻量刷新的 milestone 检测同步更新

**文件：** `src/glm-usage.ts` ~L369

与全量刷新的 `isMilestone` 条件保持一致，增加 `|| newFiveHour === 100`。

## 不变的部分

- 里程碑采样归因逻辑（11% → key "10", 21% → key "20"）不变
- 多点平均校准公式不变（`avgTokens × 100 × 5 / pct`）
- 单点 fallback 公式不变（`tokens5h × 100 × 5 / fiveHour`）
- 7d% 的单调递增保障（sevenDay/sevenDayTokens 不回落）不变
- 缓存结构不变

## 验证

- 现有测试应全部通过（行为向后兼容）
- 新增场景：fiveHourPct=100 时触发全量刷新和校准
- 日志中出现 `warning=CALIBRATION_REGRESSION` 表示检测到回落并已保留旧值
