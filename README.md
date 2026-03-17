# 7coder
Claude Code alternative for Windows 7/NodeJS 13.

## Cheat sheet

**REPL:**
```
node index.js
```

**Background Prompt**
```
node index.js --prompt "Create a todo list app in React with localStorage"
# or short form
node index.js -p "Build a simple HTTP server in Node"
```

**Help**
```
node index.js --help
```

***DANGER MODE (NO CONFIRMATIONS!)***
```
node index.js --danger --prompt "Install dependencies and run tests"
```

## How Tools Work
The AI can automatically:

* Read files
* Create / overwrite files (write_file)
* Append to files (append_file)
* Run any shell command (run_command)

In normal mode it will ask y/n before running commands.
***In --danger mode it runs them instantly.***
**All paths are relative to the folder you launched 7coder from.**

## Compatibility

Node.js: 13.0.0 and above (no optional chaining, no modern syntax)
OS: Tested on Windows 7, should also work on newer Windows versions
API: Any OpenAI-compatible endpoint

## Why 7coder?
Because real Claude Code is very expensive.
This is the free, Windows-friendly, more open version that actually does everything most of Claude Code's functionality but compatible with Windows 7
Vibe coded with love (and a lot of debugging on Windows 7) by 😃MyMel2001.
