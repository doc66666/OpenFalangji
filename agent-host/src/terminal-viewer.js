#!/usr/bin/env node
"use strict";

/**
 * Native terminal viewer for an AgentHost.
 *
 * This process is meant to be launched inside a system terminal window
 * (PowerShell, Windows Terminal, GNOME Terminal, Terminal.app, ...). It
 * connects to AgentHost's WebSocket and bridges:
 *
 *   terminal stdin  ->  AgentHost PTY
 *   AgentHost PTY   ->  terminal stdout
 *
 * Usage:
 *   node terminal-viewer.js --url ws://127.0.0.1:9101/ws
 */

const WebSocket = require("ws");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--url" && argv[i + 1]) {
      args.url = argv[i + 1];
      i++;
    }
  }
  return args;
}

function main() {
  const { url } = parseArgs(process.argv.slice(2));
  if (!url) {
    console.error("Usage: node terminal-viewer.js --url <ws://...>");
    process.exit(1);
  }

  const ws = new WebSocket(url);
  let rawMode = false;

  const enableRawMode = () => {
    if (!rawMode && process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      rawMode = true;
    }
  };

  const disableRawMode = () => {
    if (rawMode) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      rawMode = false;
    }
  };

  const sendResize = () => {
    if (process.stdout.isTTY) {
      ws.send(
        JSON.stringify({
          type: "resize",
          cols: process.stdout.columns || 80,
          rows: process.stdout.rows || 24,
        })
      );
    }
  };

  ws.on("open", () => {
    enableRawMode();
    sendResize();

    process.stdin.on("data", (chunk) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data: chunk.toString() }));
      }
    });

    process.stdout.on("resize", sendResize);
  });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (_) {
      return;
    }
    if (msg.type === "output") {
      process.stdout.write(msg.data);
    } else if (msg.type === "exit") {
      console.log(`\n[viewer] agent exited (code=${msg.exitCode}, signal=${msg.signal})`);
      cleanup();
      process.exit(0);
    }
  });

  ws.on("close", () => {
    cleanup();
    process.exit(0);
  });

  ws.on("error", (err) => {
    console.error(`[viewer] websocket error: ${err.message}`);
    cleanup();
    process.exit(1);
  });

  const cleanup = () => {
    disableRawMode();
    process.stdin.removeAllListeners("data");
    process.stdout.removeAllListeners("resize");
  };

  process.on("SIGINT", () => {
    // Let Ctrl-C go through the WebSocket to the agent PTY, not kill the viewer.
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "input", data: "\x03" }));
    }
  });
}

main();
