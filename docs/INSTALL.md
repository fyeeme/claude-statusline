# Claude Statusline (GLM Fork) 安装指南

> 适用于未安装原版 claude-statusline 的用户，直接安装我们的 fork 版本。

## 前置要求

- Claude Code CLI
- Git
- Node.js 18+ 或 Bun
- GLM 平台账号（Z.ai / bigmodel.cn）

## 安装步骤

### 1. 克隆 fork 仓库

```bash
git clone https://github.com/fyeeme/claude-statusline.git ~/.claude/plugins/cache/claude-statusline
cd ~/.claude/plugins/cache/claude-statusline
```

### 2. 构建项目

```bash
npm install
npm run build
```

### 3. 配置 Claude Code

编辑 `~/.claude/settings.json`，添加以下内容：

#### 3a. 注册插件市场源

在 `extraKnownMarketplaces` 中添加：

```json
{
  "extraKnownMarketplaces": {
    "claude-statusline": {
      "source": {
        "source": "github",
        "repo": "fyeeme/claude-statusline"
      }
    }
  }
}
```

#### 3b. 启用插件

在 `enabledPlugins` 中添加：

```json
{
  "enabledPlugins": {
    "claude-statusline@claude-statusline": true
  }
}
```

#### 3c. 配置 statusLine 命令

在 `settings.json` 中添加 `statusLine` 配置。

**方案 A：使用 bun 直接运行 TypeScript（推荐）**

```json
{
  "statusLine": {
    "type": "command",
    "command": "bash -c 'glm_env=$(mktemp); printf \"%s\\n\" \"ANTHROPIC_BASE_URL=${ANTHROPIC_BASE_URL:-}\" \"ANTHROPIC_AUTH_TOKEN=${ANTHROPIC_AUTH_TOKEN:-}\" > \"$glm_env\"; plugin_dir=$(ls -d \"${CLAUDE_CONFIG_DIR:-$HOME/.claude}\"/plugins/cache/claude-statusline/*/ 2>/dev/null | sort -t/ -k1,1 | tail -1); if [ -z \"$plugin_dir\" ]; then plugin_dir=\"${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/claude-statusline/\"; fi; exec \"$(which bun || which node)\" --env-file \"$glm_env\" \"${plugin_dir}src/index.ts\"; rm -f \"$glm_env\"'"
  }
}
```

> **注意**：statusLine 命令通过 `--env-file "$glm_env"` 将 GLM 认证变量传递给 bun，确保 HUD 能获取用量数据。

**方案 B：使用构建后的 dist 文件（不需要 bun）**

```json
{
  "statusLine": {
    "type": "command",
    "command": "bash -c 'glm_env=$(mktemp); printf \"%s\\n\" \"ANTHROPIC_BASE_URL=${ANTHROPIC_BASE_URL:-}\" \"ANTHROPIC_AUTH_TOKEN=${ANTHROPIC_AUTH_TOKEN:-}\" > \"$glm_env\"; plugin_dir=\"${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/claude-statusline/\"; exec node --env-file \"$glm_env\" \"${plugin_dir}dist/index.js\"; rm -f \"$glm_env\"'"
  }
}
```

#### 3d. 配置 GLM 环境变量

在 `settings.json` 的 `env` 中添加（示例为 bigmodel.cn）：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://open.bigmodel.cn/api/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "<your-glm-api-token>"
  }
}
```

> **注意：** `ANTHROPIC_AUTH_TOKEN` 是 GLM 的 API Key，不是 Anthropic 的。

### 4. 重启 Claude Code

完全退出 Claude Code 后重新启动，statusLine 即会生效。

## 验证安装

启动 Claude Code 后，在终端顶部应看到类似如下的 HUD 显示：

```
[GLM-5.1] | project-name git:(branch*)
Context ██░░░░░░ 29% | Usage ██░░░░░░ 24% (5h) | 7d █░░░░░░░ 15% (347M / 7d)
2 CLAUDE.md | 6 MCPs | 3 hooks
```

## 覆盖更新（已有安装）

当 fork 仓库有新改动，需要更新已安装的 HUD 时：

### 方式一：直接在 fork 目录更新（推荐）

fork 仓库直接放在插件缓存目录，编译后立即生效：

```bash
# 1. 进入 fork 仓库目录
cd ~/.claude/plugins/cache/claude-statusline

# 2. 拉取最新代码
git pull

# 3. 重新构建
npm run build

# 4. 重启 Claude Code 即可生效
```

### 方式二：从外部仓库同步

如果 fork 仓库在其他位置开发，需要将编译产物同步到插件缓存目录：

```bash
# 1. 在开发目录构建
cd /path/to/your/claude-statusline
npm run build

# 2. 同步源码和编译产物到插件缓存
#    注意：src/ 和 dist/ 都需要同步，因为 statusLine 使用 bun 运行 src/
rsync -av --delete \
  src/ dist/ package.json \
  ~/.claude/plugins/cache/claude-statusline/

# 3. 重启 Claude Code 即可生效
```

### 方式三：全量覆盖（适合大改动）

```bash
# 1. 在开发目录构建
cd /path/to/your/claude-statusline
npm run build

# 2. 删除旧的 fork 目录并重新克隆/复制
rm -rf ~/.claude/plugins/cache/claude-statusline
cp -r /path/to/your/claude-statusline ~/.claude/plugins/cache/claude-statusline

# 3. 安装依赖（如果 node_modules 不在复制范围内）
cd ~/.claude/plugins/cache/claude-statusline
npm install --production

# 4. 重启 Claude Code
```

> **提示**：如果 HUD 不更新，检查 `settings.json` 中 `statusLine` 命令指向的路径是否正确（`claude-statusline` vs `claude-statusline/claude-statusline/<version>`）。

## GLM 用量显示说明

| 显示项 | 含义 |
|--------|------|
| `5h` | 滚动 5 小时窗口用量百分比 |
| `7d` | 估算 7 天用量百分比 |
| `347M / 7d` | 7 天累计使用 token 数（向下取整） |

## 故障排除

### HUD 不显示

1. 检查 `statusLine` 命令中的路径是否正确
2. 确认 bun 或 node 可在 bash 环境中访问
3. 手动测试：`echo '{}' | bun <plugin_dir>src/index.ts`

### 用量不显示

1. 确认 `ANTHROPIC_BASE_URL` 指向 GLM 域名（`open.bigmodel.cn` 或 `api.z.ai`）
2. 确认 `ANTHROPIC_AUTH_TOKEN` 有效
3. 检查 statusLine 命令中是否包含 `--env-file "$glm_env"` 传递认证变量
4. 清除缓存：`rm -f ~/.claude/plugins/claude-statusline/.usage-cache.json`

### 插件未加载

确认 `settings.json` 中同时包含：
- `enabledPlugins` 中的 `claude-statusline@claude-statusline`
- `extraKnownMarketplaces` 中的市场源配置

### 更新后无变化

1. 确认 `npm run build` 成功（无编译错误）
2. 确认 `src/` 目录已同步到插件缓存目录
3. 完全退出并重启 Claude Code（不是新建会话）

## 相比原版的改动

- 自动检测 GLM 平台（通过 `ANTHROPIC_BASE_URL`）
- 从 GLM API 获取 5h/7d 用量数据
- 支持 bigmodel.cn 和 z.ai 两种 API 响应格式
- 7 天用量估算：`7d_pct = (7d_tokens * 5h_pct) / (24h_tokens * 7)`
- 文件缓存 + TTL 机制（5 分钟缓存，45-75s 错误重试）
- 统一使用英文 `|` 分隔符（单空格），降低宽度占用
- Bar 宽度 0.8 缩放，保持上下文和用量条视觉一致且防止换行
- token 数量向下取整（如 347.8M → 347M）
- statusLine 通过 `--env-file` 传递 GLM 认证变量，避免环境变量丢失
