const axios = require('axios');
const readline = require('readline');
const path = require('path');
const fs = require('fs');
const child_process = require('child_process');

// ====================== CLI ARGUMENT PARSING (Node 13 safe) ======================
const args = process.argv.slice(2);
let promptArg = null;
let dangerMode = false;
let showHelp = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--help' || arg === '-h') {
    showHelp = true;
  } else if (arg === '--danger') {
    dangerMode = true;
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
  node index.js                          → Interactive REPL (default)
  node index.js --prompt "your task here" → Non-interactive (runs once and exits)
  node index.js -p "your task here"
  node index.js --danger                 → Disable ALL command confirmations
  node index.js --prompt "task" --danger → Dangerous non-interactive mode

Flags can be combined. REPL is still fully supported.
`);
  process.exit(0);
}

// == SET LAUNCHDIR HERE ! ! ! ==
const launchDir = process.cwd();

// == cd to script's dir so that we can find .env file ==
process.chdir(path.dirname(process.argv[1]));

require('dotenv').config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_ENDPOINT = process.env.OPENAI_ENDPOINT || 'https://api.openai.com/v1';
const ENABLE_RALPH_MODE = process.env.ENABLE_CLAUDE_LIKE_RALPH_WIGGUM_MODE === 'true';
const MAX_RETRIES = parseInt(process.env.MAX_ATTEMPT_RETRIES, 10) || 3;
const MODEL = process.env.OPENAI_MODEL || 'gpt-3.5-turbo';
const TEMPERATURE = parseFloat(process.env.TEMPERATURE) || 0.7;
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS, 10) || 2048;

if (!OPENAI_API_KEY) {
  console.error('❌ Please set OPENAI_API_KEY in your .env file');
  process.exit(1);
}

// === EXPLICIT CD TO USER'S CURRENT DIRECTORY (Claude Code style) ===
process.chdir(launchDir);
console.log(`✅ 7coder cd'ed to: ${launchDir}`);

const DANGER_MODE = dangerMode;
const INTERACTIVE = !promptArg;

if (DANGER_MODE) {
  console.log('⚠️  DANGER MODE ENABLED — All CLI commands will run WITHOUT approval!');
}

// ====================== TOOL DEFINITIONS ======================
const tools = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the entire content of a file.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a file.",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] }
    }
  },
  {
    type: "function",
    function: {
      name: "append_file",
      description: "Append content to a file (creates if missing).",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] }
    }
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Run a shell command. In danger mode this runs automatically.",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] }
    }
  }
];

// ====================== SYSTEM PROMPT ======================
const systemPrompt = `You are 7coder, a helpful, honest, and harmless AI coding assistant created by Anthropic.
You have access to tools: read_file, write_file, append_file, run_command.
Use them whenever you need to interact with the filesystem or run code.
After using tools, give a clear final answer.`;

let messages = [{ role: 'system', content: systemPrompt }];

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

async function executeTool(toolCall) {
  const func = toolCall.function;
  let args;
  try { args = JSON.parse(func.arguments || '{}'); } catch (e) { return `Parse error: ${e.message}`; }

  const name = func.name;

  if (name === 'read_file') {
    const fullPath = path.join(launchDir, args.path || '');
    try { return fs.readFileSync(fullPath, 'utf8'); } catch (e) { return `Read error: ${e.message}`; }
  }

  if (name === 'write_file') {
    const fullPath = path.join(launchDir, args.path);
    try {
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, args.content || '', 'utf8');
      return `Written: ${args.path}`;
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

  if (name === 'run_command') {
    const cmd = args.command || '';
    if (DANGER_MODE) {
      console.log(`⚠️ DANGER MODE: Running command automatically → ${cmd}`);
    } else if (!INTERACTIVE) {
      return 'Command skipped: non-interactive mode requires --danger to auto-run commands.';
    } else {
      console.log(`\n🔧 Proposed: ${cmd}`);
      const approved = await askApproval('Execute? (y/n) ');
      if (!approved) return 'User declined the command.';
    }

    try {
      const output = child_process.execSync(cmd, { encoding: 'utf8', cwd: launchDir });
      return `Command OK:\n${output}`;
    } catch (e) {
      return `Command failed:\n${e.message}\n${e.stderr || ''}`;
    }
  }

  return `Unknown tool: ${name}`;
}

// ====================== TOOL CALLING LOOP ======================
async function processWithTools(currentMessages) {
  while (true) {
    const choice = await callOpenAI(currentMessages);
    const assistantMsg = choice.message;
    currentMessages.push(assistantMsg);

    if (assistantMsg.tool_calls?.length > 0) {
      console.log(`🔧 Using ${assistantMsg.tool_calls.length} tool(s)...`);
      for (const tc of assistantMsg.tool_calls) {
        const result = await executeTool(tc);
        currentMessages.push({ role: 'tool', tool_call_id: tc.id, content: result });
      }
      continue;
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

// ====================== RUN MODE ======================
if (promptArg) {
  // NON-INTERACTIVE MODE
  console.log(`\n🚀 7coder non-interactive mode`);
  console.log(`Task: ${promptArg}`);
  messages.push({ role: 'user', content: promptArg });
  await executeTask();
  process.exit(0);
} else {
  // INTERACTIVE REPL (default)
  console.log('\n🚀 Welcome to 7coder (interactive REPL)');
  if (ENABLE_RALPH_MODE) console.log('🎉 Ralph Wiggum mode ENABLED');
  if (DANGER_MODE) console.log('⚠️ DANGER MODE ENABLED');
  console.log('Type your task or "exit" to quit.\n');

  rl.prompt();

  rl.on('line', async (input) => {
    const trimmed = input.trim();
    if (trimmed.toLowerCase() === 'exit') {
      console.log('👋 Goodbye!');
      rl.close();
      return;
    }
    if (!trimmed) {
      rl.prompt();
      return;
    }

    messages.push({ role: 'user', content: trimmed });
    console.log('7coder is thinking...');
    await executeTask();
    rl.prompt();
  });
}
