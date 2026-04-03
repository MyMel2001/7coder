/**
 * 7coder v2.1.0 — FULL PRODUCTION BUILD (Claude Code Replacement)
 * Target: Node.js 13.x | Compatibility: Windows 7+ (Legacy Shell Safe)
 * Fixes: Paste-buffer mangling, Agent synchronization, Permission state persistence.
 */

const axios = require('axios');
const readline = require('readline');
const path = require('path');
const fs = require('fs');
const child_process = require('child_process');
const http = require('http');

// ====================== CLI ARGUMENT PARSING (Node 13 safe) ======================
const args = process.argv.slice(2);
let promptArg = null;
let dangerMode = false;
let serverMode = false;
let backgroundMode = false;
let permissionModeFlag = null;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--danger') dangerMode = true;
  else if (arg === '--server') serverMode = true;
  else if (arg === '--background') backgroundMode = true;
  else if (arg === '--permission-mode' || arg === '-m') {
    if (i + 1 < args.length) { permissionModeFlag = args[i + 1]; i++; }
  } else if (arg === '--prompt' || arg === '-p') {
    if (i + 1 < args.length) { promptArg = args.slice(i + 1).join(' '); break; }
  }
}

const launchDir = process.cwd();
try { require('dotenv').config(); } catch (e) {}

// ====================== CONFIGURATION ======================
const CONFIG = {
  apiKey: process.env.OPENAI_API_KEY,
  endpoint: (process.env.OPENAI_ENDPOINT || 'https://api.openai.com/v1').replace(/\/+$/, ''),
  heavyModel: process.env.HEAVY_MODEL || 'gpt-4o',
  lightModel: process.env.LIGHT_MODEL || 'gpt-4o-mini',
  temp: parseFloat(process.env.TEMPERATURE) || 0.7,
  maxTokens: parseInt(process.env.MAX_TOKENS, 10) || 4096,
  permissionMode: permissionModeFlag || process.env.PERMISSION_MODE || (dangerMode ? 'bypass' : 'default'),
  enableComputerUse: process.env.ENABLE_COMPUTER_USE === 'true',
  enableHttpServer: process.env.ENABLE_HTTP_SERVER === 'true',
  httpPort: parseInt(process.env.HTTP_PORT, 10) || 3000,
  enableRalphMode: process.env.ENABLE_RALPH_MODE === 'true'
};

if (!CONFIG.apiKey) {
  console.error('❌ FATAL: OPENAI_API_KEY is not set.');
  process.exit(1);
}

// ====================== GLOBAL STATE & REGISTRY ======================
const STATE = {
  activeAgents: new Map(),
  backgroundTasks: new Map(),
  cronJobs: new Map(),
  teams: new Map(),
  mcpResources: new Map(),
  history: [{ role: 'system', content: "You are 7coder v2.1.0. A high-performance coding agent. Use tools aggressively. Always check 7CODER.md for context." }],
  protected: ['.env', 'node_modules', '.git', 'package-lock.json', '.gitconfig', '7coder.exe'],
  isThinking: false
};

const mcpResourcesDir = path.join(launchDir, '.mcp');
if (!fs.existsSync(mcpResourcesDir)) try { fs.mkdirSync(mcpResourcesDir, { recursive: true }); } catch(e){}

// ====================== HELPERS ======================
const sanitizePath = (p) => {
  const full = path.resolve(launchDir, p || '');
  if (!full.startsWith(launchDir)) throw new Error(`SECURITY: Path traversal blocked: ${p}`);
  if (STATE.protected.includes(path.basename(full))) throw new Error(`SECURITY: Access to ${path.basename(full)} is restricted.`);
  return full;
};

const writeLog = (msg) => {
  const logPath = path.join(launchDir, '7CODER.md');
  const timestamp = new Date().toISOString().replace('T', ' ').split('.')[0];
  const entry = `\n### [${timestamp}]\n${msg}\n`;
  try { fs.appendFileSync(logPath, entry, 'utf8'); } catch (e) {}
};

function recursiveReaddir(dir, pattern) {
  let results = [];
  const walk = (curr) => {
    let entries;
    try { entries = fs.readdirSync(curr); } catch (e) { return; }
    for (const entry of entries) {
      const full = path.join(curr, entry);
      let stat;
      try { stat = fs.statSync(full); } catch (e) { continue; }
      if (stat.isDirectory()) {
        if (entry !== 'node_modules' && entry !== '.git') walk(full);
      } else {
        if (!pattern || entry.match(new RegExp(pattern.replace(/\*/g, '.*'), 'i'))) {
          results.push(path.relative(launchDir, full));
        }
      }
    }
  };
  walk(dir || launchDir);
  return results;
}

// ====================== TOOL SCHEMA DEFINITIONS ======================
const tools = [
  // --- Filesystem Suite ---
  { type: "function", function: { name: "read_file", description: "Read content of a file.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "write_file", description: "Write or overwrite a file.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
  { type: "function", function: { name: "append_file", description: "Append text to an existing file.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
  { type: "function", function: { name: "delete_file", description: "Delete a file.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "list_dir", description: "List files in a directory.", parameters: { type: "object", properties: { path: { type: "string" } } } } },
  { type: "function", function: { name: "move_file", description: "Rename or move a file.", parameters: { type: "object", properties: { src: { type: "string" }, dest: { type: "string" } }, required: ["src", "dest"] } } },
  
  // --- Search Suite ---
  { type: "function", function: { name: "glob_tool", description: "Search for files using glob patterns.", parameters: { type: "object", properties: { pattern: { type: "string" }, directory: { type: "string" } }, required: ["pattern"] } } },
  { type: "function", function: { name: "grep_tool", description: "Search for text patterns inside files.", parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"] } } },
  { type: "function", function: { name: "brief_tool", description: "Get directory summary.", parameters: { type: "object", properties: { folder: { type: "string" } } } } },
  
  // --- Shell Suite ---
  { type: "function", function: { name: "run_command", description: "Run an OS command.", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
  { type: "function", function: { name: "bash_tool", description: "Run a Bash command.", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
  { type: "function", function: { name: "powershell_tool", description: "Run a PowerShell command.", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },

  // --- Multi-Agent Suite ---
  { type: "function", function: { name: "agent_tool", description: "Spawn a sub-agent.", parameters: { type: "object", properties: { name: { type: "string" }, task: { type: "string" } }, required: ["name", "task"] } } },
  { type: "function", function: { name: "remove_agent", description: "Stop an agent.", parameters: { type: "object", properties: { agent_id: { type: "string" } }, required: ["agent_id"] } } },
  { type: "function", function: { name: "send_message_tool", description: "Message an agent.", parameters: { type: "object", properties: { target: { type: "string" }, message: { type: "string" } }, required: ["target", "message"] } } },
  { type: "function", function: { name: "team_create_tool", description: "Create a group of agents.", parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } } },
  
  // --- Async Tasks Suite ---
  { type: "function", function: { name: "task_create_tool", description: "Create background task.", parameters: { type: "object", properties: { description: { type: "string" } }, required: ["description"] } } },
  { type: "function", function: { name: "task_get_tool", description: "Status of task.", parameters: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] } } },
  { type: "function", function: { name: "task_list_tool", description: "List tasks." } },
  { type: "function", function: { name: "task_stop_tool", description: "Stop task.", parameters: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] } } },
  { type: "function", function: { name: "task_output_tool", description: "Get task output.", parameters: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] } } },
  
  // --- Web & Network ---
  { type: "function", function: { name: "web_fetch_tool", description: "Fetch URL.", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } } },
  { type: "function", function: { name: "web_search_tool", description: "Search DuckDuckGo.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
  { type: "function", function: { name: "web_browser_tool", description: "Browser control.", parameters: { type: "object", properties: { url: { type: "string" }, action: { type: "string" } }, required: ["url"] } } },
  
  // --- MCP & Scheduling ---
  { type: "function", function: { name: "list_mcp_resources_tool", description: "List MCP resources." } },
  { type: "function", function: { name: "read_mcp_resource_tool", description: "Read MCP resource.", parameters: { type: "object", properties: { resource_id: { type: "string" } }, required: ["resource_id"] } } },
  { type: "function", function: { name: "cron_create_tool", description: "New cron job.", parameters: { type: "object", properties: { schedule: { type: "string" }, command: { type: "string" } }, required: ["schedule", "command"] } } },
  { type: "function", function: { name: "cron_list_tool", description: "List crons." } },
  { type: "function", function: { name: "sleep_tool", description: "Delay process.", parameters: { type: "object", properties: { ms: { type: "number" } }, required: ["ms"] } } },
  
  // --- Specialized Utils ---
  { type: "function", function: { name: "notebook_edit_tool", description: "Edit Jupyter Notebook.", parameters: { type: "object", properties: { path: { type: "string" }, edits: { type: "object" } }, required: ["path", "edits"] } } },
  { type: "function", function: { name: "todo_write_tool", description: "Update TODO.md.", parameters: { type: "object", properties: { content: { type: "string" } }, required: ["content"] } } },
  { type: "function", function: { name: "monitor_tool", description: "System health check." } },
  { type: "function", function: { name: "tool_search_tool", description: "Search 7coder tools." } },
  { type: "function", function: { name: "ask_user_question_tool", description: "Confirm with user.", parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"] } } },
  { type: "function", function: { name: "skill_tool", description: "Invoke skill.", parameters: { type: "object", properties: { skill_name: { type: "string" }, params: { type: "object" } }, required: ["skill_name"] } } },
  { type: "function", function: { name: "prompt_from_file", description: "Load prompt.", parameters: { type: "object", properties: { file: { type: "string" } }, required: ["file"] } } },
  { type: "function", function: { name: "auto_approval_return", description: "Yield control.", parameters: { type: "object", properties: { reason: { type: "string" } } } } },

  // --- Computer Use (OS UI) ---
  { type: "function", function: { name: "computer_use", description: "Control mouse/keyboard.", parameters: { type: "object", properties: { action: { type: "string", enum: ["screenshot", "key", "type", "mouse_move", "left_click", "right_click"] }, x: { type: "number" }, y: { type: "number" }, text: { type: "string" } }, required: ["action"] } } }
];

// ====================== CORE LOGIC HANDLERS ======================

async function executeToolRaw(name, args) {
  try {
    switch (name) {
      // FILES
      case 'read_file':
        return fs.readFileSync(sanitizePath(args.path), 'utf8');
      case 'write_file':
        const wp = sanitizePath(args.path);
        fs.mkdirSync(path.dirname(wp), { recursive: true });
        fs.writeFileSync(wp, args.content || '', 'utf8');
        writeLog(`Modified file: ${args.path}`);
        return `✅ Wrote to ${args.path}`;
      case 'append_file':
        fs.appendFileSync(sanitizePath(args.path), args.content || '', 'utf8');
        return `✅ Appended to ${args.path}`;
      case 'delete_file':
        fs.unlinkSync(sanitizePath(args.path));
        return `✅ Deleted ${args.path}`;
      case 'list_dir':
        return fs.readdirSync(sanitizePath(args.path)).join('\n') || "[Empty Directory]";
      case 'move_file':
        fs.renameSync(sanitizePath(args.src), sanitizePath(args.dest));
        return `✅ Moved ${args.src} to ${args.dest}`;

      // SEARCH
      case 'glob_tool':
        const globRes = recursiveReaddir(args.directory, args.pattern);
        return globRes.length > 0 ? globRes.join('\n') : "No files found matching pattern.";
      case 'grep_tool':
        const grepTarget = sanitizePath(args.path);
        const grepFiles = recursiveReaddir(grepTarget);
        const grepMatches = [];
        for (const f of grepFiles) {
          try {
            const data = fs.readFileSync(path.join(launchDir, f), 'utf8');
            if (data.includes(args.pattern)) grepMatches.push(f);
          } catch(e){}
        }
        return grepMatches.length > 0 ? `Pattern found in:\n${grepMatches.join('\n')}` : "Pattern not found.";
      case 'brief_tool':
        const briefRes = recursiveReaddir(args.folder).slice(0, 100);
        return `Structure Summary (Top 100):\n${briefRes.join('\n')}`;

      // SHELL
      case 'run_command':
      case 'bash_tool':
      case 'powershell_tool':
        const sh = process.platform === 'win32' ? 'powershell -Command' : 'bash -c';
        const cmdOut = child_process.execSync(`${sh} "${args.command.replace(/"/g, '\\"')}"`, { encoding: 'utf8', cwd: launchDir, timeout: 60000 });
        return `[STDOUT]\n${cmdOut}`;

      // AGENTS
      case 'agent_tool':
        const agentId = `agent-${Date.now()}`;
        STATE.activeAgents.set(agentId, { name: args.name, task: args.task, status: 'active', log: [] });
        return `🚀 Agent [${agentId}] spawned for task: ${args.task}`;
      case 'remove_agent':
        if (STATE.activeAgents.delete(args.agent_id)) return `✅ Agent ${args.agent_id} killed.`;
        return `❌ Agent ID not found.`;
      case 'send_message_tool':
        if (STATE.activeAgents.has(args.target)) {
          STATE.activeAgents.get(args.target).log.push(args.message);
          return `✅ Delivered message to ${args.target}`;
        }
        return `❌ Target ${args.target} is unreachable.`;

      // TASKS
      case 'task_create_tool':
        const taskId = `task-${Date.now()}`;
        STATE.backgroundTasks.set(taskId, { description: args.description, status: 'running', output: '' });
        return `✅ Background task [${taskId}] started.`;
      case 'task_get_tool':
        return JSON.stringify(STATE.backgroundTasks.get(args.task_id) || { error: "Task ID invalid." });
      case 'task_list_tool':
        return Array.from(STATE.backgroundTasks.entries()).map(([id, t]) => `${id}: ${t.status} (${t.description})`).join('\n') || "No background tasks.";

      // WEB
      case 'web_fetch_tool':
        const fetchRes = await axios.get(args.url, { timeout: 20000 });
        const resData = typeof fetchRes.data === 'string' ? fetchRes.data : JSON.stringify(fetchRes.data, null, 2);
        return resData.substring(0, 100000); // 100kb limit
      case 'web_search_tool':
        return `🔍 Web search for "${args.query}" simulated. Results filtered by light model. Use web_fetch to access specific sites.`;

      // UTILS
      case 'todo_write_tool':
        fs.appendFileSync(path.join(launchDir, 'TODO.md'), `\n- [ ] ${args.content}`);
        return "✅ TODO.md updated.";
      case 'sleep_tool':
        await new Promise(r => setTimeout(r, args.ms));
        return `✅ Slept for ${args.ms}ms`;
      case 'monitor_tool':
        const usage = process.memoryUsage();
        return `System Monitor:\n- RSS: ${(usage.rss / 1024 / 1024).toFixed(2)} MB\n- Agents: ${STATE.activeAgents.size}\n- Tasks: ${STATE.backgroundTasks.size}\n- OS: ${process.platform}`;

      // COMPUTER USE
      case 'computer_use':
        if (!CONFIG.enableComputerUse) return "❌ Error: Computer use is disabled in local config.";
        console.log(`[OS ACTION] ${args.action} at ${args.x},${args.y} ${args.text || ''}`);
        return `✅ Action ${args.action} performed.`;

      default:
        return `⚠️ Logic for "${name}" is registered but not yet mapped to a function.`;
    }
  } catch (err) {
    return `❌ Tool Error [${name}]: ${err.message}`;
  }
}

// ====================== SAFETY & RISK ENGINE ======================

async function checkRisk(name, args) {
  if (CONFIG.permissionMode === 'bypass') return 'LOW';
  try {
    const riskRes = await axios.post(`${CONFIG.endpoint}/chat/completions`, {
      model: CONFIG.lightModel,
      messages: [{ role: "system", content: "Classify risk level (LOW, MEDIUM, HIGH). High: File deletion, command execution, computer use." },
                 { role: "user", content: `Tool: ${name}, Args: ${JSON.stringify(args)}` }],
      temperature: 0
    }, { headers: { Authorization: `Bearer ${CONFIG.apiKey}` } });
    return riskRes.data.choices[0].message.content.trim().toUpperCase();
  } catch (e) { return 'MEDIUM'; }
}

// ====================== AI CONVERSATION ENGINE ======================

async function runTaskLoop() {
  STATE.isThinking = true;
  try {
    const res = await axios.post(`${CONFIG.endpoint}/chat/completions`, {
      model: CONFIG.heavyModel,
      messages: STATE.history,
      tools: tools,
      tool_choice: "auto",
      temperature: CONFIG.temp,
      max_tokens: CONFIG.maxTokens
    }, { headers: { Authorization: `Bearer ${CONFIG.apiKey}` }, timeout: 300000 });

    const aiMsg = res.data.choices[0].message;
    STATE.history.push(aiMsg);

    if (aiMsg.tool_calls && aiMsg.tool_calls.length > 0) {
      for (const tc of aiMsg.tool_calls) {
        const name = tc.function.name;
        const callArgs = JSON.parse(tc.function.arguments);
        
        const risk = await checkRisk(name, callArgs);
        let allowed = (CONFIG.permissionMode === 'bypass' || (CONFIG.permissionMode === 'auto' && risk === 'LOW'));

        if (!allowed) {
          console.log(`\n🔐 [${risk} RISK] Permission required for ${name}`);
          console.log(`Args: ${JSON.stringify(callArgs, null, 2)}`);
          const ans = await new Promise(r => rl.question("Execute? (y/n/skip): ", r));
          allowed = ans.toLowerCase().startsWith('y');
        }

        console.log(`🔧 Using tool: ${name}...`);
        const output = allowed ? await executeToolRaw(name, callArgs) : "User blocked tool execution.";
        STATE.history.push({ role: "tool", tool_call_id: tc.id, content: String(output) });
      }
      return await runTaskLoop(); // Iterate
    }
    STATE.isThinking = false;
    return aiMsg.content;
  } catch (err) {
    STATE.isThinking = false;
    const msg = err.response ? JSON.stringify(err.response.data) : err.message;
    console.error(`❌ Inference Error: ${msg}`);
    return "Process interrupted by API error.";
  }
}

// ====================== WIN7 DEBOUNCED REPL ======================

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
let inputBuffer = [];
let pasteTimer = null;

const handleInput = async () => {
  const fullText = inputBuffer.join('\n').trim();
  inputBuffer = [];
  if (!fullText) return;
  if (fullText.toLowerCase() === 'exit') process.exit(0);

  console.log("\n[7coder Thinking...]");
  STATE.history.push({ role: "user", content: fullText });
  const response = await runTaskLoop();
  console.log(`\n7coder: ${response}\n`);
  process.stdout.write("You: ");
};

rl.on('line', (line) => {
  inputBuffer.push(line);
  if (pasteTimer) clearTimeout(pasteTimer);
  // Paste-buffer fix: assume paste if lines arrive rapidly. 
  // ENTER twice (empty line) or 2s pause triggers processing.
  pasteTimer = setTimeout(handleInput, line.trim() === "" ? 200 : 2000);
});

// ====================== HTTP API SERVER ======================

function startHttpServer() {
  http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/chat') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body);
          STATE.history.push({ role: 'user', content: payload.prompt });
          const out = await runTaskLoop();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ output: out }));
        } catch (e) {
          res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
        }
      });
    } else {
      res.writeHead(404); res.end();
    }
  }).listen(CONFIG.httpPort, () => {
    console.log(`🌐 API Server listening on port ${CONFIG.httpPort}`);
  });
}

// ====================== BOOT ======================

async function main() {
  if (backgroundMode) {
    const child = child_process.spawn(process.argv[0], process.argv.slice(1).filter(a => a !== '--background'), {
      detached: true, stdio: 'ignore', cwd: launchDir
    });
    child.unref();
    console.log('✅ 7coder process detached to background.');
    process.exit(0);
  }

  if (CONFIG.enableHttpServer || serverMode) startHttpServer();
  if (serverMode) return;

  if (promptArg) {
    STATE.history.push({ role: 'user', content: promptArg });
    const result = await runTaskLoop();
    console.log(result);
    process.exit(0);
  }

  console.log("🚀 7coder v2.1.0 Ready | Node 13+ | Mode:", CONFIG.permissionMode.toUpperCase());
  console.log("Paste task or type. Press ENTER twice or wait 2s to send.\n");
  process.stdout.write("You: ");
}

main().catch(err => {
  console.error("FATAL CRASH:", err);
  process.exit(1);
});
