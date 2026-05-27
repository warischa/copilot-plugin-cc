// Integration test that spawns the companion CLI as a child process and
// asserts dispatcher behavior for subcommands that do NOT invoke copilot
// or touch the network. Mirrors conventions from tests/integration.test.mjs.

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

let tempDir;

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-companion-cli-"));
});

after(() => {
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function runCompanion(args, { timeoutMs = 15_000, cwd = REPO_ROOT } = {}) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      CLAUDE_PLUGIN_DATA: tempDir,
    };
    // Ensure session scoping doesn't interfere
    delete env.COPILOT_COMPANION_SESSION_ID;

    const child = spawn(process.execPath, [COMPANION, ...args], { cwd, env });

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

// Seed a job into state via the state.mjs helpers so `status` can find it.
async function seedJob(jobPatch) {
  const { upsertJob, writeJobFile } = await import(
    "../plugins/copilot/scripts/lib/state.mjs"
  );
  // state.mjs resolveStateDir uses CLAUDE_PLUGIN_DATA env + workspace root.
  // We set the env in-process temporarily so the helper writes to tempDir.
  const originalPluginData = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = tempDir;
  try {
    upsertJob(REPO_ROOT, jobPatch);
    writeJobFile(REPO_ROOT, jobPatch.id, { ...jobPatch });
  } finally {
    if (originalPluginData === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = originalPluginData;
    }
  }
}

describe("companion CLI dispatcher", () => {
  describe("help subcommand", () => {
    it("prints usage and exits 0", async () => {
      const { code, stdout } = await runCompanion(["help"]);
      assert.equal(code, 0);
      assert.match(stdout, /Usage:/);
      assert.match(stdout, /setup/);
      assert.match(stdout, /review/);
      assert.match(stdout, /task/);
      assert.match(stdout, /status/);
      assert.match(stdout, /result/);
      assert.match(stdout, /cancel/);
    });

    it("--help flag behaves like help subcommand", async () => {
      const { code, stdout } = await runCompanion(["--help"]);
      assert.equal(code, 0);
      assert.match(stdout, /Usage:/);
    });

    it("no subcommand prints usage and exits 0", async () => {
      const { code, stdout } = await runCompanion([]);
      assert.equal(code, 0);
      assert.match(stdout, /Usage:/);
    });
  });

  describe("unknown subcommand", () => {
    it("prints error to stderr and exits non-zero", async () => {
      const { code, stderr } = await runCompanion(["foobar-unknown"]);
      assert.notEqual(code, 0);
      assert.match(stderr, /Unknown subcommand: foobar-unknown/);
    });
  });

  describe("status on empty state", () => {
    it("reports no jobs and exits 0", async () => {
      const { code, stdout } = await runCompanion(["status"]);
      assert.equal(code, 0);
      assert.match(stdout, /No jobs recorded yet/);
    });

    it("--json reports empty running array and exits 0", async () => {
      const { code, stdout } = await runCompanion(["status", "--json"]);
      assert.equal(code, 0);
      const payload = JSON.parse(stdout);
      assert.ok(Array.isArray(payload.running));
      assert.equal(payload.running.length, 0);
      assert.equal(payload.latestFinished, null);
    });
  });

  describe("status with seeded job", () => {
    const JOB_ID = "test-job-status-seed";

    before(async () => {
      await seedJob({
        id: JOB_ID,
        status: "completed",
        kind: "task",
        title: "seeded test job",
        completedAt: new Date().toISOString()
      });
    });

    it("shows the seeded job in status output", async () => {
      const { code, stdout } = await runCompanion(["status", "--all"]);
      assert.equal(code, 0);
      assert.match(stdout, /seeded test job/);
    });

    it("--json includes the seeded job", async () => {
      const { code, stdout } = await runCompanion(["status", "--all", "--json"]);
      assert.equal(code, 0);
      const payload = JSON.parse(stdout);
      const allJobs = [
        ...(payload.running ?? []),
        payload.latestFinished,
        ...(payload.recent ?? [])
      ].filter(Boolean);
      const found = allJobs.some((j) => j.id === JOB_ID);
      assert.ok(found, `expected seeded job ${JOB_ID} in status output`);
    });

    it("single-job status by id", async () => {
      const { code, stdout } = await runCompanion(["status", JOB_ID]);
      assert.equal(code, 0);
      assert.match(stdout, /seeded test job/);
    });
  });

  describe("result with missing/unknown job", () => {
    it("no reference on empty state errors cleanly", async () => {
      // Use a fresh temp dir for isolation
      const freshTemp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-cli-result-"));
      try {
        const { code, stderr } = await new Promise((resolve, reject) => {
          const env = { ...process.env, CLAUDE_PLUGIN_DATA: freshTemp };
          delete env.COPILOT_COMPANION_SESSION_ID;
          const child = spawn(process.execPath, [COMPANION, "result"], { cwd: REPO_ROOT, env });
          let stdout = "";
          let stderr = "";
          child.stdout.setEncoding("utf8");
          child.stderr.setEncoding("utf8");
          child.stdout.on("data", (c) => { stdout += c; });
          child.stderr.on("data", (c) => { stderr += c; });
          child.on("error", reject);
          child.on("close", (code) => resolve({ code, stdout, stderr }));
        });
        assert.notEqual(code, 0);
        assert.match(stderr, /No finished Copilot jobs/);
      } finally {
        fs.rmSync(freshTemp, { recursive: true, force: true });
      }
    });

    it("unknown job reference errors cleanly", async () => {
      const { code, stderr } = await runCompanion(["result", "nonexistent-job-xyz"]);
      assert.notEqual(code, 0);
      assert.match(stderr, /No job found for "nonexistent-job-xyz"/);
    });
  });

  describe("cancel with missing/unknown job", () => {
    it("no reference on empty state errors cleanly", async () => {
      const freshTemp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-cli-cancel-"));
      try {
        const { code, stderr } = await new Promise((resolve, reject) => {
          const env = { ...process.env, CLAUDE_PLUGIN_DATA: freshTemp };
          delete env.COPILOT_COMPANION_SESSION_ID;
          const child = spawn(process.execPath, [COMPANION, "cancel"], { cwd: REPO_ROOT, env });
          let stdout = "";
          let stderr = "";
          child.stdout.setEncoding("utf8");
          child.stderr.setEncoding("utf8");
          child.stdout.on("data", (c) => { stdout += c; });
          child.stderr.on("data", (c) => { stderr += c; });
          child.on("error", reject);
          child.on("close", (code) => resolve({ code, stdout, stderr }));
        });
        assert.notEqual(code, 0);
        assert.match(stderr, /No active Copilot jobs to cancel/);
      } finally {
        fs.rmSync(freshTemp, { recursive: true, force: true });
      }
    });

    it("unknown job reference errors cleanly", async () => {
      const { code, stderr } = await runCompanion(["cancel", "nonexistent-cancel-xyz"]);
      assert.notEqual(code, 0);
      assert.match(stderr, /No job found for "nonexistent-cancel-xyz"/);
    });
  });

  describe("arg-parse error paths", () => {
    it("status --wait without job id errors cleanly", async () => {
      const { code, stderr } = await runCompanion(["status", "--wait"]);
      assert.notEqual(code, 0);
      assert.match(stderr, /requires a job id/);
    });
  });
});
