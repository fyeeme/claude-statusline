# 安装指南

> 通过 Claude Code 插件市场（marketplace）安装 claude-statusline 的推荐流程。
> GLM / DeepSeek 用户也能用同一套流程，安装后再配置 provider 即可。

## 前置要求

- Claude Code CLI
- Node.js 18+（Windows 必须；macOS/Linux 也可用 [Bun](https://bun.sh) 加速）
- Git
- （可选）GLM 或 DeepSeek 账号——仅当需要显示第三方 provider 用量时

---

## 方式 A：通过插件市场安装（推荐）

在 Claude Code 会话内依次执行。这是官方推荐的标准流程，会自动克隆仓库到插件缓存目录、注册命令、并让你用 `/claude-statusline:setup` 一键写入 `statusLine` 配置。

### 第 1 步：添加市场源

```
/plugin marketplace add fyeeme/claude-statusline
```

### 第 2 步：安装插件

<details>
<summary><strong>⚠️ Linux 用户：先看这里</strong></summary>

Linux 上 `/tmp` 经常是独立的 tmpfs 文件系统，会导致安装失败：

```
EXDEV: cross-device link not permitted
```

**解决**：安装前设置 `TMPDIR` 指向与 home 同一文件系统的目录：

```bash
mkdir -p ~/.cache/tmp && TMPDIR=~/.cache/tmp claude
```

然后在该会话中执行下面的安装命令。这是 [Claude Code 平台限制](https://github.com/anthropics/claude-code/issues/14799)。

</details>

```
/plugin install claude-statusline
```

安装后重载插件：

```
/reload-plugins
```

### 第 3 步：配置 statusLine

```
/claude-statusline:setup
```

`setup` 命令会自动检测运行时（bun/node）、找到已安装的最新版本、并把 `statusLine` 命令写入 `~/.claude/settings.json`。命令本身包含终端宽度探测（通过 `COLUMNS` / `stty size`），所以**通常无需手动设置 `terminalWidth`**。

<details>
<summary><strong>Windows 用户：如果提示找不到 JavaScript 运行时</strong></summary>

Windows 仅支持 Node.js（不支持 Bun）。若 setup 提示找不到运行时，先装 Node.js LTS：

```powershell
winget install OpenJS.NodeJS.LTS
```

重启终端后再运行 `/claude-statusline:setup`。

</details>

### 第 4 步：重启 Claude Code

完全退出 Claude Code 后重新启动，HUD 即会出现在输入框下方。

> **提示**：`setup` 写入的 `statusLine` 命令是「动态版本查找」格式——插件更新后自动指向最新版本，无需重新跑 setup。

---

## 方式 B：配置第三方 Provider（GLM / DeepSeek）

本 fork 的核心价值是原生支持 GLM 和 DeepSeek 用量追踪。Provider 通过 `ANTHROPIC_BASE_URL` **自动检测**，无需额外开关。

### 通过 Claude Code 的 `env` 配置（推荐）

编辑 `~/.claude/settings.json`，把 provider 凭据放进 `env` 段：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://open.bigmodel.cn/api/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "<your-glm-or-deepseek-key>"
  }
}
```

常见 provider 的 `ANTHROPIC_BASE_URL`：

| Provider | BASE_URL |
|----------|----------|
| GLM（bigmodel.cn） | `https://open.bigmodel.cn/api/anthropic` |
| GLM（Z.ai） | `https://api.z.ai/api/anthropic` |
| DeepSeek | `https://api.deepseek.com/anthropic` |
| Anthropic（默认） | 不设置 |

> **注意**：`ANTHROPIC_AUTH_TOKEN` 是 provider 自己的 API Key，不是 Anthropic 的。

### 通过 shell 环境变量（替代）

也可以在启动 Claude Code 前导出：

```bash
export ANTHROPIC_BASE_URL="https://open.bigmodel.cn/api/anthropic"
export ANTHROPIC_AUTH_TOKEN="your-glm-key"
claude
```

---

## 可选：手动设置终端宽度（`terminalWidth`）

statusline 子进程无法读取终端真实宽度（`stdout.columns` 和 `COLUMNS` 在子进程中均不可用）。`/claude-statusline:setup` 生成的命令已内置宽度探测，**大多数情况无需手动设置**。

仅当出现以下情况时，手动设置 `terminalWidth`：

- HUD 内容被截断或换行异常
- 你用的是自定义/非标准 statusLine 命令（未跑 setup）

编辑 `~/.claude/plugins/claude-statusline/config.json`：

```json
{
  "terminalWidth": 100
}
```

设为你的终端实际列数（如 `80`、`100`、`120`）。设为 `null` 或不设则回退到 setup 命令的探测结果。

---

## 更新已安装的插件

### 通过 Claude Code 更新（推荐）

插件市场安装后，更新自动进行——`setup` 写入的命令会动态查找最新版本。拉取新版本：

```
/plugin marketplace update claude-statusline
```

然后重载：

```
/reload-plugins
```

### 开发者：从 fork 源码同步更新

如果你在本地 fork 仓库开发，并想把改动同步到已安装的插件缓存目录：

```bash
# 1. 在 fork 目录构建
cd /path/to/your/claude-statusline
npm run build

# 2. 用 deploy.sh 同步到插件缓存（自动找最新版本目录）
bash deploy.sh

# 3. 重启 Claude Code
```

`deploy.sh` 会编译并把 `src/` 和 `dist/` 同步到 `~/.claude/plugins/cache/<marketplace>/claude-statusline/<version>/`。它同时兼容 `claude-statusline` 和旧名 `claude-hud` 的安装路径。

---

## 验证安装

启动 Claude Code 后，输入框下方应出现类似：

```
my-project (main*) │ [Opus]
Context 45% (90k/200k) │ Usage 25% (1h 30m / 5h)
```

GLM/DeepSeek 用户会额外看到用量窗口与账户余额。

---

## 故障排除

### HUD 不显示

1. 确认 `/claude-statusline:setup` 已运行（检查 `~/.claude/settings.json` 是否有 `statusLine` 配置）
2. 完全退出并重启 Claude Code（不是新建会话）
3. 手动测试命令：`echo '{}' | node <plugin_dir>/dist/index.js`

### 内容被截断 / 换行异常

设置 `config.json` 的 `terminalWidth` 为终端实际宽度（见上文「手动设置终端宽度」）。

### 用量（5h / 7d / 余额）不显示

1. 确认 `ANTHROPIC_BASE_URL` 指向 GLM 或 DeepSeek 域名
2. 确认 `ANTHROPIC_AUTH_TOKEN` 有效
3. 清缓存重试：`rm -f ~/.claude/plugins/claude-statusline/.usage-cache.json`

### Linux 安装报 `EXDEV` 错误

见「第 2 步」的 Linux 折叠说明——设置 `TMPDIR=~/.cache/tmp` 后重装。

### 插件未加载

确认 `~/.claude/settings.json` 同时包含：
- `enabledPlugins` 中的 `"claude-statusline@claude-statusline": true`
- `extraKnownMarketplaces` 中的 `claude-statusline` 市场源

（正常通过 `/plugin install` 安装会自动写入这两项。）
