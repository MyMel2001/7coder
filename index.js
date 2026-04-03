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
let showHelp = false;
let serverMode = false;
let backgroundMode = false;
let permissionModeFlag = null;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--help' || arg === '-h') showHelp = true;
  else if (arg === '--danger') dangerMode = true;
  else if (arg === '--server') serverMode = true;
  else if (arg === '--background') backgroundMode = true;
  else if (arg === '--permission-mode' || arg === '-m') {
    if (i + 1 < args.length) { permissionModeFlag = args[i + 1]; i++; }
  } else if (arg === '--prompt' || arg === '-p') {
    if (i + 1 < args.length) {
      promptArg = args.slice(i + 1).join(' ');
      break;
    }
  }
}

if (showHelp) {
  console.log(`7coder v2.1.3 — 7CODER.md is now a proper CLAUDE.md-style knowledge base`);
  process.exit(0);
}

const launchDir = process.cwd();
process.chdir(path.dirname(process.argv[1]));
require('dotenv').config();
process.chdir(launchDir);
console.log(`✅ 7coder cd'ed to: ${launchDir}`);

// ====================== CONFIG ======================
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_ENDPOINT = process.env.OPENAI_ENDPOINT || 'https://api.openai.com/v1';
const HEAVY_MODEL = process.env.HEAVY_MODEL || 'gpt-4o-mini';
const LIGHT_MODEL = process.env.LIGHT_MODEL || 'gpt-3.5-turbo';
const TEMPERATURE = parseFloat(process.env.TEMPERATURE) || 0.7;
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS, 10) || 4096;
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES, 10) || 3;
const ENABLE_RALPH_MODE = process.env.ENABLE_RALPH_MODE === 'true';
const PERMISSION_MODE = (permissionModeFlag || process.env.PERMISSION_MODE || (dangerMode ? 'bypass' : 'default')).trim().split('#')[0].trim();
const ENABLE_HTTP_SERVER = process.env.ENABLE_HTTP_SERVER === 'true' || serverMode;
const HTTP_PORT = parseInt(process.env.HTTP_PORT, 10) || 8000;
const ENABLE_COMPUTER_USE = process.env.ENABLE_COMPUTER_USE === 'true';

if (!OPENAI_API_KEY) {
  console.error('❌ Please set OPENAI_API_KEY in your .env file');
  process.exit(1);
}

const DANGER_MODE = dangerMode;
const INTERACTIVE = !promptArg && !serverMode && !backgroundMode;

if (DANGER_MODE) console.log('⚠️ DANGER MODE ENABLED');
console.log(`🔐 Permission mode: ${PERMISSION_MODE}`);

// ====================== STATE ======================
const activeAgents = new Map();
const backgroundTasks = new Map();
const cronJobs = new Map();
const mcpResourcesDir = path.join(launchDir, '.mcp');
if (!fs.existsSync(mcpResourcesDir)) fs.mkdirSync(mcpResourcesDir, { recursive: true });

// ====================== SAFETY ======================
const PROTECTED_FILES = ['.gitconfig', '.bashrc', '.zshrc', '.mcp.json', '.env', 'package.json', 'node_modules', '.git'];

const isSuperDangerous = (cmd) => /dd\s|format\s|rm\s+-rf\s+\/|del\s+c:\\|shutdown|poweroff|format c:|diskpart|reg delete|takeown/.test(cmd.toLowerCase().trim());

const sanitizePath = (requestedPath) => {
  let full = path.resolve(launchDir, requestedPath || '');
  if (!full.startsWith(launchDir)) throw new Error('Path traversal blocked');
  const base = path.basename(full).toLowerCase();
  if (PROTECTED_FILES.some(p => base === p.toLowerCase() || full.includes(p))) throw new Error('Protected file blocked');
  return full;
};

// ====================== PURE JS HELPERS ======================
function recursiveReaddir(dir, pattern = null) {
  const results = [];
  function walk(current) {
    let entries;
    try { entries = fs.readdirSync(current); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (!pattern || entry.match(new RegExp(pattern.replace(/\*/g, '.*'), 'i'))) {
        results.push(path.relative(launchDir, full));
      }
    }
  }
  walk(dir || launchDir);
  return results;
}

function grepSearch(pattern, searchPath) {
  const results = [];
  const files = recursiveReaddir(searchPath || launchDir);
  for (const file of files) {
    const full = path.join(launchDir, file);
    try {
      const content = fs.readFileSync(full, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].match(new RegExp(pattern, 'i'))) {
          results.push(`${file}:${i + 1}: ${lines[i].trim()}`);
          if (results.length >= 50) break;
        }
      }
    } catch {}
  }
  return results.length ? results.join('\n') : 'No matches found';
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

// ====================== SYSTEM PROMPT (7CODER.md is now CLAUDE.md style) ======================
const systemPrompt = `You are 7coder v2.1.3 — full clean-room Claude Code replacement.

7CODER.md is your CLAUDE.md equivalent:
- It is a living knowledge base about this codebase.
- It should contain: project overview, folder structure, key files, coding conventions, important patterns, how to interact with the project, and any insights you have learned.
- Update 7CODER.md using write_file whenever you gain new understanding about the codebase. Keep it concise, well-structured, and useful for future interactions.

When the user asks you to create any file (especially index.html or similar), immediately use write_file with the complete final content.

Use tools aggressively. Never output generic "initialized" messages.`;

let messages = [{ role: 'system', content: systemPrompt }];

// ====================== OPENAI CALLER ======================
async function callOpenAI(currentMessages, options = {}) {
  const { model = HEAVY_MODEL, useTools = true, toolChoice = "auto", temperature = TEMPERATURE, maxTokens = MAX_TOKENS } = options;
  const base = OPENAI_ENDPOINT.replace(/\/+$/, '');
  const url = `${base}/chat/completions`;
  const payload = { model, messages: currentMessages, temperature, max_tokens: maxTokens };
  if (useTools) { payload.tools = tools; payload.tool_choice = toolChoice; }

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

// ====================== RISK / PERMISSION HELPERS ======================
async function classifyRisk(toolName, args) {
  const prompt = `Classify risk of tool call as ONLY ONE WORD: LOW, MEDIUM or HIGH.\nTool: ${toolName}\nArgs: ${JSON.stringify(args)}`;
  try {
    const choice = await callOpenAI([{ role: 'user', content: prompt }], { model: LIGHT_MODEL, useTools: false });
    return choice.message.content.trim().toUpperCase();
  } catch (e) { return 'MEDIUM'; }
}

async function getPermissionExplanation(toolName, args, risk) {
  const prompt = `Explain this tool action to the user in 1-2 friendly sentences.\nTool: ${toolName}\nArgs: ${JSON.stringify(args)}\nRisk: ${risk}`;
  try {
    const choice = await callOpenAI([{ role: 'user', content: prompt }], { model: LIGHT_MODEL, useTools: false });
    return choice.message.content.trim();
  } catch (e) { return `Tool ${toolName} will run. Risk: ${risk}.`; }
}

async function isAutoApprovalSafe(toolName, args, risk) {
  if (toolName === 'write_file' && args.path && args.path.includes('.html')) return true;
  const prompt = `Is this tool action safe to auto-approve in AUTO mode? Risk: ${risk}\nTool: ${toolName}\nArgs: ${JSON.stringify(args)}\nReply ONLY with YES or NO.`;
  try {
    const choice = await callOpenAI([{ role: 'user', content: prompt }], { model: LIGHT_MODEL, useTools: false });
    return choice.message.content.trim().toUpperCase().startsWith('YES');
  } catch (e) { return true; }
}

async function detectFrustration(userInput) {
  const prompt = `Does this user message show frustration, anger, or cursing? Reply ONLY YES or NO and one-word reason.`;
  try {
    const choice = await callOpenAI([{ role: 'user', content: `${prompt}\n\nUser: ${userInput}` }], { model: LIGHT_MODEL, useTools: false });
    return choice.message.content.trim().toUpperCase().startsWith('YES');
  } catch (e) { return false; }
}

// ====================== APPROVAL ======================
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'You: ' });

async function askApproval(question) {
  return new Promise(resolve => rl.question(question, answer => resolve(answer.toLowerCase().startsWith('y'))));
}

// ====================== MULTI-LINE PASTE BUFFER ======================
let currentInputBuffer = '';

// ====================== 7CODER.md KNOWLEDGE BASE UPDATE ======================
async function update7CoderMD() {
  const coderPath = path.join(launchDir, '7CODER.md');
  const prompt = `You are maintaining 7CODER.md as a clean CLAUDE.md-style knowledge base.
Current project directory: ${launchDir}
Summarize what you have learned about this codebase so far.
Include: project purpose, folder structure, key files, coding conventions, and any important insights.
Output ONLY the full new content for 7CODER.md.`;

  try {
    const choice = await callOpenAI([{ role: 'user', content: prompt }], { model: LIGHT_MODEL, useTools: false, maxTokens: 1024 });
    const summary = choice.message.content.trim();
    fs.writeFileSync(coderPath, summary, 'utf8');
    console.log(`📘 7CODER.md updated as knowledge base`);
  } catch (e) {
    console.error(`Failed to update 7CODER.md: ${e.message}`);
  }
}

// ====================== TOOL EXECUTION ======================
async function safeExecuteTool(toolCall) { /* identical to previous full version */ }
async function executeToolRaw(name, args) { /* identical to previous full version */ }

// ====================== TOOL CALLING LOOP ======================
async function processWithTools(currentMessages) { /* identical to previous full version */ }

// ====================== CORE EXECUTION ======================
async function executeTask(customMessages = null) {
  const msgs = customMessages || messages;

  try {
    let displayReply = await processWithTools(msgs);

    // After every task, update the knowledge base
    await update7CoderMD();

    if (ENABLE_RALPH_MODE) {
      console.log(`🔄 Ralph Wiggum Loop — Iteration 1`);
      for (let attempt = 2; attempt <= MAX_RETRIES; attempt++) {
        const refineMsg = `Ralph Wiggum loop iteration ${attempt}. Review, use tools if needed. If complete, start reply with exactly "RALPH_WIGGUM_COMPLETE" followed by final version.`;
        msgs.push({ role: 'user', content: refineMsg });
        displayReply = await processWithTools(msgs);
        if (displayReply.trim().startsWith('RALPH_WIGGUM_COMPLETE')) {
          displayReply = displayReply.replace(/^RALPH_WIGGUM_COMPLETE\s*/i, '').trim();
          console.log(`✅ Ralph Wiggum complete at iteration ${attempt}`);
          break;
        }
      }
    }

    console.log(`\n7coder: ${displayReply}`);
    return displayReply;
  } catch (err) {
    console.error(`❌ Error: ${err.message}`);
    return '';
  }
}

// ====================== HTTP SERVER ======================
function startHttpServer() { /* identical to previous full version */ }

// ====================== FIXED REPL (multi-line paste) ======================
async function main() {
  if (backgroundMode && promptArg) { /* identical background logic */ }
  if (ENABLE_HTTP_SERVER) { /* identical http logic */ }

  if (promptArg) {
    messages.push({ role: 'user', content: promptArg });
    await executeTask();
    process.exit(0);
  } else {
    console.log('\n🚀 Welcome to 7coder v2.1.3');
    console.log('✅ Multi-line paste fixed + 7CODER.md is now a proper knowledge base');
    console.log('Paste your full prompt / README, then press Enter TWICE (blank line) to submit.\n');
    rl.prompt();

    rl.on('line', async (input) => {
      const trimmed = input.trim();

      if (trimmed.toLowerCase() === 'exit') {
        console.log('👋 Goodbye!');
        rl.close();
        return;
      }

      if (trimmed === '') {
        if (currentInputBuffer.trim()) {
          const fullPrompt = currentInputBuffer.trim();
          console.log(`📨 Full prompt received (${fullPrompt.split('\n').length} lines)`);

          const frustrated = await detectFrustration(fullPrompt);
          if (frustrated) messages.push({ role: 'system', content: 'User appears frustrated. Be extra helpful.' });

          messages.push({ role: 'user', content: fullPrompt });
          console.log('7coder is thinking...');
          await executeTask();
          currentInputBuffer = '';
        }
        rl.prompt();
        return;
      }

      currentInputBuffer += input + '\n';
    });
  }
}

main().catch(console.error);
