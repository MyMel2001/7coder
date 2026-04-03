# 7coder
**Full clean-room Claude Code replacement** for Windows 7 / Node.js 13+.

**v2.1.0** — All tools are now 100% functional (agents, computer use, MCP, cron, background tasks, web tools, etc.)

## System Requirements

- **OS**: Windows 7 SP1 or later (also works on Windows 10/11, macOS, Linux)
- **Node.js**: v13.14.0 or higher
- **RAM**: 2 GB minimum (4 GB+ recommended for heavy models)
- **Disk Space**: 500 MB free
- **Internet**: Required for online OpenAI compatible API endpoint (or LAN for one on the local network)

## Cheat Sheet

**Interactive REPL (default)**
```bash
 index.js
```

**One-shot task (non-interactive)**
```bash
 index.js --prompt "Create a todo list app in React with localStorage"
 # Short form
 index.js -p "Build a simple HTTP server in Node"
```

**HTTP OpenAI-compatible endpoint** (use with Cursor, Windsurf, Continue.dev, etc.)
```bash
 index.js --server
 # or set ENABLE_HTTP_SERVER=true in .env
```

**Background / daemon mode** (frees your terminal)
```bash
 index.js --background --prompt "Refactor the entire backend"
```

**Permission mode control**
```bash
 index.js --permission-mode=auto     # Light model decides approvals
 index.js --permission-mode=bypass   # Same as --danger
 index.js --permission-mode=denial   # Block everything
```

**Danger mode (no confirmations)**
```bash
 index.js --danger --prompt "Install dependencies and run tests"
```

**Help**
```bash
 index.js --help
```

## How Tools Work

7coder has **full tool calling** with 40+ production-ready tools:

- `read_file` / `write_file` / `append_file`
- `run_command` / `bash_tool` / `powershell_tool`
- `glob_tool` / `grep_tool` (fast file search)
- `web_fetch_tool` / `web_search_tool` / `web_browser_tool`
- `computer_use` (screenshot, mouse, keyboard — cross-platform)
- `agent_tool` / `remove_agent` (spawn child AIs)
- Background tasks, cron jobs, MCP resources, git worktrees
- Notebook editing, skill tools, TODO.md, 7CODER.md auto-generation, etc.

**All tools are fully functional** — no stubs.

In **default** mode the AI asks for confirmation on risky actions.  
In **`--danger`** or **`--permission-mode=bypass`** it runs instantly.  
Even in bypass mode, super-dangerous commands (`rm -rf /`, `format`, `dd`, etc.) are still blocked.

**Every tool action is risk-classified** by the light model (`LOW` / `MEDIUM` / `HIGH`).

## New Permission & Security System

| Mode       | Behavior                                      |
|------------|-----------------------------------------------|
| `default`  | Interactive y/n prompts (recommended)         |
| `auto`     | Light model decides approvals automatically   |
| `bypass`   | No approvals (same as `--danger`)             |
| `denial`   | Block every tool call                         |

Protected files (`.env`, `.gitconfig`, `package.json`, etc.) can **never** be auto-edited.  
Path traversal and dangerous commands are blocked at every level.

## New "Computer Use" Feature

Enable with `ENABLE_COMPUTER_USE=true` in `.env`.  
Gives the AI real mouse/keyboard/screenshot control on Windows 7, Windows 10/11, macOS, and Linux.

## Other Killer Features

- **7CODER.md** — AI automatically creates and updates this file in the project root with all findings and progress.
- **Ralph Wiggum self-iteration loop** — still available (`ENABLE_RALPH_MODE=true`)
- **Anti-frustration system** — detects when you’re mad and makes the model extra calm/helpful
- **HTTP OpenAI endpoint** — works with any UI (Open WebUI, VS Code w/ Cline, etc.)
- **In-memory agents, background tasks, cron jobs, MCP resources** — fully working
- **Light model** for risk checks, explanations, and moderation (saves tokens)

## Compatibility

- Node.js 13.14.0 → latest (no modern JS syntax used)
- Windows 7 SP1 → Windows 11, macOS, Linux
- Any OpenAI-compatible API (OpenAI, Groq, local LLMs, etc.)

## Why 7coder?

Because real Claude Code is expensive and doesn’t run on Windows 7.  
This is the **free, broad-compatibility, semi-open** version that delivers almost everything Claude Code does — with better security controls and zero proprietary code.

Vibe-coded with love (and a lot of Windows 7 debugging) by NodeMixaholic.  
Enjoy my hard work.
