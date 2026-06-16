# 发布 claude-statusline 到 Claude Code Marketplace 指南

## 背景

Claude Code 插件系统是 **Git-based** 的，没有中心化注册表。通过 **Marketplace** 仓库分发插件，用户执行 `/plugin install` 安装。

## 两种发布路径

| 路径 | 适用场景 | 审核流程 |
|------|---------|---------|
| **官方 Marketplace** | 面向所有用户 | Anthropic 审核 |
| **自建 Marketplace** | 团队/社区内部分发 | 无审核，即发即用 |

---

## 一、自建 Marketplace（推荐起步方案）

### 1. 创建 Marketplace 仓库

在 GitHub 创建一个新的公开仓库（如 `fyeeme/claude-statusline-marketplace`），根目录放一个 `marketplace.json`：

```json
{
  "name": "fyeeme-marketplace",
  "owner": {
    "name": "fyeeme",
    "email": "your@email.com"
  },
  "metadata": {
    "description": "Claude Code plugins by fyeeme",
    "version": "1.0.0"
  },
  "plugins": [
    {
      "name": "claude-statusline",
      "source": {
        "source": "github",
        "repo": "fyeeme/claude-statusline"
      },
      "description": "Real-time statusline HUD for Claude Code with GLM support",
      "version": "0.0.13",
      "category": "monitoring",
      "tags": ["hud", "statusline", "monitoring", "context", "glm"]
    }
  ]
}
```

**`source` 字段说明：**

| 类型 | 格式 | 示例 |
|------|------|------|
| GitHub 仓库 | `{"source": "github", "repo": "owner/repo"}` | 默认拉 main 分支最新 |
| 指定 tag/ref | 加 `"ref": "v0.0.13"` | 锁定版本 |
| Git URL | `{"source": "url", "url": "https://..."}` | 任意 Git 仓库 |
| npm 包 | `{"source": "npm", "package": "@scope/name"}` | npm 分发 |

### 2. 确保插件仓库包含必要文件

`fyeeme/claude-statusline` 仓库根目录需要：

```
.claude-plugin/
  plugin.json          # 插件清单（必须）
commands/
  setup.md             # /claude-statusline:setup 命令
  configure.md         # /claude-statusline:configure 命令
  path.md              # /claude-statusline:path 命令
dist/                  # 编译产物（必须提交或 CI 构建）
src/                   # 源码
CLAUDE.md              # 项目说明
```

### 3. 用户安装流程

```bash
# 步骤 1: 添加 Marketplace
/plugin marketplace add fyeeme/claude-statusline-marketplace

# 步骤 2: 安装插件
/plugin install claude-statusline@fyeeme-marketplace

# 步骤 3: 运行 setup 配置 statusline
/claude-statusline:setup
```

---

## 二、官方 Anthropic Marketplace

### 提交入口

1. 打开 `https://claude.ai/settings/plugins/submit`
2. 或 `https://platform.claude.com/plugins/submit`

### 提交要求

- GitHub 公开仓库
- 完整的 `plugin.json`（至少包含 `name`）
- 清晰的 README
- MIT 或类似开源协议
- 无安全风险代码

### 审核周期

Anthropic 团队人工审核，通过后列入官方 marketplace 仓库：
`github.com/anthropics/claude-plugins-official`

---

## 三、发布前检查清单

### plugin.json 必要字段

```json
{
  "name": "claude-statusline",                    // 必须，全局唯一
  "version": "0.0.13",                     // 建议每次发版更新
  "description": "...",                    // 建议包含
  "author": { "name": "...", "url": "..." },
  "license": "MIT",
  "repository": "https://github.com/fyeeme/claude-statusline",
  "homepage": "https://github.com/fyeeme/claude-statusline",
  "commands": ["./commands/setup.md", "./commands/configure.md", "./commands/path.md"]
}
```

### 构建与验证

```bash
# 1. 编译
npm run build

# 2. 测试
npm test

# 3. 本地验证（用 --plugin-dir 模拟安装）
claude --plugin-dir .

# 4. 确认 dist/ 已生成
ls dist/index.js
```

### 发版流程

```bash
# 1. 更新版本号（package.json + plugin.json）
# 2. 提交并打 tag
git tag v0.0.13
git push origin main --tags

# 3. 更新 marketplace.json 中的 version
# 4. 提交 marketplace 仓库
```

---

## 四、版本更新机制

用户执行 `/plugin update claude-statusline` 时，Claude Code 会：

1. 从 marketplace source 拉取最新代码
2. 复制到 `~/.claude/plugins/cache/claude-statusline/claude-statusline/<version>/`
3. 重新加载插件

**建议在 marketplace.json 中使用 `ref` 锁定版本：**

```json
{
  "name": "claude-statusline",
  "source": {
    "source": "github",
    "repo": "fyeeme/claude-statusline",
    "ref": "v0.0.13"
  }
}
```

这样用户更新时会拉到指定版本，而非 main 分支最新提交。

---

## 五、运行时环境变量

插件运行时可用：

| 变量 | 说明 |
|------|------|
| `${CLAUDE_PLUGIN_ROOT}` | 插件安装目录（每次更新会变） |
| `${CLAUDE_PLUGIN_DATA}` | 持久数据目录（跨更新保留） |

当前 claude-statusline 使用 `~/.claude/plugins/claude-statusline/` 存放缓存，已兼容此机制。

---

## 六、完整操作步骤（从零到可安装）

```bash
# === 一次性设置 ===

# 1. Fork 或创建 claude-statusline 仓库（如果还没有）
git remote add origin git@github.com:fyeeme/claude-statusline.git

# 2. 创建 marketplace 仓库
# 在 GitHub 上创建 fyeeme/claude-statusline-marketplace
git clone git@github.com:fyeeme/claude-statusline-marketplace.git /tmp/marketplace
cd /tmp/marketplace

# 3. 写入 marketplace.json（见上面模板）
cat > marketplace.json << 'EOF'
{
  "name": "fyeeme-marketplace",
  "owner": { "name": "fyeeme" },
  "plugins": [
    {
      "name": "claude-statusline",
      "source": { "source": "github", "repo": "fyeeme/claude-statusline", "ref": "v0.0.13" },
      "description": "Real-time statusline HUD with GLM usage support",
      "version": "0.0.13"
    }
  ]
}
EOF

git add . && git commit -m "Add claude-statusline plugin" && git push

# === 每次发版 ===

# 4. 在 claude-statusline 仓库中更新版本、构建、测试
cd /path/to/claude-statusline
# 编辑 package.json 和 plugin.json 版本号
npm run build && npm test
git commit -am "chore: bump version to 0.0.13"
git tag v0.0.13
git push origin main --tags

# 5. 更新 marketplace 版本号
cd /tmp/marketplace
# 编辑 marketplace.json 中的 version 和 ref
git commit -am "Update claude-statusline to 0.0.13" && git push

# === 用户安装 ===

# 6. 告诉用户执行：
# /plugin marketplace add fyeeme/claude-statusline-marketplace
# /plugin install claude-statusline@fyeeme-marketplace
# /claude-statusline:setup
```
