const axios = require('axios');
const readline = require('readline');
const path = require('path');

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
process.chdir(launchDir);                    // Force cd (handles Windows 7 shortcuts, any drive, etc.)
console.log(`✅ 7coder cd'ed to: ${launchDir}`);

const systemPrompt = `You are 7coder, a helpful, honest, and harmless AI coding assistant created by Anthropic.`;

let messages = [{ role: 'system', content: systemPrompt }];

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: 'You: '
});

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
        },
        {
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
          },
          timeout: 90000,
        }
      );
      return response.data.choices[0].message.content.trim();
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
  console.log('🎉 "Claude-Like Ralph Wiggum" mode ENABLED — self-iteration feedback loop active');
} else {
  console.log('ℹ️  Normal mode');
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
    let reply = await callOpenAI(messages);
    messages.push({ role: 'assistant', content: reply });
    let displayReply = reply;

    if (ENABLE_RALPH_MODE) {
      console.log(`🔄 Ralph Wiggum Loop — Iteration 1: ${reply.substring(0, 120)}${reply.length > 120 ? '...' : ''}`);

      for (let attempt = 2; attempt <= MAX_RETRIES; attempt++) {
        const refineMsg = `You are in Claude-Like Ralph Wiggum loop mode. This is iteration ${attempt}. Review and iterate on your previous response. Improve the code/solution for correctness, edge cases, efficiency, and clarity. If it is now optimal and the task is complete, start your reply with exactly "RALPH_WIGGUM_COMPLETE" followed by the final polished version.`;
        
        messages.push({ role: 'user', content: refineMsg });
        reply = await callOpenAI(messages);
        messages.push({ role: 'assistant', content: reply });

        if (reply.trim().startsWith('RALPH_WIGGUM_COMPLETE')) {
          displayReply = reply.replace(/^RALPH_WIGGUM_COMPLETE\s*/i, '').trim();
          console.log(`✅ Completion promise fulfilled at iteration ${attempt}!`);
          break;
        }

        displayReply = reply;
        console.log(`🔄 Ralph Wiggum Loop — Iteration ${attempt}: ${reply.substring(0, 120)}${reply.length > 120 ? '...' : ''}`);
      }
    }

    console.log(`\n7coder: ${displayReply}`);
  } catch (err) {
    console.error(`❌ Error: ${err.message}`);
  }

  rl.prompt();
});
