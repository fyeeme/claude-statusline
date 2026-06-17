---
description: "Configure terminal width fallback and project path display — fix the 40-char truncation issue, customize width, and adjust path depth"
allowed-tools: Read, Write, Edit, Bash, AskUserQuestion
---

# Configure claude-statusline Terminal Width & Path Display

**FIRST**: Use the Read tool to load `~/.claude/plugins/claude-statusline/config.json` if it exists.
Store the current config values (especially `terminalWidth`, `pathLevels`, `display.showProject`).

---

## Step 1: Detect Current State

Run these commands to understand the current environment:

**macOS/Linux**:
```bash
# Detect actual terminal width
echo "Terminal columns (tput): $(tput cols)"
echo "Terminal columns (env): ${COLUMNS:-unset}"
echo "CWD: $(pwd)"

# Show current config if exists
if [ -f "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/claude-statusline/config.json" ]; then
  echo "--- Current config ---"
  cat "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/claude-statusline/config.json"
fi
```

Record:
- Actual terminal width from `tput cols`
- Current `terminalWidth` config value
- Current `pathLevels` and `display.showProject`

---

## Step 2: Interactive Configuration

Use AskUserQuestion. **Ask all questions in one batch.**

### Q1: Terminal Width (PRIMARY)

The statusline subprocess cannot detect the real terminal size (`stdout.columns`/`COLUMNS` are unavailable), so `config.terminalWidth` is the authoritative width source. When unset, the HUD falls back to a narrow width and truncates aggressively.

- header: "Width"
- question: "Set the terminal width. Your terminal is currently: [show tput cols result]."
- multiSelect: false
- options with previews:
  - "Auto-detect (Recommended)" — sets terminalWidth to detected value (e.g. 120)
    Preview: `pitpat-server │ tools: 3 │ (feat/nacos_2.5.2*) │ [GLM-5.1]`
  - "80 (Standard)" — standard terminal
    Preview: `pitpat-server (feat/nacos_2.5.2*) │ [GLM-5.1]`
  - "120 (Wide)" — modern wide terminal
  - "160 (Ultra-wide)" — very wide or side panel

### Q2: Project Path Visibility
- header: "Path"
- question: "Show project path in the HUD?"
- multiSelect: false
- options:
  - "Show path (Recommended)"
  - "Hide path"

### Q3: Path Depth (only if "Show path")
- header: "Depth"
- question: "How many directory levels to show?"
- multiSelect: false
- options:
  - "1 level" (e.g., `pitpat-server`)
  - "2 levels" (e.g., `linzikg/pitpat-server`)
  - "3 levels" (e.g., `professional/linzikg/pitpat-server`)

---

## Step 3: Preview & Confirm

Show preview of HUD at different widths:
- 40: `(feat/nac... │ [GLM-5.1]`
- 80: `pitpat-server (feat/nacos_2.5.2*) │ [GLM-5.1]`
- 120: `pitpat-server │ tools: 3 │ (feat/nacos_2.5.2*) │ [GLM-5.1]`

Summarize changes and ask: "Apply these settings?"

---

## Step 4: Write Configuration

Write to `~/.claude/plugins/claude-statusline/config.json`.
**Merge with existing config** — do NOT overwrite other settings.

| Setting | Config Key | Values |
|---------|-----------|--------|
| Terminal width | `terminalWidth` | number (e.g. `80`, `120`) — authoritative width; the statusline subprocess cannot detect terminal size |
| Path visibility | `display.showProject` | `true` / `false` |
| Path depth | `pathLevels` | `1` / `2` / `3` |

---

## Step 5: Verify

```bash
cat "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/claude-statusline/config.json" | grep -E '(terminalWidth|showProject|pathLevels)'
```

Tell the user the changes are applied immediately — no restart needed.
