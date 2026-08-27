#!/usr/bin/env node
"use strict";

const { AgentHost } = require("./agent-host");

function parseArgs(argv) {
  const args = {
    command: null,
    port: 0,
    openTerminal: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--agent-id":
        args.agentId = next();
        break;
      case "--command":
        args.command = next();
        break;
      case "--cwd":
        args.cwd = next();
        break;
      case "--terminal-env":
        args.terminalEnv = next();
        break;
      case "--wsl-distro":
        args.wslDistro = next();
        break;
      case "--port":
        args.port = parseInt(next(), 10);
        break;
      case "--center-url":
        args.centerUrl = next();
        break;
      case "--completion-provider":
        args.completionProvider = next();
        break;
      case "--completion-config-file":
        args.completionConfigFile = next();
        break;
      case "--mode":
        args.mode = next();
        break;
      case "--timeout-ms":
        args.timeoutMs = parseInt(next(), 10) || 0;
        break;
      case "--description":
        args.description = next();
        break;
      case "--capability":
        if (!args.capabilities) args.capabilities = [];
        args.capabilities.push(next());
        break;
      case "--open-terminal":
        args.openTerminal = true;
        break;
      case "--no-open-terminal":
        args.openTerminal = false;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        break;
    }
  }
  return args;
}

function printHelp() {
  console.log(`
AgentHost - local agent terminal host

Usage:
  node src/index.js [options]

Options:
  --agent-id <id>          Agent id (default: agent-<pid>)
  --command <cmd>          Shell command to start the agent, e.g. "claude" or "codex exec"
  --cwd <dir>              Working directory for the agent
  --terminal-env <native|wsl> Terminal environment on Windows (default: native)
  --wsl-distro <name>      Optional WSL distribution, e.g. Ubuntu
  --port <port>            Listen port (default: 0 = random free port)
  --center-url <url>       Optional center URL for future registration/heartbeat
  --completion-provider <t> Completion detector: opencode/claude/codex/pi/manual/custom
                           (default: auto-detect from command)
  --completion-config-file <path> Path to a custom reader JS file (for provider=custom)
  --mode <task|minimal>    Collaboration mode (default: minimal)
  --timeout-ms <ms>        Default task timeout in milliseconds (0 = disabled)
  --description <text>     Agent description (agent card)
  --capability <name>      Add an agent capability; repeatable
  --open-terminal          Open a system terminal window for observation (default)
  --no-open-terminal       Do not open a system terminal window
  --help                   Show this help
`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const host = new AgentHost({
    agentId: opts.agentId,
    command: opts.command,
    cwd: opts.cwd,
    terminalEnv: opts.terminalEnv,
    wslDistro: opts.wslDistro,
    port: opts.port,
    openTerminal: opts.openTerminal,
    centerUrl: opts.centerUrl,
    completionProvider: opts.completionProvider,
    completionConfig: opts.completionConfigFile
      ? { file: opts.completionConfigFile }
      : undefined,
    mode: opts.mode,
    taskTimeoutMs: opts.timeoutMs,
    description: opts.description,
    capabilities: opts.capabilities,
  });

  const port = await host.start();
  const url = `http://127.0.0.1:${port}`;
  console.log(`[AgentHost] ${host.agentId} listening on ${url}`);
  console.log(`[AgentHost] web terminal: ${url}/`);
  console.log(`[AgentHost] health: ${url}/health`);
  if (host.command) {
    console.log(`[AgentHost] command: ${host.command}`);
    host.startAgent(host.command, host.cwd);
    await host.openObservationTerminal();
  } else {
    console.log("[AgentHost] no command provided; use the management page to start an agent.");
  }

  const shutdown = async () => {
    console.log("\n[AgentHost] shutting down...");
    await host.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[AgentHost] fatal:", err);
  process.exit(1);
});
