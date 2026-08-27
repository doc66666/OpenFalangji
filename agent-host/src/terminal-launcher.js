"use strict";

const { spawn, execFile } = require("child_process");
const path = require("path");
const fs = require("fs");

function quote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function isWsl() {
  if (process.env.WSL_INTEROP) return true;
  try {
    const version = fs.readFileSync("/proc/version", "utf8");
    return /microsoft|wsl/i.test(version);
  } catch (_) {
    return false;
  }
}

/**
 * Open a system terminal window that runs terminal-viewer.js and connects
 * to the given AgentHost WebSocket URL.
 *
 * @param {string} wsUrl
 * @returns {Promise<void>}
 */
async function openTerminalViewer(wsUrl) {
  const viewer = path.join(__dirname, "terminal-viewer.js");
  const nodeBin = process.execPath;
  const command = `${quote(nodeBin)} ${quote(viewer)} --url ${quote(wsUrl)}`;

  if (process.platform === "win32") {
    return openWindowsTerminal(command);
  }
  if (process.platform === "darwin") {
    return openMacTerminal(command);
  }
  if (isWsl()) {
    return openWslWindowsTerminal(command);
  }
  return openLinuxTerminal(command);
}

function openWindowsTerminal(command) {
  return new Promise((resolve, reject) => {
    execFile("wt.exe", ["-w", "0", "new-tab", "--title", "AgentHost", "powershell.exe", "-NoExit", "-Command", command], (wtErr) => {
      if (!wtErr) return resolve();
      const child = spawn(
        "cmd.exe",
        ["/c", "start", "AgentHost", "powershell.exe", "-NoExit", "-Command", command],
        { detached: true, stdio: "ignore" }
      );
      child.on("error", reject);
      child.unref();
      resolve();
    });
  });
}

function openWslWindowsTerminal(command) {
  return new Promise((resolve, reject) => {
    // Prefer Windows Terminal, which can be invoked from WSL.
    execFile(
      "wt.exe",
      ["-w", "0", "new-tab", "--title", "AgentHost", "wsl.exe", "bash", "-lc", command],
      (wtErr) => {
        if (!wtErr) return resolve();

        // Fallback: open a new Windows console window running the command inside WSL.
        const cmd = `start "AgentHost" wsl.exe bash -lc ${JSON.stringify(command)}`;
        const child = spawn("cmd.exe", ["/c", cmd], {
          detached: true,
          stdio: "ignore",
        });
        child.on("error", reject);
        child.unref();
        resolve();
      }
    );
  });
}

function openMacTerminal(command) {
  return new Promise((resolve, reject) => {
    const script = `tell application "Terminal" to do script ${JSON.stringify(command)}`;
    const child = spawn("osascript", ["-e", script], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", reject);
    child.unref();
    resolve();
  });
}

function openLinuxTerminal(command) {
  const candidates = [];

  if (process.env.TERMINAL) {
    candidates.push(process.env.TERMINAL);
  }
  candidates.push(
    "x-terminal-emulator",
    "gnome-terminal",
    "konsole",
    "xfce4-terminal",
    "kgx",
    "xterm"
  );

  return new Promise((resolve, reject) => {
    let index = 0;
    const tryNext = () => {
      if (index >= candidates.length) {
        return reject(new Error("no supported terminal emulator found"));
      }
      const term = candidates[index++];
      const child = spawn(term, ["--", "bash", "-lc", command], {
        detached: true,
        stdio: "ignore",
      });
      child.on("error", () => tryNext());
      child.on("spawn", () => {
        child.unref();
        resolve();
      });
    };
    tryNext();
  });
}

module.exports = { openTerminalViewer };
