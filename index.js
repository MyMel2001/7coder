const axios = require('axios');
const readline = require('readline');
const path = require('path');
const fs = require('fs');
const child_process = require('child_process');   // ← for run_command

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

// ====================== TOOL DEFINITIONS (OpenAI tool calling format) ======================
const tools = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the entire content of a file. Use this before editing or when you need context.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path from the current folder" }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create a new file or completely overwrite an existing file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" }
        },
        required: ["path", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "append_file",
      description: "Append text to the end of a file (creates the file if it doesn't exist).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" }
        },
        required: ["path", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Run any CLI/shell command in the current directory. User will be asked for approval first.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Exact command (e.g. dir, node test.js, echo hello > file.txt)" }
        },
        required: ["command"]
      }
    }
  }
];

// ====================== SYSTEM PROMPT ======================
const systemPrompt = `You are 7coder, a helpful, honest, and harmless AI coding assistant created by Anthropic.
You have access to tools for reading, writing, appending files, and running commands.
Always use the tools when you need to interact with the filesystem or run code.
After using tools, give a clear final answer to the user.`;

let messages = [{ role: 'system', content: systemPrompt }];

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: 'You: '
});

// ====================== APPROVAL HELPER (for run_command) ======================
function askApproval(question) {
  return new Promise(resolve => {
    rl.question(question, answer => {
      resolve(answer.toLowerCase().startsWith('y'));
    });
  });
}

// ====================== EXECUTE TOOL ======================
async function executeTool(toolCall) {
  const func = toolCall.function;
  let args;
  try {
    args = JSON.parse(func.arguments || '{}');
  } catch (e) {
    return `Error parsing arguments: ${e.message}`;
  }

  const name = func.name;

  if (name === 'read_file') {
    const fullPath = path.join(launchDir, args.path || '');
    try {
      return fs.readFileSync(fullPath, 'utf8');
    } catch (e) {
      return `Error reading file: ${e.message}`;
    }
  }

  if (name === 'write_file') {
    const fullPath = path.join(launchDir, args.path);
    try {
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, args.content || '', 'utf8');
      return `File written: ${args.path}`;
    } catch (e) {
      return `Error writing file: ${e.message}`;
    }
  }

  if (name === 'append_file') {
    const fullPath = path.join(launchDir, args.path);
    try {
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.appendFileSync(fullPath, args.content || '', 'utf8');
      return `Appended to: ${args.path}`;
    } catch (e) {
      return `Error appending: ${e.message}`;
    }
  }

  if (name === 'run_command') {
    const cmd = args.command || '';
    console.log(`\n🔧 Proposed command: ${cmd}`);
    const approved = await askApproval('Execute this command? (y/n) ');
    if (!approved) return 'User declined to run the command.';

    try {
      const output = child_process.execSync(cmd, {
        encoding: 'utf8',
        cwd: launchDir,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      return `Command succeeded:\n${output}`;
    } catch (e) {
      return `Command failed:\n${e.message}\n${e.stderr || ''}`;
    }
  }

  return `Unknown tool: ${name}`;
}

// ====================== FULL TOOL CALLING LOOP (Claude-style agent) ======================
async function processWithTools(currentMessages) {
  while (true) {
    const choice = await callOpenAI(currentMessages);
    const assistantMsg = choice.message;

    currentMessages.push(assistantMsg);

    if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
      console.log(`🔧 7coder is using ${assistantMsg.tool_calls.length} tool(s)...`);

      for (const tc of assistantMsg.tool_calls) {
        const result = await executeTool(tc);
        currentMessages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: result
        });
      }
      // continue the loop — AI gets to respond again
      continue;
    }

    // No more tool calls → final text answer
    return assistantMsg.content || '';
  }
}

async function callOpenAI(currentMessages) {
  const base = OPENAI_ENDPOINT.replace(/\/+$/, '');
  const url = `${base}/chat/completions`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await axios.post(
        url,
        {
          model: MODEL,
          messages: currentMessages,
          temperature: TEMPERATURE,
          max_tokens: MAX_TOKENS,
          tools: tools,           // ← TOOL CALLING ENABLED
          tool_choice: "auto"
        },
        {
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
          },
          timeout: 420000,
        }
      );
      return response.data.choices[0];
    } catch (error) {
      const msg = (error.response && error.response.data && error.response.data.error && error.response.data.error.message) || error.message;
      console.error(`⚠️ API attempt ${attempt}/${MAX_RETRIES} failed: ${msg}`);

      if (attempt === MAX_RETRIES) throw new Error('Max API retries reached.');
      await new Promise(resolve => setTimeout(resolve, 1200 * attempt));
    }
  }
}

console.log('\n🚀 Welcome to 7coder');
if (ENABLE_RALPH_MODE) {
  console.log('🎉 "Claude-Like Ralph Wiggum" mode ENABLED — self-iteration + full tool calling (read/append/write/run)');
} else {
  console.log('ℹ️  Normal mode with full tool calling (read/append/write + approved CLI commands)');
}
console.log('Type your coding task or "exit" to quit.\n');

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

  try {
    let displayReply = '';

    if (ENABLE_RALPH_MODE) {
      displayReply = await processWithTools(messages);
      console.log(`🔄 Ralph Wiggum Loop — Iteration 1: ${displayReply.substring(0, 120)}${displayReply.length > 120 ? '...' : ''}`);

      for (let attempt = 2; attempt <= MAX_RETRIES; attempt++) {
        const refineMsg = `You are in Claude-Like Ralph Wiggum loop mode. This is iteration ${attempt}. Review and iterate on your previous response. Improve the code/solution for correctness, edge cases, efficiency, and clarity. You may use any tools (read_file, write_file, append_file, run_command) as needed. If it is now optimal and the task is complete, start your reply with exactly "RALPH_WIGGUM_COMPLETE" followed by the final polished version.`;
        
        messages.push({ role: 'user', content: refineMsg });
        displayReply = await processWithTools(messages);

        if (displayReply.trim().startsWith('RALPH_WIGGUM_COMPLETE')) {
          displayReply = displayReply.replace(/^RALPH_WIGGUM_COMPLETE\s*/i, '').trim();
          console.log(`✅ Completion promise fulfilled at iteration ${attempt}!`);
          break;
        }

        console.log(`🔄 Ralph Wiggum Loop — Iteration ${attempt}: ${displayReply.substring(0, 120)}${displayReply.length > 120 ? '...' : ''}`);
      }
    } else {
      displayReply = await processWithTools(messages);
    }

    console.log(`\n7coder: ${displayReply}`);
  } catch (err) {
    console.error(`❌ Error: ${err.message}`);
  }

  rl.prompt();
});