import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

import { binaryAvailable, runCommand } from "./process.mjs";

export const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current session state. Pick the next highest-value step and follow through until the task is resolved.";

const COPILOT_BIN = "copilot";
const AUTH_ENV_VARS = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"];

function shorten(text, limit = 72) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (!onProgress || !message) {
    return;
  }
  if (!phase && Object.keys(extra).length === 0) {
    onProgress(message);
    return;
  }
  onProgress({ message, phase, ...extra });
}

function emitLogEvent(onProgress, options = {}) {
  if (!onProgress) {
    return;
  }
  onProgress({
    message: options.message ?? "",
    phase: options.phase ?? null,
    stderrMessage: options.stderrMessage ?? null,
    logTitle: options.logTitle ?? null,
    logBody: options.logBody ?? null
  });
}

export function getCopilotAvailability(cwd) {
  const versionStatus = binaryAvailable(COPILOT_BIN, ["--version"], { cwd });
  if (!versionStatus.available) {
    return versionStatus;
  }
  return {
    available: true,
    detail: versionStatus.detail
  };
}

// Likely Copilot CLI keychain/secret-service identifiers, in order of
// most-to-least likely. Different Copilot CLI versions have used different
// keytar service names; probe all of them rather than guessing one.
const COPILOT_SECRET_SERVICES = [
  "copilot-cli",
  "github-copilot-cli",
  "com.github.copilot.cli",
  "GitHub Copilot CLI",
  "Copilot CLI"
];

function detectEnvAuth(env = process.env) {
  for (const name of AUTH_ENV_VARS) {
    const value = env[name];
    if (value && String(value).trim()) {
      return { source: "env", varName: name };
    }
  }
  return null;
}

function detectMacKeychainAuth(options = {}) {
  const platform = options.platform ?? process.platform;
  const run = options.runCommand ?? runCommand;
  if (platform !== "darwin") {
    return null;
  }
  for (const service of COPILOT_SECRET_SERVICES) {
    const result = run("security", ["find-generic-password", "-s", service]);
    if (result.status === 0) {
      return { source: "keychain", service };
    }
  }
  return null;
}

// Parse `secret-tool search` stdout. The binary prints `[/secret/...]`
// followed by key=value lines when it finds an entry, and exits non-zero
// (with empty stdout) when it doesn't. We treat any non-empty output as a
// match so we tolerate format differences across libsecret versions.
export function parseSecretToolOutput(stdout) {
  return Boolean(String(stdout ?? "").trim());
}

function detectLinuxSecretAuth(options = {}) {
  const platform = options.platform ?? process.platform;
  const run = options.runCommand ?? runCommand;
  const probeBinary = options.binaryAvailable ?? binaryAvailable;
  if (platform !== "linux") {
    return null;
  }
  // libsecret tooling is optional on minimal distros; only probe when
  // `secret-tool` is actually installed.
  const tool = probeBinary("secret-tool", ["--version"]);
  if (!tool.available) {
    return null;
  }
  for (const service of COPILOT_SECRET_SERVICES) {
    const result = run("secret-tool", ["search", "service", service]);
    if (result.status === 0 && parseSecretToolOutput(result.stdout)) {
      return { source: "libsecret", service };
    }
  }
  return null;
}

// Parse `cmdkey /list` stdout, looking for credentials whose target name
// hints at Copilot CLI. cmdkey output looks like:
//   Currently stored credentials:
//     Target: LegacyGeneric:target=copilot-cli
//     Type: Generic
//     User: ...
export function parseCmdKeyOutput(stdout) {
  const lines = String(stdout ?? "").split(/\r?\n/);
  for (const line of lines) {
    if (/target=.*copilot/i.test(line) || /Target:\s*.*copilot/i.test(line)) {
      const match = line.match(/target=([^\s]+)/i) || line.match(/Target:\s*(.+)/i);
      return match ? match[1].trim() : line.trim();
    }
  }
  return null;
}

function detectWindowsCredentialAuth(options = {}) {
  const platform = options.platform ?? process.platform;
  const run = options.runCommand ?? runCommand;
  const probeBinary = options.binaryAvailable ?? binaryAvailable;
  if (platform !== "win32") {
    return null;
  }
  const tool = probeBinary("cmdkey", ["/list"]);
  if (!tool.available) {
    return null;
  }
  const result = run("cmdkey", ["/list"]);
  if (result.status !== 0) {
    return null;
  }
  const target = parseCmdKeyOutput(result.stdout);
  if (target) {
    return { source: "wincred", target };
  }
  return null;
}

function detectPlaintextAuth(options = {}) {
  const homeDir = options.homedir ?? os.homedir();
  const existsImpl = options.existsSync ?? fs.existsSync;
  const statImpl = options.statSync ?? fs.statSync;
  const candidates = [
    path.join(homeDir, ".copilot", "auth.json"),
    path.join(homeDir, ".copilot", "credentials.json")
  ];
  for (const filePath of candidates) {
    if (existsImpl(filePath)) {
      try {
        const stat = statImpl(filePath);
        if (stat.size > 0) {
          return { source: "plaintext", file: filePath };
        }
      } catch {
        // ignore
      }
    }
  }
  return null;
}

export function getCopilotAuthStatus(cwd, options = {}) {
  const availability = getCopilotAvailability(cwd);
  if (!availability.available) {
    return {
      available: false,
      loggedIn: false,
      detail: availability.detail,
      source: "availability"
    };
  }

  const envAuth = detectEnvAuth(options.env ?? process.env);
  if (envAuth) {
    return {
      available: true,
      loggedIn: true,
      detail: `Authenticated via env var ${envAuth.varName}`,
      source: envAuth.source
    };
  }

  const probeOptions = {
    platform: options.platform,
    runCommand: options.runCommand,
    binaryAvailable: options.binaryAvailable,
    homedir: options.homedir,
    existsSync: options.existsSync,
    statSync: options.statSync
  };

  const keychainAuth = detectMacKeychainAuth(probeOptions);
  if (keychainAuth) {
    return {
      available: true,
      loggedIn: true,
      detail: `Authenticated via macOS keychain (${keychainAuth.service})`,
      source: keychainAuth.source
    };
  }

  const libsecretAuth = detectLinuxSecretAuth(probeOptions);
  if (libsecretAuth) {
    return {
      available: true,
      loggedIn: true,
      detail: `Authenticated via libsecret (${libsecretAuth.service})`,
      source: libsecretAuth.source
    };
  }

  const winCredAuth = detectWindowsCredentialAuth(probeOptions);
  if (winCredAuth) {
    return {
      available: true,
      loggedIn: true,
      detail: `Authenticated via Windows Credential Manager (${winCredAuth.target})`,
      source: winCredAuth.source
    };
  }

  const plaintextAuth = detectPlaintextAuth(probeOptions);
  if (plaintextAuth) {
    return {
      available: true,
      loggedIn: true,
      detail: `Authenticated via plaintext file ${plaintextAuth.file}`,
      source: plaintextAuth.source
    };
  }

  return {
    available: true,
    loggedIn: false,
    detail:
      "Not authenticated. Run `!copilot login` (stores credentials in the OS keyring on macOS/Linux/Windows or as a plaintext file as a fallback), or set COPILOT_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN.",
    source: "unknown"
  };
}

function parseJsonlChunk(buffer, onEvent) {
  let working = buffer;
  while (true) {
    const newlineIndex = working.indexOf("\n");
    if (newlineIndex === -1) {
      return working;
    }
    const line = working.slice(0, newlineIndex).trim();
    working = working.slice(newlineIndex + 1);
    if (!line) {
      continue;
    }
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    onEvent(event);
  }
}

function describeEvent(event) {
  switch (event.type) {
    case "session.mcp_server_status_changed":
    case "session.mcp_servers_loaded":
    case "session.skills_loaded":
    case "session.tools_updated":
      return null;
    case "user.message":
      return { message: "Prompt delivered to Copilot.", phase: "starting" };
    case "assistant.turn_start":
      return { message: `Turn started (${event.data?.turnId ?? ""}).`, phase: "starting" };
    case "assistant.reasoning":
      return { message: "Reasoning step recorded.", phase: "investigating" };
    case "assistant.message_start":
    case "assistant.message_delta":
      return null;
    case "assistant.message": {
      const phase = event.data?.phase === "final_answer" ? "finalizing" : "investigating";
      const preview = shorten(event.data?.content, 96);
      const tools = Array.isArray(event.data?.toolRequests) ? event.data.toolRequests.length : 0;
      return {
        message: preview
          ? `Assistant message (${tools} tool requests): ${preview}`
          : `Assistant message (${tools} tool requests).`,
        phase
      };
    }
    case "assistant.turn_end":
      return { message: `Turn ended (${event.data?.turnId ?? ""}).`, phase: "finalizing" };
    case "tool.call_start":
      return {
        message: `Calling tool: ${event.data?.name ?? event.data?.tool ?? "unknown"}.`,
        phase: "investigating"
      };
    case "tool.call_end":
      return {
        message: `Tool ${event.data?.name ?? event.data?.tool ?? "call"} completed.`,
        phase: "investigating"
      };
    case "command.start":
      return {
        message: `Running command: ${shorten(event.data?.command ?? "", 96)}`,
        phase: "running"
      };
    case "command.end":
      return {
        message: `Command finished (exit ${event.data?.exitCode ?? "?"}).`,
        phase: "running"
      };
    case "file.change":
      return { message: `File changed: ${event.data?.path ?? ""}`, phase: "editing" };
    case "result":
      return {
        message: `Copilot session ${event.exitCode === 0 ? "completed" : "failed"} (exit ${event.exitCode}).`,
        phase: event.exitCode === 0 ? "finalizing" : "failed"
      };
    default:
      return null;
  }
}

function captureFinalAnswer(state, event) {
  if (event.type === "assistant.message" && event.data?.phase === "final_answer") {
    const text = typeof event.data.content === "string" ? event.data.content : "";
    if (text) {
      state.lastFinalAnswer = text;
      state.turnId = event.data.turnId ?? state.turnId;
      emitLogEvent(state.onProgress, {
        message: "Final answer captured.",
        phase: "finalizing",
        logTitle: "Assistant message",
        logBody: text
      });
    }
    return;
  }
  if (event.type === "assistant.message" && typeof event.data?.content === "string" && event.data.content) {
    state.lastFinalAnswer = event.data.content;
    state.turnId = event.data.turnId ?? state.turnId;
  }
  if (event.type === "result") {
    if (event.sessionId) {
      state.sessionId = event.sessionId;
    }
    if (typeof event.exitCode === "number") {
      state.resultExitCode = event.exitCode;
    }
  }
}

function buildCopilotArgs(options) {
  const args = [];

  if (options.prompt) {
    args.push("-p", options.prompt);
  }

  args.push("--output-format", "json");
  args.push("--no-color");
  args.push("--no-auto-update");

  if (options.allowAllTools !== false) {
    args.push("--allow-all-tools");
  }

  if (options.model) {
    args.push("--model", options.model);
  }

  if (options.effort) {
    args.push("--effort", options.effort);
  }

  if (options.resumeSessionId) {
    args.push(`--resume=${options.resumeSessionId}`);
  } else if (options.continueLast) {
    args.push("--continue");
  }

  if (options.sessionName) {
    args.push("--name", options.sessionName);
  }

  if (Array.isArray(options.addDirs)) {
    for (const dir of options.addDirs) {
      args.push("--add-dir", dir);
    }
  }

  if (Array.isArray(options.denyTools)) {
    for (const tool of options.denyTools) {
      args.push(`--deny-tool=${tool}`);
    }
  }

  if (Array.isArray(options.extraArgs)) {
    args.push(...options.extraArgs);
  }

  return args;
}

function killChild(child, signal = "SIGTERM") {
  try {
    if (process.platform !== "win32") {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        // fall through to direct kill
      }
    }
    child.kill(signal);
  } catch {
    // ignore
  }
}

export function runCopilotPrompt(cwd, options = {}) {
  const availability = getCopilotAvailability(cwd);
  if (!availability.available) {
    return Promise.reject(
      new Error(
        "GitHub Copilot CLI is not installed. Install it with `npm install -g @github/copilot`, then rerun `/copilot:setup`."
      )
    );
  }

  if (!options.prompt && !options.resumeSessionId && !options.continueLast) {
    return Promise.reject(new Error("A prompt is required for this Copilot run."));
  }

  const args = buildCopilotArgs(options);
  const onProgress = options.onProgress ?? null;

  emitProgress(onProgress, "Starting Copilot.", "starting");

  return new Promise((resolve, reject) => {
    const child = spawn(COPILOT_BIN, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32"
    });

    const state = {
      onProgress,
      lastFinalAnswer: "",
      sessionId: null,
      turnId: null,
      resultExitCode: null,
      stderrBuffer: "",
      stdoutBuffer: "",
      cancelled: false
    };

    if (options.signal && typeof options.signal.addEventListener === "function") {
      options.signal.addEventListener(
        "abort",
        () => {
          state.cancelled = true;
          killChild(child, "SIGTERM");
        },
        { once: true }
      );
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk) => {
      state.stdoutBuffer += chunk;
      state.stdoutBuffer = parseJsonlChunk(state.stdoutBuffer, (event) => {
        captureFinalAnswer(state, event);
        const description = describeEvent(event);
        if (description) {
          const extra = {};
          if (state.sessionId) {
            extra.threadId = state.sessionId;
          }
          if (state.turnId) {
            extra.turnId = String(state.turnId);
          }
          emitProgress(onProgress, description.message, description.phase, extra);
        }
      });
    });

    child.stderr.on("data", (chunk) => {
      state.stderrBuffer += chunk;
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code, signal) => {
      // Flush any trailing JSONL line
      const tail = state.stdoutBuffer.trim();
      if (tail) {
        try {
          const event = JSON.parse(tail);
          captureFinalAnswer(state, event);
        } catch {
          // ignore
        }
      }

      const exitStatus = state.cancelled ? 130 : state.resultExitCode ?? (code === 0 ? 0 : code ?? 1);

      resolve({
        status: exitStatus,
        signal,
        threadId: state.sessionId,
        turnId: state.turnId,
        finalMessage: state.lastFinalAnswer,
        stderr: state.stderrBuffer
      });
    });
  });
}

export function buildPersistentTaskSessionName(prompt) {
  const excerpt = shorten(prompt, 56);
  return excerpt ? `copilot-task ${excerpt}` : "copilot-task";
}
