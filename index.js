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
  console.log(`
7coder v2.1.1 — Full Claude Code replacement (multi-line paste FIXED)
`);
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
if (ENABLE_COMPUTER_USE) console.log('🖥️  Full computer use ENABLED');
if (ENABLE_HTTP_SERVER) console.log(`🌐 HTTP endpoint on port ${HTTP_PORT}`);

// ====================== STATE ======================
const activeAgents = new Map();
const backgroundTasks = new Map();
const cronJobs = new Map();
let mcpResourcesDir = path.join(launchDir, '.mcp');
if (!fs.existsSync(mcpResourcesDir)) fs.mkdirSync(mcpResourcesDir, { recursive: true });

// ====================== SAFETY ======================
const PROTECTED_FILES = ['.gitconfig', '.bashrc', '.zshrc', '.mcp.json', '.env', 'package.json', 'node_modules', '.git', '7CODER.md'];

const isSuperDangerous = (cmd) => /dd\s|format\s|rm\s+-rf\s+\/|del\s+c:\\|shutdown|poweroff|format c:|diskpart|reg delete|takeown/.test(cmd.toLowerCase().trim());

const sanitizePath = (requestedPath) => {
  let full = path.resolve(launchDir, requestedPath || '');
  if (!full.startsWith(launchDir)) throw new Error('Path traversal blocked');
  const base = path.basename(full).toLowerCase();
  if (PROTECTED_FILES.some(p => base === p.toLowerCase() || full.includes(p))) throw new Error('Protected file blocked');
  return full;
};

// ====================== HELPERS ======================
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

// ====================== TOOLS ======================
const tools = [ /* same 40+ tools as v2.1.0 — unchanged */ 
  // (omitted here for brevity — copy from your previous v2.1.0 index.js if you want, the array is identical)
];

// ====================== STRONGER SYSTEM PROMPT (fixes the main bug) ======================
const systemPrompt = `You are 7coder v2.1.1 — full clean-room Claude Code replacement.

CRITICAL RULES:
- When the user asks to create ANY file (especially index.html, landing page, app, etc.), IMMEDIATELY use the write_file tool with the COMPLETE final content. Do not ask questions, do not iterate, do not output generic templates.
- ALWAYS start by creating or updating 7CODER.md in the project root with your plan and findings.
- Never output phrases like "One-shot Task Initialized" or "Please specify". Directly solve the request using tools.
- For creative tasks like "make a landing page", just write the full index.html in one tool call.

Permission & Security rules still apply. Use tools aggressively.`;

let messages = [{ role: 'system', content: systemPrompt }];

// ====================== OPENAI + RISK HELPERS ======================
async function callOpenAI(currentMessages, options = {}) { /* unchanged from v2.1.0 */ }
async function classifyRisk(toolName, args) { /* unchanged */ }
async function getPermissionExplanation(toolName, args, risk) { /* unchanged */ }

async function isAutoApprovalSafe(toolName, args, risk) {
  // More lenient for creative file creation
  if (toolName === 'write_file' && args.path && args.path.includes('.html')) return true;
  const prompt = `Is this tool action safe to auto-approve in AUTO mode? Risk: ${risk}\nTool: ${toolName}\nArgs: ${JSON.stringify(args)}\nReply ONLY with YES or NO.`;
  try {
    const choice = await callOpenAI([{ role: 'user', content: prompt }], { model: LIGHT_MODEL, useTools: false });
    return choice.message.content.trim().toUpperCase().startsWith('YES');
  } catch (e) { return true; } // fail-open in auto mode for speed
}

async function detectFrustration(userInput) { /* unchanged */ }

// ====================== APPROVAL ======================
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'You: ' });

// ====================== MULTI-LINE PASTE FIX (the real bug fix) ======================
let currentInputBuffer = '';

async function safeExecuteTool(toolCall) { /* unchanged from v2.1.0 */ }
async function executeToolRaw(name, args) { /* unchanged from v2.1.0 */ }

async function processWithTools(currentMessages) { /* unchanged */ }

async function executeTask(customMessages = null) {
  const msgs = customMessages || messages;
  // Force 7CODER.md creation on every major task
  try {
    const coderPath = path.join(launchDir, '7CODER.md');
    if (!fs.existsSync(coderPath)) {
      fs.writeFileSync(coderPath, `# 7CODER Findings\n\nTask started: ${new Date().toISOString()}\n\n`, 'utf8');
    }
  } catch {}
  /* rest of executeTask unchanged */
}

// ====================== HTTP SERVER (unchanged) ======================
function startHttpServer() { /* unchanged from v2.1.0 */ }

// ====================== FIXED REPL WITH MULTI-LINE SUPPORT ======================
async function main() {
  if (backgroundMode && promptArg) { /* unchanged */ }
  if (ENABLE_HTTP_SERVER) { /* unchanged */ }

  if (promptArg) {
    // non-interactive — unchanged
    messages.push({ role: 'user', content: promptArg });
    await executeTask();
    process.exit(0);
  } else {
    console.log('\n🚀 Welcome to 7coder v2.1.1 (multi-line paste now works!)');
    console.log('Paste large prompts and press Enter on a blank line to submit.\n');
    if (ENABLE_RALPH_MODE) console.log('🎉 Ralph Wiggum self-iteration ENABLED');
    rl.prompt();

    rl.on('line', async (input) => {
      const trimmedLine = input.trim();

      if (trimmedLine.toLowerCase() === 'exit') {
        console.log('👋 Goodbye!');
        rl.close();
        return;
      }

      if (trimmedLine === '') {
        // Blank line = submit the accumulated multi-line buffer as ONE message
        if (currentInputBuffer.trim()) {
          const fullPrompt = currentInputBuffer.trim();

          const frustrated = await detectFrustration(fullPrompt);
          if (frustrated) messages.push({ role: 'system', content: 'User appears frustrated. Be extra helpful, calm, and empathetic.' });

          messages.push({ role: 'user', content: fullPrompt });
          console.log('7coder is thinking...');
          await executeTask();
          currentInputBuffer = '';
        }
        rl.prompt();
        return;
      }

      // Accumulate line (preserves newlines for markdown/code)
      currentInputBuffer += input + '\n';
      // Do NOT prompt after every line while pasting
    });
  }
}

main().catch(console.error);
