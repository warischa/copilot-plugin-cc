// User-scoped plugin defaults (DESIGN.md §5 item 5).
//
// Lives at `~/.claude/plugins/copilot/config.json` and stores defaults
// that get injected into every Copilot run when the user doesn't pass
// them explicitly on the CLI.
//
// Why user-scoped (and not workspace-scoped via state.json)?
//   - The existing setConfig/getConfig in state.mjs is per-repo, useful
//     for run-tracking metadata. Defaults like `model` and `effort` are
//     much more "this is who I am" than "this repo wants X", so a user-
//     level file is the right default. Future work can layer a per-repo
//     override on top without changing this file's shape.
//
// Why a flat JSON file (not the state.json envelope)?
//   - The user is expected to edit this by hand. Keep it minimal.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const ENV_OVERRIDE = "COPILOT_PLUGIN_CONFIG_PATH";
const DEFAULT_REL_PATH = path.join(".claude", "plugins", "copilot", "config.json");

const VALID_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);

export function resolvePluginConfigPath(options = {}) {
  const env = options.env ?? process.env;
  if (env[ENV_OVERRIDE] && String(env[ENV_OVERRIDE]).trim()) {
    return path.resolve(String(env[ENV_OVERRIDE]).trim());
  }
  const homeDir = options.homedir ?? os.homedir();
  return path.join(homeDir, DEFAULT_REL_PATH);
}

/**
 * Read the plugin config file and return only the recognized, validated
 * fields. Unknown keys and malformed values are dropped with a stderr
 * warning rather than throwing — a bad config should never block a
 * working review/task command.
 *
 * Returns `{ model?: string, effort?: string, _path: string,
 *   _warnings: string[] }`. `_path` is always populated so callers can
 * show it to the user.
 */
export function loadPluginConfig(options = {}) {
  const filePath = options.path ?? resolvePluginConfigPath(options);
  const readFile = options.readFileSync ?? fs.readFileSync;
  const exists = options.existsSync ?? fs.existsSync;
  const warnings = [];

  if (!exists(filePath)) {
    return { _path: filePath, _warnings: warnings };
  }

  let parsed;
  try {
    const raw = readFile(filePath, "utf8");
    parsed = JSON.parse(raw);
  } catch (err) {
    warnings.push(
      `Could not read plugin config at ${filePath}: ${err.message}. Ignoring it.`
    );
    return { _path: filePath, _warnings: warnings };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    warnings.push(
      `Plugin config at ${filePath} is not a JSON object. Ignoring it.`
    );
    return { _path: filePath, _warnings: warnings };
  }

  const cleaned = { _path: filePath, _warnings: warnings };

  if (parsed.model != null) {
    const model = String(parsed.model).trim();
    if (model) {
      cleaned.model = model;
    } else {
      warnings.push(`Plugin config "model" is empty; ignoring.`);
    }
  }

  if (parsed.effort != null) {
    const effort = String(parsed.effort).trim().toLowerCase();
    if (VALID_EFFORTS.has(effort)) {
      cleaned.effort = effort;
    } else {
      warnings.push(
        `Plugin config "effort" value "${parsed.effort}" is not one of low|medium|high|xhigh; ignoring.`
      );
    }
  }

  return cleaned;
}

/**
 * Merge plugin-config defaults into a parsed CLI options object. CLI
 * values always win. Returns a new object — does not mutate `cliOptions`.
 *
 * Only fills the keys we recognize (`model`, `effort`). Other config
 * fields are reserved for future extensions and are intentionally not
 * propagated yet so adding them later is a strictly additive change.
 */
export function applyPluginDefaults(cliOptions, pluginConfig) {
  const next = { ...cliOptions };
  if (!pluginConfig) {
    return next;
  }
  if (next.model == null && pluginConfig.model) {
    next.model = pluginConfig.model;
  }
  if (next.effort == null && pluginConfig.effort) {
    next.effort = pluginConfig.effort;
  }
  return next;
}

/**
 * Emit any warnings produced during config load to stderr exactly once.
 * Callers should invoke this near the top of a command handler so the
 * user sees the diagnostic before the long-running Copilot output
 * starts streaming.
 */
export function reportPluginConfigWarnings(pluginConfig, options = {}) {
  if (!pluginConfig || !Array.isArray(pluginConfig._warnings)) {
    return;
  }
  const write = options.write ?? ((line) => process.stderr.write(line));
  for (const warning of pluginConfig._warnings) {
    write(`[copilot] ${warning}\n`);
  }
}
