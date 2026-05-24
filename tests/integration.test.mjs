// Integration smoke test against the real `copilot` binary.
// Skips if copilot is not installed or not authenticated (DESIGN.md §5 item 1).

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(TEST_FILE), "..");
const COMPANION = path.join(REPO_ROOT, "plugins/copilot/scripts/copilot-companion.mjs");

const { getCopilotAuthStatus } = await import(
  "../plugins/copilot/scripts/lib/copilot.mjs"
);

const ORIGINAL_ENV = process.env.CLAUDE_PLUGIN_DATA;
let tempDir;
let skipReason = null;

// Opt-in gate: `npm test` defaults to skipping the integration test so it
// doesn't burn a real Copilot API call (~14s, one billable turn). Run with
// `COPILOT_INTEGRATION=1 npm test` to exercise the live path. Truthy values
// other than "1" (e.g. "true", "yes", "on") are also accepted.
const INTEGRATION_GATE_VALUES = new Set(["1", "true", "yes", "on"]);
function integrationGateEnabled(env = process.env) {
  const raw = env.COPILOT_INTEGRATION;
  if (raw == null) return false;
  return INTEGRATION_GATE_VALUES.has(String(raw).trim().toLowerCase());
}

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-plugin-integration-"));
  process.env.CLAUDE_PLUGIN_DATA = tempDir;

  if (!integrationGateEnabled()) {
    skipReason =
      "set COPILOT_INTEGRATION=1 to enable the live-copilot smoke test";
    return;
  }

  const status = getCopilotAuthStatus(REPO_ROOT);
  if (!status.available) {
    skipReason = `copilot binary not installed (${status.detail})`;
  } else if (!status.loggedIn) {
    skipReason = `copilot not authenticated (${status.detail})`;
  }
});

after(() => {
  if (ORIGINAL_ENV === undefined) {
    delete process.env.CLAUDE_PLUGIN_DATA;
  } else {
    process.env.CLAUDE_PLUGIN_DATA = ORIGINAL_ENV;
  }
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function runCompanion(args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [COMPANION, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, CLAUDE_PLUGIN_DATA: tempDir }
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`companion timed out after ${timeoutMs}ms. stderr: ${stderr}`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function findStateDir() {
  // CLAUDE_PLUGIN_DATA/state/<workspace-slug>/...
  const stateRoot = path.join(tempDir, "state");
  if (!fs.existsSync(stateRoot)) return null;
  const entries = fs.readdirSync(stateRoot);
  if (entries.length === 0) return null;
  return path.join(stateRoot, entries[0]);
}

describe("integration: real copilot via companion", () => {
  it(
    "task --json: captures final answer and persists threadId in stored job",
    { timeout: 150_000 },
    async (t) => {
      if (skipReason) {
        t.skip(skipReason);
        return;
      }

      const { code, stdout, stderr } = await runCompanion([
        "task",
        "Respond with exactly one lowercase word: hello",
        "--json"
      ]);

      assert.equal(code, 0, `companion exited ${code}. stderr:\n${stderr}`);

      let payload;
      try {
        payload = JSON.parse(stdout);
      } catch (err) {
        throw new Error(`stdout was not valid JSON. err=${err.message}\nstdout:\n${stdout}`);
      }

      // JSONL parse path captured the final answer.
      assert.equal(payload.status, 0, "copilot reported non-zero status");
      assert.ok(
        typeof payload.rawOutput === "string" && payload.rawOutput.length > 0,
        `expected rawOutput to be a non-empty string. payload=${JSON.stringify(payload)}`
      );
      assert.match(
        payload.rawOutput.toLowerCase(),
        /hello/,
        `final answer did not contain 'hello'. rawOutput=${payload.rawOutput}`
      );

      // result.sessionId landed in the response payload.
      assert.ok(
        typeof payload.threadId === "string" && payload.threadId.length > 0,
        `expected threadId (sessionId) to be captured. payload=${JSON.stringify(payload)}`
      );

      // touchedFiles is always present, even if empty, so consumers can
      // rely on the shape without conditionals.
      assert.ok(
        Array.isArray(payload.touchedFiles),
        `expected touchedFiles to be an array. payload=${JSON.stringify(payload)}`
      );
      assert.equal(
        payload.touchedFiles.length,
        0,
        `expected no files touched for a 'hello' prompt. got=${JSON.stringify(payload.touchedFiles)}`
      );

      // And it must have been persisted to the stored job file.
      const stateDir = findStateDir();
      assert.ok(stateDir, `expected a workspace state dir under ${tempDir}/state`);
      const jobsDir = path.join(stateDir, "jobs");
      const jobFiles = fs.readdirSync(jobsDir).filter((f) => f.endsWith(".json"));
      assert.ok(jobFiles.length >= 1, "expected at least one stored job file");

      const storedJobs = jobFiles.map((f) =>
        JSON.parse(fs.readFileSync(path.join(jobsDir, f), "utf8"))
      );
      const completed = storedJobs.find((j) => j.status === "completed");
      assert.ok(completed, `expected at least one completed job. jobs=${JSON.stringify(storedJobs, null, 2)}`);
      assert.equal(
        completed.threadId,
        payload.threadId,
        "stored job's threadId should match the session id returned by the run"
      );
    }
  );
});
