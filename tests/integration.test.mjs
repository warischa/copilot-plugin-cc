// Integration smoke test against the real `copilot` binary.
// Skips if copilot is not installed or not authenticated (DESIGN.md §5 item 1).

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
const createdRepos = [];

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
  for (const repo of createdRepos) {
    fs.rmSync(repo, { recursive: true, force: true });
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

// Build a throwaway git repo with one committed file plus an uncommitted
// modification, so the review path has a real working-tree diff to chew on.
// Returns the repo's absolute path; registered for teardown in `after`.
function makeReviewRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-plugin-review-"));
  createdRepos.push(repo);
  const filePath = path.join(repo, "math.js");
  // Avoid touching the developer's global git identity.
  const git = (...args) => {
    const res = spawnSync(
      "git",
      ["-c", "user.email=test@example.com", "-c", "user.name=Test", ...args],
      { cwd: repo, encoding: "utf8" }
    );
    if (res.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
    }
  };
  git("init", "-q");
  fs.writeFileSync(filePath, "export function add(a, b) {\n  return a + b;\n}\n");
  git("add", "-A");
  git("commit", "-q", "-m", "baseline");
  // Working-tree change with an obvious bug for the reviewer to notice.
  fs.writeFileSync(filePath, "export function add(a, b) {\n  return a - b; // bug: should add\n}\n");
  return { repo, filePath };
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

describe("integration: setup against the real binary", () => {
  it(
    "setup --json: reports the installed + authenticated copilot binary",
    { timeout: 30_000 },
    async (t) => {
      // The gate's before() already confirmed available + loggedIn, so a
      // green gate means setup must agree. No API call is spent here — setup
      // only probes the binary + auth, so it's the cheap end of the live tier.
      if (skipReason) {
        t.skip(skipReason);
        return;
      }

      const { code, stdout, stderr } = await runCompanion(["setup", "--json"]);
      assert.equal(code, 0, `companion exited ${code}. stderr:\n${stderr}`);

      let report;
      try {
        report = JSON.parse(stdout);
      } catch (err) {
        throw new Error(`stdout was not valid JSON. err=${err.message}\nstdout:\n${stdout}`);
      }

      assert.equal(report.copilot?.available, true, `expected copilot available. report=${JSON.stringify(report)}`);
      assert.equal(report.auth?.loggedIn, true, `expected copilot authenticated. report=${JSON.stringify(report)}`);
      assert.equal(report.ready, true, `expected setup ready. report=${JSON.stringify(report)}`);
      assert.ok(Array.isArray(report.nextSteps), "nextSteps should be an array");
      assert.equal(report.nextSteps.length, 0, `a ready setup should have no next steps. got=${JSON.stringify(report.nextSteps)}`);
    }
  );
});

describe("integration: review + adversarial-review against the real binary", () => {
  it(
    "review --json: returns a non-empty review, captures threadId, and never mutates the tree",
    { timeout: 180_000 },
    async (t) => {
      if (skipReason) {
        t.skip(skipReason);
        return;
      }

      const { repo, filePath } = makeReviewRepo();
      const before = fs.readFileSync(filePath, "utf8");

      const { code, stdout, stderr } = await runCompanion([
        "review",
        "--cwd",
        repo,
        "--json"
      ]);
      assert.equal(code, 0, `companion exited ${code}. stderr:\n${stderr}`);

      let payload;
      try {
        payload = JSON.parse(stdout);
      } catch (err) {
        throw new Error(`stdout was not valid JSON. err=${err.message}\nstdout:\n${stdout}`);
      }

      assert.equal(payload.copilot?.status, 0, `copilot reported non-zero status. payload=${JSON.stringify(payload)}`);
      assert.ok(
        typeof payload.rawOutput === "string" && payload.rawOutput.trim().length > 0,
        `expected a non-empty review. payload=${JSON.stringify(payload)}`
      );
      assert.ok(
        typeof payload.threadId === "string" && payload.threadId.length > 0,
        `expected threadId (sessionId) to be captured. payload=${JSON.stringify(payload)}`
      );

      // Read-only invariant: the deny-tool=write,shell baseline must keep the
      // reviewed file byte-for-byte unchanged.
      assert.equal(
        fs.readFileSync(filePath, "utf8"),
        before,
        "review must not mutate the working tree"
      );

      // The job persisted as completed for this (single-job) workspace, so it
      // surfaces as latestFinished in the status snapshot.
      const completed = await runCompanion(["status", "--cwd", repo, "--json"]);
      const snapshot = JSON.parse(completed.stdout);
      const reviewJob = snapshot.latestFinished;
      assert.ok(reviewJob, `expected a finished review job in status. snapshot=${JSON.stringify(snapshot)}`);
      assert.equal(reviewJob.kind, "review", `expected a review job. job=${JSON.stringify(reviewJob)}`);
      assert.equal(reviewJob.status, "completed", `review job not completed. job=${JSON.stringify(reviewJob)}`);
    }
  );

  it(
    "adversarial-review --json: accepts a focus arg and returns a non-empty review",
    { timeout: 180_000 },
    async (t) => {
      if (skipReason) {
        t.skip(skipReason);
        return;
      }

      const { repo, filePath } = makeReviewRepo();
      const before = fs.readFileSync(filePath, "utf8");

      const { code, stdout, stderr } = await runCompanion([
        "adversarial-review",
        "focus on arithmetic correctness",
        "--cwd",
        repo,
        "--json"
      ]);
      assert.equal(code, 0, `companion exited ${code}. stderr:\n${stderr}`);

      let payload;
      try {
        payload = JSON.parse(stdout);
      } catch (err) {
        throw new Error(`stdout was not valid JSON. err=${err.message}\nstdout:\n${stdout}`);
      }

      assert.equal(payload.copilot?.status, 0, `copilot reported non-zero status. payload=${JSON.stringify(payload)}`);
      assert.ok(
        typeof payload.rawOutput === "string" && payload.rawOutput.trim().length > 0,
        `expected a non-empty adversarial review. payload=${JSON.stringify(payload)}`
      );
      assert.ok(
        typeof payload.threadId === "string" && payload.threadId.length > 0,
        `expected threadId (sessionId) to be captured. payload=${JSON.stringify(payload)}`
      );
      assert.equal(
        fs.readFileSync(filePath, "utf8"),
        before,
        "adversarial review must not mutate the working tree"
      );
    }
  );
});

describe("integration: background task lifecycle (worker + status + result)", () => {
  it(
    "task --background → status --wait → result: drives a detached worker to completion",
    { timeout: 200_000 },
    async (t) => {
      if (skipReason) {
        t.skip(skipReason);
        return;
      }

      // Enqueue: spawns the detached task-worker subprocess.
      const queued = await runCompanion([
        "task",
        "Respond with exactly one lowercase word: ping",
        "--background",
        "--json"
      ]);
      assert.equal(queued.code, 0, `enqueue exited ${queued.code}. stderr:\n${queued.stderr}`);

      const queuedPayload = JSON.parse(queued.stdout);
      const jobId = queuedPayload.jobId;
      assert.ok(typeof jobId === "string" && jobId.length > 0, `expected a jobId. payload=${JSON.stringify(queuedPayload)}`);
      assert.equal(queuedPayload.status, "queued", `expected queued status. payload=${JSON.stringify(queuedPayload)}`);

      // Wait: the companion polls the worker's job file until it leaves the
      // active state. This exercises handleTaskWorker → runTrackedJob end to end.
      const waited = await runCompanion([
        "status",
        jobId,
        "--wait",
        "--json",
        "--timeout-ms",
        "180000"
      ]);
      assert.equal(waited.code, 0, `status --wait exited ${waited.code}. stderr:\n${waited.stderr}`);

      const snapshot = JSON.parse(waited.stdout);
      assert.equal(snapshot.waitTimedOut, false, `worker did not finish in time. snapshot=${JSON.stringify(snapshot)}`);
      assert.equal(
        snapshot.job?.status,
        "completed",
        `background job did not complete. job=${JSON.stringify(snapshot.job)}`
      );

      // Result: the stored worker output is retrievable and carries the run.
      const resultRun = await runCompanion(["result", jobId, "--json"]);
      assert.equal(resultRun.code, 0, `result exited ${resultRun.code}. stderr:\n${resultRun.stderr}`);

      const result = JSON.parse(resultRun.stdout);
      const stored = result.storedJob;
      assert.ok(stored, `expected a storedJob payload. result=${JSON.stringify(result)}`);
      assert.equal(stored.status, "completed", `storedJob not completed. stored=${JSON.stringify(stored)}`);
      assert.ok(
        typeof stored.threadId === "string" && stored.threadId.length > 0,
        `expected stored threadId. stored=${JSON.stringify(stored)}`
      );
      // Assert the worker captured *some* final answer — not its exact text.
      // The model's word choice is nondeterministic (it may echo "pong"), so
      // matching specific content would make this lifecycle test flaky.
      assert.ok(
        stored.result && typeof stored.result.rawOutput === "string" && stored.result.rawOutput.trim().length > 0,
        `expected non-empty worker output. stored.result=${JSON.stringify(stored.result)}`
      );
      assert.equal(stored.result.status, 0, `worker reported non-zero copilot status. stored.result=${JSON.stringify(stored.result)}`);
    }
  );
});
