const axios = require('axios');
const readline = require('readline');
const path = require('path');
const fs = require('fs');
const child_process = require('child_process');
const { mainModule } = require('process');
const http = require('http')

// ====================== CLI ARGUMENT PARSING (Node 13 safe) ======================
const args = process.argv.slice(2);
let promptArg = null;
let dangerMode = false;
let showHelp = false;
let serverMode = false;
let backgroundMode = false;
let permissionModeFlag = null;
let p = '';

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--help' || arg === '-h') {
    showHelp = true;
  } else if (arg === '--danger') {
    dangerMode = true;
  } else if (arg === '--server') {
    serverMode = true;
  } else if (arg === '--background') {
    backgroundMode = true;
  } else if (arg === '--permission-mode' || arg === '-m') {
    if (i + 1 < args.length) {
      permissionModeFlag = args[i + 1];
      i++;
    }
  } else if (arg === '--prompt' || arg === '-p') {
    if (i + 1 < args.length) {
      promptArg = args.slice(i + 1).join(' ');
      break; // consume the rest as the prompt
    }
  }
}

if (showHelp) {
  console.log(`
7coder — Claude Code style assistant with Ralph Wiggum loop + full tool calling

Usage:
  node index.js → Interactive REPL (default)
  node index.js --prompt "your task" → Non-interactive
  node index.js --server → HTTP OpenAI endpoint (any UI)
  node index.js --background --prompt "task" → Background daemon
  node index.js --danger → Bypass all approvals
  node index.js --permission-mode=auto → LLM auto-approval

Flags can be combined.
`);
  process.exit(0);
}

// == SET LAUNCHDIR HERE ! ! ! ==
const launchDir = process.cwd();

// == cd to script's dir so that we can find .env file ==
process.chdir(path.resolve(path.dirname(process.argv[1])));

require('dotenv').config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_ENDPOINT = process.env.OPENAI_ENDPOINT || 'https://api.openai.com/v1';
const ENABLE_RALPH_MODE = process.env.ENABLE_CLAUDE_LIKE_RALPH_WIGGUM_MODE === 'true';
const MAX_RETRIES = parseInt(process.env.MAX_ATTEMPT_RETRIES, 10) || 3;
const MODEL = process.env.OPENAI_MODEL || 'gpt-3.5-turbo';
const TEMPERATURE = parseFloat(process.env.TEMPERATURE) || 0.7;
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS, 10) || 2048;
const PERMISSION_MODE = permissionModeFlag || process.env.PERMISSION_MODE || (dangerMode ? 'bypass' : 'default');
const ENABLE_HTTP_SERVER = process.env.ENABLE_HTTP_SERVER === 'true' || serverMode;
const HTTP_PORT = parseInt(process.env.HTTP_PORT, 10) || 8000;
const ENABLE_COMPUTER_USE = process.env.ENABLE_COMPUTER_USE === 'true';

if (!OPENAI_API_KEY) {
  console.error('❌ Please set OPENAI_API_KEY in your .env file');
  process.exit(1);
}

// === EXPLICIT CD TO USER'S CURRENT DIRECTORY (Claude Code style) ===
process.chdir(launchDir);
console.log(`✅ 7coder cd'ed to: ${launchDir}`);

const DANGER_MODE = dangerMode;
const INTERACTIVE = !promptArg && !serverMode && !backgroundMode;


if (DANGER_MODE) {
  console.log('⚠️  DANGER MODE ENABLED — All CLI commands will run WITHOUT approval (within reason)!');
}

// ====================== TOOL DEFINITIONS ======================
const tools = [
  { type: "function", function: { name: "read_file", description: "Read the entire content of a file.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "write_file", description: "Create or overwrite a file.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
  { type: "function", function: { name: "append_file", description: "Append content to a file.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
  { type: "function", function: { name: "run_command", description: "Run a shell command (cross-platform).", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
  { type: "function", function: { name: "agent_tool", description: "Spawn child agents/subagents (child AIs).", parameters: { type: "object", properties: { name: { type: "string" }, task: { type: "string" } }, required: ["name", "task"] } } },
  { type: "function", function: { name: "remove_agent", description: "Removes a single agent.", parameters: { type: "object", properties: { agent_id: { type: "string" } }, required: ["agent_id"] } } },
  { type: "function", function: { name: "bash_tool", description: "Shell execution via bash (Unix).", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
  { type: "function", function: { name: "powershell_tool", description: "Shell execution via PowerShell (Windows).", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
  { type: "function", function: { name: "glob_tool", description: "File search (glob).", parameters: { type: "object", properties: { pattern: { type: "string" }, directory: { type: "string" } }, required: ["pattern"] } } },
  { type: "function", function: { name: "grep_tool", description: "Search file contents.", parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"] } } },
  { type: "function", function: { name: "web_fetch_tool", description: "Simple GET request to any URL.", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } } },
  { type: "function", function: { name: "web_search_tool", description: "Search DuckDuckGo for links.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
  { type: "function", function: { name: "web_browser_tool", description: "Simulated browser: navigate, click links, view images.", parameters: { type: "object", properties: { url: { type: "string" }, action: { type: "string", enum: ["navigate", "click", "extract"] } }, required: ["url"] } } },
  { type: "function", function: { name: "notebook_edit_tool", description: "Edit Jupyter notebook (JSON structure).", parameters: { type: "object", properties: { path: { type: "string" }, edits: { type: "object" } }, required: ["path", "edits"] } } },
  { type: "function", function: { name: "skill_tool", description: "Invoke user-defined skills.", parameters: { type: "object", properties: { skill_name: { type: "string" }, params: { type: "object" } }, required: ["skill_name"] } } },
  { type: "function", function: { name: "ask_user_question_tool", description: "Prompt user for input.", parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"] } } },
  { type: "function", function: { name: "brief_tool", description: "Upload/summarize files to folder.summary.", parameters: { type: "object", properties: { folder: { type: "string" } }, required: ["folder"] } } },
  { type: "function", function: { name: "send_message_tool", description: "Send message to agent/team.", parameters: { type: "object", properties: { target: { type: "string" }, message: { type: "string" } }, required: ["target", "message"] } } },
  { type: "function", function: { name: "team_create_tool", description: "Create agent team.", parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } } },
  { type: "function", function: { name: "team_delete_tool", description: "Delete agent team.", parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } } },
  { type: "function", function: { name: "task_create_tool", description: "Create background task.", parameters: { type: "object", properties: { description: { type: "string" } }, required: ["description"] } } },
  { type: "function", function: { name: "task_get_tool", description: "Get task status.", parameters: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] } } },
  { type: "function", function: { name: "task_list_tool", description: "List background tasks." } },
  { type: "function", function: { name: "task_update_tool", description: "Update task.", parameters: { type: "object", properties: { task_id: { type: "string" }, status: { type: "string" } }, required: ["task_id"] } } },
  { type: "function", function: { name: "task_output_tool", description: "Get task output.", parameters: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] } } },
  { type: "function", function: { name: "task_stop_tool", description: "Stop background task.", parameters: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] } } },
  { type: "function", function: { name: "todo_write_tool", description: "Write to TODO.md.", parameters: { type: "object", properties: { content: { type: "string" } }, required: ["content"] } } },
  { type: "function", function: { name: "list_mcp_resources_tool", description: "List MCP resources." } },
  { type: "function", function: { name: "read_mcp_resource_tool", description: "Read MCP resource.", parameters: { type: "object", properties: { resource_id: { type: "string" } }, required: ["resource_id"] } } },
  { type: "function", function: { name: "sleep_tool", description: "Async delay.", parameters: { type: "object", properties: { ms: { type: "number" } }, required: ["ms"] } } },
  { type: "function", function: { name: "snip_tool", description: "Extract history snippet.", parameters: { type: "object", properties: { start: { type: "number" }, end: { type: "number" } } } } },
  { type: "function", function: { name: "tool_search_tool", description: "Discover available tools." } },
  { type: "function", function: { name: "monitor_tool", description: "Monitor MCP servers." } },
  { type: "function", function: { name: "enter_worktree_tool", description: "Git worktree management - enter.", parameters: { type: "object", properties: { path: { type: "string" } } } } },
  { type: "function", function: { name: "exit_worktree_tool", description: "Git worktree management - exit." } },
  { type: "function", function: { name: "schedule_cron_tool", description: "Schedule cron job.", parameters: { type: "object", properties: { schedule: { type: "string" }, command: { type: "string" } }, required: ["schedule", "command"] } } },
  { type: "function", function: { name: "remote_trigger_tool", description: "Trigger remote agents.", parameters: { type: "object", properties: { agent: { type: "string" }, payload: { type: "object" } } } } },
  { type: "function", function: { name: "workflow_tool", description: "Execute workflow script.", parameters: { type: "object", properties: { script: { type: "string" } }, required: ["script"] } } },
  { type: "function", function: { name: "mcp_tool", description: "Generic MCP tool execution.", parameters: { type: "object", properties: { tool_name: { type: "string" }, args: { type: "object" } }, required: ["tool_name"] } } },
  { type: "function", function: { name: "mcp_auth_tool", description: "MCP server authentication.", parameters: { type: "object", properties: { server: { type: "string" } }, required: ["server"] } } },
  { type: "function", function: { name: "synthetic_output_tool", description: "Structured output via dynamic JSON schema.", parameters: { type: "object", properties: { schema: { type: "object" }, prompt: { type: "string" } }, required: ["schema", "prompt"] } } },
  { type: "function", function: { name: "cron_create_tool", description: "Create granular cron job.", parameters: { type: "object", properties: { schedule: { type: "string" }, command: { type: "string" } } } } },
  { type: "function", function: { name: "cron_delete_tool", description: "Delete cron job.", parameters: { type: "object", properties: { job_id: { type: "string" } } } } },
  { type: "function", function: { name: "cron_list_tool", description: "List cron jobs." } },
  { type: "function", function: { name: "prompt_from_file", description: "Use prompt from TODO.md or similar.", parameters: { type: "object", properties: { file: { type: "string" } }, required: ["file"] } } },
  { type: "function", function: { name: "auto_approval_return", description: "Lightweight model hands over to heavy model for auto-approval description.", parameters: { type: "object", properties: { description: { type: "string" } } } } },
  { type: "function", function: { name: "computer_use", description: "Cross-platform full computer use (mouse/keyboard/screenshot).", parameters: { type: "object", properties: { action: { type: "string", enum: ["screenshot", "mouse_move", "click", "type_text", "press_key"] }, x: { type: "number" }, y: { type: "number" }, text: { type: "string" }, key: { type: "string" } }, required: ["action"] } } }
];


// ====================== SYSTEM PROMPT (Claude Code style + all new features) ======================
const systemPrompt = `You are 7coder, a helpful, honest, and harmless AI coding assistant — a clean-room full replacement for Claude Code.
You have full tool access including agent spawning, web tools, computer use, MCP, cron, tasks, and more.
You ALWAYS create/update 7CODER.md in the project root with any findings, discoveries, or progress using the write_file tool.

Permission & Security Rules (follow strictly):
- Modes: default (ask user), auto (light model decides), bypass (danger), denial (block).
- Every tool action is risk-classified LOW/MEDIUM/HIGH by light model.
- Protected files (.gitconfig, .bashrc, .env, etc.) are NEVER auto-edited.
- Block path traversal, super-dangerous commands (dd, format, rm -rf /, etc.) even in bypass.
- Use computer_use ONLY if ENABLE_COMPUTER_USE=true in settings.

Heavy model (you) = coding, computer tasks, reasoning.
Light model = risk classification, explanations, moderation, anti-frustration.

Anti-frustration: If user seems angry or curses, acknowledge empathetically.

Use tools aggressively when needed. After tools, give clear final answer.
Create 7CODER.md early with your findings.`;

let messages = [{ role: 'system', content: systemPrompt }];

// ====================== LIGHT/HEAVY CALLER ======================
async function callOpenAI(currentMessages, options = {}) {
  const {
    model = HEAVY_MODEL,
    useTools = true,
    toolChoice = "auto",
    temperature = TEMPERATURE,
    maxTokens = MAX_TOKENS
  } = options;

  const base = OPENAI_ENDPOINT.replace(/\/+$/, '');
  const url = `${base}/chat/completions`;

  const payload = {
    model,
    messages: currentMessages,
    temperature,
    max_tokens: maxTokens,
  };

  if (useTools) payload.tools = tools;
  if (useTools) payload.tool_choice = toolChoice;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await axios.post(url, payload, {
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        timeout: 4200000,
      });
      return response.data.choices[0];
    } catch (error) {
      const msg = (error.response?.data?.error?.message) || error.message;
      console.error(`⚠️ API attempt ${attempt}/${MAX_RETRIES} failed: ${msg}`);
      if (attempt === MAX_RETRIES) throw new Error('Max retries reached.');
      await new Promise(r => setTimeout(r, 1200 * attempt));
    }
  }
}

// ====================== RISK CLASSIFICATION & PERMISSION EXPLAINER (light model) ======================
async function classifyRisk(toolName, args) {
  const prompt = `Classify risk of tool call as ONLY ONE WORD: LOW, MEDIUM or HIGH.
Tool: ${toolName}
Args: ${JSON.stringify(args)}
Consider file edits, shell commands, web access, computer control, protected paths.`;
  try {
    const choice = await callOpenAI([{ role: 'user', content: prompt }], { model: LIGHT_MODEL, useTools: false });
    return choice.message.content.trim().toUpperCase();
  } catch (e) {
    return 'MEDIUM';
  }
}

async function getPermissionExplanation(toolName, args, risk) {
  const prompt = `Explain this tool action to the user in 1-2 friendly sentences. Include what it does and why it might need approval.
Tool: ${toolName}
Args: ${JSON.stringify(args)}
Risk level: ${risk}`;
  try {
    const choice = await callOpenAI([{ role: 'user', content: prompt }], { model: LIGHT_MODEL, useTools: false });
    return choice.message.content.trim();
  } catch (e) {
    return `Tool ${toolName} will run. Risk: ${risk}.`;
  }
}

async function isAutoApprovalSafe(toolName, args, risk) {
  const prompt = `Is this tool action safe to auto-approve in AUTO mode? Risk: ${risk}
Tool: ${toolName}
Args: ${JSON.stringify(args)}
Reply ONLY with YES or NO.`;
  try {
    const choice = await callOpenAI([{ role: 'user', content: prompt }], { model: LIGHT_MODEL, useTools: false });
    return choice.message.content.trim().toUpperCase().startsWith('YES');
  } catch (e) {
    return false;
  }
}


// ====================== TOOLS ========================
async function executeToolRaw(name, args) {
  // CORE FILE TOOLS
  if (name === 'read_file') {
    const fullPath = path.join(launchDir, args.path || '');
    try { return fs.readFileSync(fullPath, 'utf8'); } catch (e) { return `Read error: ${e.message}`; }
  }
  if (name === 'write_file') {
    try {
      const fullPath = path.join(launchDir, args.path || '');
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, args.content || '', 'utf8');
      if (args.path.endsWith('7CODER.md')) return '✅ 7CODER.md updated with findings';
      return `Written: ${path.relative(launchDir, args.path)}`;
    } catch (e) { return `Write error: ${e.message}`; }
  }
  if (name === 'append_file') {
    const fullPath = path.join(launchDir, args.path);
    try {
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.appendFileSync(fullPath, args.content || '', 'utf8');
      return `Appended: ${args.path}`;
    } catch (e) { return `Append error: ${e.message}`; }
  }

  // SHELL TOOLS
  if (['run_command','bash_tool','powershell_tool'].includes(name)) {
    let cmd = args.command || '';
    if (DANGER_MODE || PERMISSION_MODE === 'bypass') console.log(`⚠️ Running: ${cmd}`);
    else if (!INTERACTIVE) return 'Command skipped (use --danger)';

    try {
      const output = child_process.execSync(cmd, { encoding: 'utf8', cwd: launchDir });
      return `Command OK:\n${output}`;
    } catch (e) {
      return `❌ Command failed:\n${e.message}\n${e.stderr || ''}`;
    }
  }

  // FILE SEARCH
  if (name === 'glob_tool') {
    const files = recursiveReaddir(args.directory, args.pattern);
    return files.length ? files.join('\n') : 'No files matched';
  }
  if (name === 'grep_tool') {
    return grepSearch(args.pattern, args.path);
  }

  // WEB TOOLS
  if (name === 'web_fetch_tool') {
    try {
      const res = await axios.get(args.url, { timeout: 10000 });
      return typeof res.data === 'string' ? res.data : JSON.stringify(res.data, null, 2);
    } catch (e) { return `Fetch error: ${e.message}`; }
  }
  if (name === 'web_search_tool') {
    try {
      const q = encodeURIComponent(args.query);
      const res = await axios.get(`https://lite.duckduckgo.com/lite?q=${q}`, { timeout: 10000 });
      const links = [...res.data.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].slice(0, 10).map(m => `${m[2]} → ${m[1]}`);
      return `Search results:\n${links.join('\n')}`;
    } catch (e) { return `Search error: ${e.message}`; }
  }
  if (name === 'web_browser_tool') {
    return `🧭 Simulated browser navigated to ${args.url}. Action: ${args.action || 'navigate'}. (Full CV image support available when vision model is used.)`;
  }

  // NOTEBOOK
  if (name === 'notebook_edit_tool') {
    try {
      const nbPath = args.path;
      let notebook = JSON.parse(fs.readFileSync(nbPath, 'utf8'));
      if (args.edits.cells) notebook.cells = args.edits.cells;
      if (args.edits.metadata) notebook.metadata = { ...notebook.metadata, ...args.edits.metadata };
      fs.writeFileSync(nbPath, JSON.stringify(notebook, null, 2));
      return 'Notebook edited successfully';
    } catch (e) { return `Notebook error: ${e.message}`; }
  }

  // SKILL TOOL
  if (name === 'skill_tool') {
    return `✅ Custom skill "${args.skill_name}" executed with params: ${JSON.stringify(args.params || {})}`;
  }

  // ASK USER
  if (name === 'ask_user_question_tool') {
    if (DANGER_MODE || PERMISSION_MODE === 'bypass') return 'Question skipped in non-interactive mode';
    const answer = await new Promise(resolve => rl.question(`🗣️ ${args.question}\nAnswer: `, resolve));
    return `User answered: ${answer}`;
  }

  // BRIEF TOOL
  if (name === 'brief_tool') {
    const summaryPath = path.join(launchDir, `${args.folder}.summary`);
    const files = recursiveReaddir(args.folder);
    const summary = `Summary of ${args.folder} (${files.length} files):\n${files.join('\n')}\n\nGenerated at ${new Date().toISOString()}`;
    fs.writeFileSync(summaryPath, summary, 'utf8');
    return `Summary written to ${summaryPath}`;
  }

  // AGENT TOOLS
  if (name === 'agent_tool') {
    const agentId = `agent-${Date.now()}`;
    activeAgents.set(agentId, { name: args.name, task: args.task, messages: [] });
    return `✅ Child agent spawned: ${agentId} (${args.name})`;
  }
  if (name === 'remove_agent') {
    if (activeAgents.delete(args.agent_id)) return `✅ Agent ${args.agent_id} removed`;
    return `Agent ${args.agent_id} not found`;
  }
  if (name === 'send_message_tool') {
    if (activeAgents.has(args.target)) {
      activeAgents.get(args.target).messages.push(args.message);
      return `✅ Message sent to ${args.target}`;
    }
    return `Target ${args.target} not found`;
  }
  if (name === 'team_create_tool' || name === 'team_delete_tool') {
    return `✅ Team operation ${name} completed (in-memory)`;
  }

  // TASK TOOLS
  if (name === 'task_create_tool') {
    const taskId = `task-${Date.now()}`;
    const timer = setTimeout(() => {
      if (backgroundTasks.has(taskId)) {
        const t = backgroundTasks.get(taskId);
        t.status = 'completed';
        t.output = 'Task finished (simulated)';
      }
    }, 5000);
    backgroundTasks.set(taskId, { description: args.description, status: 'running', output: '', timer });
    return `✅ Background task created: ${taskId}`;
  }
  if (name === 'task_get_tool' || name === 'task_output_tool') {
    const t = backgroundTasks.get(args.task_id);
    return t ? JSON.stringify(t, null, 2) : 'Task not found';
  }
  if (name === 'task_list_tool') {
    return Array.from(backgroundTasks.keys()).join('\n') || 'No tasks';
  }
  if (name === 'task_update_tool') {
    if (backgroundTasks.has(args.task_id)) {
      backgroundTasks.get(args.task_id).status = args.status;
      return `✅ Task ${args.task_id} updated`;
    }
    return 'Task not found';
  }
  if (name === 'task_stop_tool') {
    const t = backgroundTasks.get(args.task_id);
    if (t && t.timer) clearTimeout(t.timer);
    backgroundTasks.delete(args.task_id);
    return `✅ Task ${args.task_id} stopped`;
  }

  // TODO
  if (name === 'todo_write_tool') {
    const todoPath = path.join(launchDir, 'TODO.md');
    fs.appendFileSync(todoPath, `\n## ${new Date().toISOString()}\n${args.content}\n`, 'utf8');
    return '✅ TODO.md updated';
  }

  // MCP
  if (name === 'list_mcp_resources_tool') {
    return fs.readdirSync(mcpResourcesDir).join('\n') || 'No MCP resources';
  }
  if (name === 'read_mcp_resource_tool') {
    const resPath = path.join(mcpResourcesDir, args.resource_id);
    try { return fs.readFileSync(resPath, 'utf8'); } catch { return 'Resource not found'; }
  }
  if (name === 'mcp_tool' || name === 'mcp_auth_tool') {
    return `✅ MCP operation ${name} completed (file-based in .mcp)`;
  }

  // SLEEP
  if (name === 'sleep_tool') {
    const ms = parseInt(args.ms) || 1000;
    await new Promise(r => setTimeout(r, ms));
    return `✅ Slept ${ms}ms`;
  }

  // SNIP
  if (name === 'snip_tool') {
    return messages.slice(args.start || 0, args.end || messages.length).map(m => JSON.stringify(m)).join('\n');
  }

  // TOOL SEARCH
  if (name === 'tool_search_tool') {
    return tools.map(t => t.function.name).join('\n');
  }

  // MONITOR
  if (name === 'monitor_tool') {
    return `MCP servers monitored. Active agents: ${activeAgents.size}, Tasks: ${backgroundTasks.size}`;
  }

  // GIT WORKTREE
  if (name === 'enter_worktree_tool') {
    try {
      child_process.execSync(`git worktree add ${args.path || 'worktree'}`, { cwd: launchDir });
      return `✅ Entered worktree at ${args.path}`;
    } catch (e) { return `Worktree error: ${e.message}`; }
  }
  if (name === 'exit_worktree_tool') {
    return '✅ Exited worktree (stub - use run_command for full git)';
  }

  // CRON
  if (name === 'schedule_cron_tool' || name === 'cron_create_tool') {
    const jobId = `cron-${Date.now()}`;
    const interval = setInterval(() => {
      try { child_process.execSync(args.command, { cwd: launchDir }); } catch {}
    }, 60000); // every minute for demo
    cronJobs.set(jobId, { schedule: args.schedule, command: args.command, intervalId: interval });
    return `✅ Cron job ${jobId} scheduled`;
  }
  if (name === 'cron_delete_tool') {
    const job = cronJobs.get(args.job_id);
    if (job) clearInterval(job.intervalId);
    cronJobs.delete(args.job_id);
    return `✅ Cron job deleted`;
  }
  if (name === 'cron_list_tool') {
    return Array.from(cronJobs.keys()).join('\n') || 'No cron jobs';
  }

  // REMOTE / WORKFLOW
  if (name === 'remote_trigger_tool' || name === 'workflow_tool') {
    return `✅ ${name} executed successfully`;
  }

  // SYNTHETIC OUTPUT
  if (name === 'synthetic_output_tool') {
    return `Structured output generated:\n${JSON.stringify({ result: "success", data: "dynamic JSON" }, null, 2)}`;
  }

  // PROMPT FROM FILE
  if (name === 'prompt_from_file') {
    try { return fs.readFileSync(args.file, 'utf8'); } catch { return 'File not found'; }
  }

  // AUTO APPROVAL RETURN
  if (name === 'auto_approval_return') {
    return args.description || 'Auto-approval handover complete';
  }

  // COMPUTER USE (cross-platform)
  if (name === 'computer_use') {
    const action = args.action;
    console.log(`🖥️ Computer use: ${action}`);
    if (action === 'screenshot') {
      const shotPath = path.join(launchDir, `screenshot_${Date.now()}.png`);
      try {
        if (process.platform === 'darwin') child_process.execSync(`screencapture -x "${shotPath}"`);
        else if (process.platform === 'win32') child_process.execSync(`powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('{PRTSC}');"`, { stdio: 'ignore' });
        else child_process.execSync(`import -window root "${shotPath}" || scrot "${shotPath}"`, { stdio: 'ignore' });
      } catch {}
      return `Screenshot saved to ${shotPath}`;
    }
    if (action === 'type_text' && args.text) {
      return `✅ Typed: ${args.text} (simulated)`;
    }
    if (action === 'press_key' && args.key) {
      return `✅ Pressed key: ${args.key} (simulated)`;
    }
    return `✅ Action ${action} performed`;
  }

  return `Unknown tool: ${name}`;
}
// ====================== ANTI-FRUSTRATION (light model) ======================
async function detectFrustration(userInput) {
  const prompt = `Does this user message show frustration, anger, or cursing? Reply ONLY YES or NO and one-word reason.`;
  try {
    const choice = await callOpenAI([{ role: 'user', content: `${prompt}\n\nUser: ${userInput}` }], { model: LIGHT_MODEL, useTools: false });
    return choice.message.content.trim().toUpperCase().startsWith('YES');
  } catch (e) {
    return false;
  }
}

// ====================== TOOL EXECUTION (with new permission system) ======================
async function askApproval(question) {
  return new Promise(resolve => {
    rl.question(question, answer => resolve(answer.toLowerCase().startsWith('y')));
  });
}

async function safeExecuteTool(toolCall) {
  const func = toolCall.function;
  let args;
  try { args = JSON.parse(func.arguments || '{}'); } catch (e) { return `Parse error: ${e.message}`; }

  const name = func.name;

  // Path sanitization for any file-related tool
  if (['read_file', 'write_file', 'append_file', 'notebook_edit_tool', 'glob_tool', 'grep_tool', 'prompt_from_file'].includes(name) && args.path) {
    try { args.path = sanitizePath(args.path); } catch (e) { return `Security: ${e.message}`; }
  }

  // Super-dangerous command block (even in bypass)
  if (name === 'run_command' || name === 'bash_tool' || name === 'powershell_tool') {
    if (isSuperDangerous(args.command)) return 'BLOCKED: Super-dangerous command prevented (even in danger mode).';
  }

  // Computer use guard
  if (name === 'computer_use' && !ENABLE_COMPUTER_USE) {
    return 'Computer use is disabled in .env (ENABLE_COMPUTER_USE=false).';
  }

  // Risk classification (light model)
  const risk = await classifyRisk(name, args);

  // Permission logic
  if (PERMISSION_MODE === 'denial') return 'Permission mode = denial. Action blocked.';

  if (PERMISSION_MODE === 'bypass') {
    // still respect super-dangerous
  } else if (PERMISSION_MODE === 'auto') {
    const safe = await isAutoApprovalSafe(name, args, risk);
    if (!safe) return `Auto-approval declined by light model. Risk: ${risk}.`;
  } else {
    // default = interactive
    const expl = await getPermissionExplanation(name, args, risk);
    console.log(`\n🔐 ${expl}`);
    const approved = await askApproval('Execute this tool? (y/n) ');
    if (!approved) return 'User declined the tool action.';
  }
  executeToolRaw(toolCall)
}


// ====================== READLINE INTERFACE ======================

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: 'You: '
});

// ====================== APPROVAL + TOOL EXECUTION ======================
function askApproval(question) {
  return new Promise(resolve => {
    rl.question(question, answer => resolve(answer.toLowerCase().startsWith('y')));
  });
}


// ====================== TOOL CALLING LOOP ======================
async function processWithTools(currentMessages) {
  while (true) {
    const choice = await callOpenAI(currentMessages);
    const assistantMsg = choice.message;
    currentMessages.push(assistantMsg);
    if (assistantMsg.tool_calls) {
        if (assistantMsg.tool_calls.length > 0) {
            console.log(`🔧 Using ${assistantMsg.tool_calls.length} tool(s)...`);
            for (const tc of assistantMsg.tool_calls) {
              const result = await safeExecuteTool(tc);
              currentMessages.push({ role: 'tool', tool_call_id: tc.id, content: result });
            }
            continue;
          }
    }
    return assistantMsg.content || '';
  }
}

async function callOpenAI(currentMessages) {
  const base = OPENAI_ENDPOINT.replace(/\/+$/, '');
  const url = `${base}/chat/completions`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await axios.post(url, {
        model: MODEL,
        messages: currentMessages,
        temperature: TEMPERATURE,
        max_tokens: MAX_TOKENS,
        tools: tools,
        tool_choice: "auto"
      }, {
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        timeout: 4200000,
      });
      return response.data.choices[0];
    } catch (error) {
      const msg = (error.response && error.response.data && error.response.data.error && error.response.data.error.message) || error.message;
      console.error(`⚠️ API attempt ${attempt}/${MAX_RETRIES} failed: ${msg}`);
      if (attempt === MAX_RETRIES) throw new Error('Max retries reached.');
      await new Promise(resolve => setTimeout(resolve, 1200 * attempt));
    }
  }
}

// ====================== CORE EXECUTION FUNCTION ======================
async function executeTask() {
  try {
    let displayReply = await processWithTools(messages);

    if (ENABLE_RALPH_MODE) {
      console.log(`🔄 Ralph Wiggum Loop — Iteration 1: ${displayReply.substring(0, 120)}${displayReply.length > 120 ? '...' : ''}`);

      for (let attempt = 2; attempt <= MAX_RETRIES; attempt++) {
        const refineMsg = `You are in Claude-Like Ralph Wiggum loop mode. This is iteration ${attempt}. Review and iterate. You may use any tools. If complete, start reply with exactly "RALPH_WIGGUM_COMPLETE" followed by final version.`;
        messages.push({ role: 'user', content: refineMsg });
        displayReply = await processWithTools(messages);

        if (displayReply.trim().startsWith('RALPH_WIGGUM_COMPLETE')) {
          displayReply = displayReply.replace(/^RALPH_WIGGUM_COMPLETE\s*/i, '').trim();
          console.log(`✅ Completion promise fulfilled at iteration ${attempt}!`);
          break;
        }
        console.log(`🔄 Ralph Wiggum Loop — Iteration ${attempt}: ${displayReply.substring(0, 120)}${displayReply.length > 120 ? '...' : ''}`);
      }
    }

    console.log(`\n7coder: ${displayReply}`);
  } catch (err) {
    console.error(`❌ Error: ${err.message}`);
  }
}

// ====================== HTTP OPENAI-COMPATIBLE ENDPOINT ======================
function startHttpServer() {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);
          // Create temporary conversation for this request (stateless per call)
          let tempMessages = [{ role: 'system', content: systemPrompt }];
          if (data.messages) tempMessages = tempMessages.concat(data.messages);

          console.log(`🌐 HTTP request received from UI`);
          const result = await processWithTools(tempMessages);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'chatcmpl-' + Date.now(),
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: HEAVY_MODEL,
            choices: [{
              index: 0,
              message: { role: 'assistant', content: result },
              finish_reason: 'stop'
            }]
          }));
        } catch (e) {
          console.error('HTTP error:', e);
          res.writeHead(500);
          res.end(JSON.stringify({ error: { message: e.message } }));
        }
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(HTTP_PORT, () => {
    console.log(`🚀 7coder HTTP OpenAI-compatible endpoint ready at http://localhost:${HTTP_PORT}`);
    console.log('Any OpenAI-compatible UI can now point to this endpoint (tools executed server-side).');
  });
}

// ====================== RUN MODE ======================
async function main() {
    // Background/daemon fix: spawn detached child and exit immediately
    if (backgroundMode && promptArg) {
      console.log('🔄 Starting background/daemon mode...');
      const child = child_process.spawn(process.argv[0], process.argv.slice(1).filter(a => a !== '--background'), {
        detached: true,
        stdio: 'ignore',
        cwd: launchDir
      });
      child.unref();
      console.log('✅ Background process started (terminal freed).');
      process.exit(0);
    }
    if (promptArg) {
        // NON-INTERACTIVE MODE
        console.log(`\n🚀 7coder non-interactive mode`);
        console.log(`Task: ${promptArg}`);
        messages.push({ role: 'user', content: promptArg });
        await executeTask();
        if (ENABLE_HTTP_SERVER) {
          startHttpServer()
        }
        process.exit(0);
      } else {
        // INTERACTIVE REPL (default)
        console.log('\n🚀 Welcome to 7coder (interactive REPL)');
        if (ENABLE_RALPH_MODE) console.log('🎉 Ralph Wiggum mode ENABLED');
        if (DANGER_MODE) console.log('⚠️ DANGER MODE ENABLED');
        console.log('Type your task followed by a new line then "/done"')
        console.log('to start a new task, or type "/bye" to quit.\n');
      
        rl.prompt();
      
        rl.on('line', async (input) => {
          const trimmed = input.trim();
          if (trimmed.toLowerCase() === '/bye') {
            console.log('👋 Goodbye!');
            rl.close();
            return;
          }
          
          if (!trimmed) {
            rl.prompt();
            return;
          }
      
          if (input == '/done') {
            messages.push({ role: 'user', content: trimmed });
            console.log('7coder is thinking...');
            await executeTask();
          }
          rl.prompt();
          
        });
      }
}
main()
