import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

import { binaryAvailable, runCommand } from "./process.mjs";

export const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current session state. Pick the next highest-value step and follow through until the task is resolved.";

const COPILOT_BIN = "copilot";
// Auth env vars in Copilot's documented precedence order. Source of truth:
// `copilot help environment` (verified against Copilot CLI 1.0.52 in 0.6.0):
//   `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN` (in order of precedence):
//   an authentication token that takes precedence over previously stored
//   credentials.
// Keep this list in this exact order if you ever edit it — Copilot consults
// them in this order before falling back to keychain/libsecret/wincred.
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
    detail: extractVersionLine(versionStatus.detail)
  };
}

// Copilot CLI auto-loads custom instructions from a fixed set of paths
// (see https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-best-practices#use-custom-instructions-files).
// We don't load them ourselves — Copilot does. But the setup report should
// surface whether any are present so the user knows what the agent will
// pick up automatically. Detection is best-effort: missing entries are
// silently omitted; we never error on a probe.
const INSTRUCTIONS_PROBES = [
  { rel: ".github/copilot-instructions.md", scope: "repo" },
  { rel: "AGENTS.md", scope: "repo" },
  { rel: "Copilot.md", scope: "repo" },
  { rel: "GEMINI.md", scope: "repo" },
  { rel: "CODEX.md", scope: "repo" }
];

export function detectInstructionsFiles(cwd, options = {}) {
  const exists = options.existsSync ?? fs.existsSync;
  const home = options.homedir ?? os.homedir();
  const readdir = options.readdirSync ?? fs.readdirSync;
  const found = [];

  // 1. Global instructions at ~/.copilot/copilot-instructions.md
  const globalPath = path.join(home, ".copilot", "copilot-instructions.md");
  if (exists(globalPath)) {
    found.push({ path: globalPath, scope: "global" });
  }

  // 2. Repo-scoped fixed paths
  for (const probe of INSTRUCTIONS_PROBES) {
    const abs = path.join(cwd, probe.rel);
    if (exists(abs)) {
      found.push({ path: abs, scope: probe.scope });
    }
  }

  // 3. Modular per-repo: .github/instructions/*.instructions.md (any file).
  // We only list the directory if it exists — `readdir` on a missing dir
  // would throw and we don't want detection to fail.
  const modularDir = path.join(cwd, ".github", "instructions");
  if (exists(modularDir)) {
    try {
      const entries = readdir(modularDir);
      for (const name of entries) {
        if (typeof name === "string" && name.endsWith(".instructions.md")) {
          found.push({ path: path.join(modularDir, name), scope: "repo-modular" });
        }
      }
    } catch {
      // Ignore unreadable dirs — best-effort detection.
    }
  }

  return found;
}

// `copilot --version` prints the version on the first line, sometimes
// followed by an "Run 'copilot update' to check for updates." advisory.
// Keep only the version line in the setup report.
export function extractVersionLine(detail) {
  if (typeof detail !== "string") {
    return detail;
  }
  const firstNonEmpty = detail
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return firstNonEmpty ?? detail.trim();
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

export function describeEvent(event) {
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

export function captureFinalAnswer(state, event) {
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

/**
 * Pure extractor: given a single Copilot JSONL event, return the file
 * path it touched, or null if the event is not a file change.
 *
 * Exported so tests can pin the exact shape we expect from Copilot's
 * `file.change` events. If a future Copilot version renames the field
 * or wraps the path, this is the one place to update.
 */
export function extractTouchedFilePath(event) {
  if (!event || event.type !== "file.change") {
    return null;
  }
  const candidate =
    typeof event.data?.path === "string" && event.data.path.trim()
      ? event.data.path.trim()
      : null;
  return candidate;
}

export function buildCopilotArgs(options) {
  const args = [];

  if (options.prompt) {
    args.push("-p", options.prompt);
  }

  args.push("--output-format", "json");
  args.push("--no-color");

  // E2 / 0.8.0 — `--no-auto-update` keeps the binary version pinned for
  // the duration of the job. Mid-run upgrades would change behavior under
  // us (we test against a known Copilot CLI version per release). Escape
  // hatch `allowAutoUpdate` suppresses the `--no-` flag and falls back to
  // Copilot's own default (auto-update on outside CI).
  if (!options.allowAutoUpdate) {
    args.push("--no-auto-update");
  }

  if (options.allowAllTools !== false) {
    args.push("--allow-all-tools");
  }

  // A / 0.7.0 — privacy + non-stalling defaults for non-interactive runs.
  //   `--no-remote` disables remote control of the session from GitHub
  //   web/mobile (privacy hardening — we're a local plugin, the user
  //   never opted into a remote handoff).
  //   `--no-ask-user` disables the `ask_user` tool so the agent doesn't
  //   block waiting on a human while we're parsing JSONL with no stdin.
  // Both are escape-hatch-able: `allowRemote` / `allowAskUser` suppress
  // the corresponding `--no-*` flag (we don't emit a positive flag —
  // Copilot's default *is* remote-on / ask-user-on, so suppressing our
  // override is enough).
  if (!options.allowRemote) {
    args.push("--no-remote");
  }
  if (!options.allowAskUser) {
    args.push("--no-ask-user");
  }

  // E1 / 0.8.0 — `--secret-env-vars=<name>` strips the named env var's
  // VALUE from shell and MCP server environments and redacts it from
  // output. Defense-in-depth alongside the existing `denyTools` /
  // privacy defaults: even if a tool is allowed and reads env, Copilot
  // scrubs the value at the boundary. Forwarded as one flag per entry
  // (Copilot accepts the comma-list form too, but per-entry composes
  // cleanly with our existing helpers).
  if (Array.isArray(options.secretEnvVars)) {
    for (const name of options.secretEnvVars) {
      if (typeof name === "string" && name.trim()) {
        args.push(`--secret-env-vars=${name.trim()}`);
      }
    }
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

  // D5: plan mode produces a structured plan.md before any code is written.
  // D6: autopilot mode lets Copilot auto-continue across multiple turns.
  // Mutually exclusive at the CLI level — we only pass one if both are set.
  if (options.planMode) {
    args.push("--plan");
  } else if (options.autopilot) {
    args.push("--autopilot");
    if (Number.isFinite(options.maxAutopilotContinues) && options.maxAutopilotContinues > 0) {
      args.push("--max-autopilot-continues", String(options.maxAutopilotContinues));
    }
  }

  // D8: bypass AGENTS.md / .github/copilot-instructions for "fresh eyes"
  // reviews. Opt-in — defaults to the agent picking up repo instructions.
  if (options.noCustomInstructions) {
    args.push("--no-custom-instructions");
  }

  // D7 / 0.6.0 — pass-through for Copilot's native share flags.
  //   `--share[=path]` writes a markdown transcript after a non-interactive
  //   run completes (default `./copilot-session-<id>.md`). Setting an
  //   explicit `shareMarkdownPath` implies `shareMarkdown` — emit the
  //   `=path` form so we don't double-emit a bare `--share`.
  //   `--share-gist` uploads the transcript to a secret GitHub gist.
  if (typeof options.shareMarkdownPath === "string" && options.shareMarkdownPath.trim()) {
    args.push(`--share=${options.shareMarkdownPath.trim()}`);
  } else if (options.shareMarkdown) {
    args.push("--share");
  }
  if (options.shareGist) {
    args.push("--share-gist");
  }

  // D9 / 0.6.0 — MCP pass-through.
  //   `--add-github-mcp-tool <tool>` (repeatable) opts a single GitHub MCP
  //   tool back in on top of the default CLI subset.
  //   `--additional-mcp-config <json|@path>` (repeatable) augments the user's
  //   `~/.copilot/mcp-config.json` for this session only.
  // Both flags are Copilot-native; we only forward what's set. Wired only
  // for /copilot:rescue (task) and /copilot:plan upstream — reviews stay
  // untouched to preserve the read-only contract.
  if (Array.isArray(options.addGithubMcpTools)) {
    for (const tool of options.addGithubMcpTools) {
      if (typeof tool === "string" && tool.trim()) {
        args.push("--add-github-mcp-tool", tool.trim());
      }
    }
  }
  if (Array.isArray(options.additionalMcpConfigs)) {
    for (const cfg of options.additionalMcpConfigs) {
      if (typeof cfg === "string" && cfg.trim()) {
        args.push("--additional-mcp-config", cfg.trim());
      }
    }
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

  // B / 0.7.0 — symmetric allow/deny pass-through for tools and URLs.
  //   Copilot's permission model: denial rules ALWAYS take precedence
  //   over allow rules, even `--allow-all-tools` (verified in
  //   `copilot help permissions` on CLI 1.0.52). So even on a review
  //   where `denyTools` enforces `write,shell`, a user-supplied
  //   `--allow-tool=shell` is a no-op against the baseline — the
  //   read-only invariant survives at the Copilot level.
  // Each value is forwarded as one `--allow-tool=<pat>` / `--allow-url=<pat>` /
  // `--deny-url=<pat>` (space-less form, matching our existing
  // `--deny-tool=<pat>` style).
  if (Array.isArray(options.allowTools)) {
    for (const pat of options.allowTools) {
      if (typeof pat === "string" && pat.trim()) {
        args.push(`--allow-tool=${pat.trim()}`);
      }
    }
  }
  if (Array.isArray(options.allowUrls)) {
    for (const pat of options.allowUrls) {
      if (typeof pat === "string" && pat.trim()) {
        args.push(`--allow-url=${pat.trim()}`);
      }
    }
  }
  if (Array.isArray(options.denyUrls)) {
    for (const pat of options.denyUrls) {
      if (typeof pat === "string" && pat.trim()) {
        args.push(`--deny-url=${pat.trim()}`);
      }
    }
  }

  // C / 0.7.0 — `--attachment <path>` pass-through (rescue only at the
  // command layer; this builder accepts any caller). Copilot accepts the
  // flag repeatedly. We do NOT validate file existence here — that's the
  // command/companion layer's job, so a programmatic caller can pass a
  // path that doesn't exist yet (e.g., a planned screenshot).
  if (Array.isArray(options.attachments)) {
    for (const attachment of options.attachments) {
      if (typeof attachment === "string" && attachment.trim()) {
        args.push("--attachment", attachment.trim());
      }
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
      cancelled: false,
      // Preserve insertion order of distinct file paths so the rendered
      // summary lists files in the order Copilot actually touched them.
      touchedFiles: new Set()
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
        const touched = extractTouchedFilePath(event);
        if (touched) {
          state.touchedFiles.add(touched);
        }
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
          const tailTouched = extractTouchedFilePath(event);
          if (tailTouched) {
            state.touchedFiles.add(tailTouched);
          }
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
        stderr: state.stderrBuffer,
        touchedFiles: [...state.touchedFiles]
      });
    });
  });
}

export function buildPersistentTaskSessionName(prompt) {
  const excerpt = shorten(prompt, 56);
  return excerpt ? `copilot-task ${excerpt}` : "copilot-task";
}
