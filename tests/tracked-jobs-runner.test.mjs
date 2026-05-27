// Unit tests for the runTrackedJob async function from lib/tracked-jobs.mjs

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const { runTrackedJob } = await import("../plugins/copilot/scripts/lib/tracked-jobs.mjs");

const { writeJobFile, resolveJobFile, upsertJob, resolveJobLogFile } =
  await import("../plugins/copilot/scripts/lib/state.mjs");

let tempDir;
const ORIGINAL_PLUGIN_DATA = process.env.CLAUDE_PLUGIN_DATA;

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-tracked-jobs-runner-"));
  process.env.CLAUDE_PLUGIN_DATA = tempDir;
});

after(() => {
  if (ORIGINAL_PLUGIN_DATA === undefined) {
    delete process.env.CLAUDE_PLUGIN_DATA;
  } else {
    process.env.CLAUDE_PLUGIN_DATA = ORIGINAL_PLUGIN_DATA;
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// Seed a minimal job record in state so runTrackedJob has an existing entry to merge with.
function seedJob(jobId) {
  const cwd = process.cwd();
  const job = { id: jobId, workspaceRoot: cwd, status: "pending" };
  writeJobFile(cwd, jobId, job);
  upsertJob(cwd, job);
  return job;
}

// Builds a stub runner that resolves successfully with the given fields.
function stubSuccess({ payload = "output", rendered = "rendered output", exitStatus = 0,
                       threadId = "thread-1", turnId = "turn-1", summary = "done" } = {}) {
  return async () => ({ exitStatus, payload, rendered, threadId, turnId, summary });
}

// ---- runner invocation --------------------------------------------------

describe("runTrackedJob — runner invocation", () => {
  it("calls the provided async runner exactly once", async () => {
    let calls = 0;
    const job = seedJob("rtr-invoke");
    await runTrackedJob(job, async () => {
      calls += 1;
      return { exitStatus: 0, payload: null, rendered: null };
    });
    assert.equal(calls, 1);
  });
});

// ---- success path -------------------------------------------------------

describe("runTrackedJob — success (exitStatus 0)", () => {
  it("transitions stored job status to completed", async () => {
    const jobId = "rtr-success-status";
    const job = seedJob(jobId);
    await runTrackedJob(job, stubSuccess());
    const stored = JSON.parse(fs.readFileSync(resolveJobFile(process.cwd(), jobId), "utf8"));
    assert.equal(stored.status, "completed");
  });

  it("sets phase to done", async () => {
    const jobId = "rtr-success-phase";
    const job = seedJob(jobId);
    await runTrackedJob(job, stubSuccess());
    const stored = JSON.parse(fs.readFileSync(resolveJobFile(process.cwd(), jobId), "utf8"));
    assert.equal(stored.phase, "done");
  });

  it("persists runner payload as result field", async () => {
    const jobId = "rtr-success-payload";
    const job = seedJob(jobId);
    await runTrackedJob(job, stubSuccess({ payload: "my-result" }));
    const stored = JSON.parse(fs.readFileSync(resolveJobFile(process.cwd(), jobId), "utf8"));
    assert.equal(stored.result, "my-result");
  });

  it("persists runner rendered field", async () => {
    const jobId = "rtr-success-rendered";
    const job = seedJob(jobId);
    await runTrackedJob(job, stubSuccess({ rendered: "## Report" }));
    const stored = JSON.parse(fs.readFileSync(resolveJobFile(process.cwd(), jobId), "utf8"));
    assert.equal(stored.rendered, "## Report");
  });

  it("clears pid on completion", async () => {
    const jobId = "rtr-success-pid";
    const job = seedJob(jobId);
    await runTrackedJob(job, stubSuccess());
    const stored = JSON.parse(fs.readFileSync(resolveJobFile(process.cwd(), jobId), "utf8"));
    assert.equal(stored.pid, null);
  });

  it("records a completedAt timestamp", async () => {
    const jobId = "rtr-success-completedat";
    const job = seedJob(jobId);
    const before = Date.now();
    await runTrackedJob(job, stubSuccess());
    const after = Date.now();
    const stored = JSON.parse(fs.readFileSync(resolveJobFile(process.cwd(), jobId), "utf8"));
    assert.match(stored.completedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(Date.parse(stored.completedAt) >= before);
    assert.ok(Date.parse(stored.completedAt) <= after);
  });

  it("returns the execution object produced by the runner", async () => {
    const jobId = "rtr-success-return";
    const job = seedJob(jobId);
    const result = await runTrackedJob(job, stubSuccess({ payload: "returned" }));
    assert.equal(result.exitStatus, 0);
    assert.equal(result.payload, "returned");
  });

  it("treats non-zero exitStatus as failed (not completed)", async () => {
    const jobId = "rtr-nonzero";
    const job = seedJob(jobId);
    await runTrackedJob(job, stubSuccess({ exitStatus: 1 }));
    const stored = JSON.parse(fs.readFileSync(resolveJobFile(process.cwd(), jobId), "utf8"));
    assert.equal(stored.status, "failed");
    assert.equal(stored.phase, "failed");
  });
});

// ---- failure path -------------------------------------------------------

describe("runTrackedJob — failure (runner throws)", () => {
  it("transitions stored job status to failed", async () => {
    const jobId = "rtr-throw-status";
    const job = seedJob(jobId);
    await assert.rejects(() =>
      runTrackedJob(job, async () => { throw new Error("boom"); })
    );
    const stored = JSON.parse(fs.readFileSync(resolveJobFile(process.cwd(), jobId), "utf8"));
    assert.equal(stored.status, "failed");
  });

  it("sets phase to failed", async () => {
    const jobId = "rtr-throw-phase";
    const job = seedJob(jobId);
    await assert.rejects(() =>
      runTrackedJob(job, async () => { throw new Error("phase check"); })
    );
    const stored = JSON.parse(fs.readFileSync(resolveJobFile(process.cwd(), jobId), "utf8"));
    assert.equal(stored.phase, "failed");
  });

  it("records the error message in the job file", async () => {
    const jobId = "rtr-throw-errmsg";
    const job = seedJob(jobId);
    await assert.rejects(() =>
      runTrackedJob(job, async () => { throw new Error("runner exploded"); })
    );
    const stored = JSON.parse(fs.readFileSync(resolveJobFile(process.cwd(), jobId), "utf8"));
    assert.equal(stored.errorMessage, "runner exploded");
  });

  it("clears pid after a failure", async () => {
    const jobId = "rtr-throw-pid";
    const job = seedJob(jobId);
    await assert.rejects(() =>
      runTrackedJob(job, async () => { throw new Error("x"); })
    );
    const stored = JSON.parse(fs.readFileSync(resolveJobFile(process.cwd(), jobId), "utf8"));
    assert.equal(stored.pid, null);
  });

  it("coerces a non-Error thrown value to a string for errorMessage", async () => {
    const jobId = "rtr-throw-nonError";
    const job = seedJob(jobId);
    await assert.rejects(() =>
      runTrackedJob(job, async () => { throw "string error"; })
    );
    const stored = JSON.parse(fs.readFileSync(resolveJobFile(process.cwd(), jobId), "utf8"));
    assert.equal(stored.errorMessage, "string error");
  });

  it("re-throws the original error to the caller", async () => {
    const jobId = "rtr-throw-rethrow";
    const job = seedJob(jobId);
    const original = new Error("re-throw me");
    await assert.rejects(
      () => runTrackedJob(job, async () => { throw original; }),
      (err) => err === original
    );
  });
});

// ---- log appending ------------------------------------------------------

describe("runTrackedJob — log appending", () => {
  it("appends a Final output block to the log file on success", async () => {
    const jobId = "rtr-log-success";
    const job = seedJob(jobId);
    const logFile = resolveJobLogFile(process.cwd(), jobId);
    fs.writeFileSync(logFile, "", "utf8");
    await runTrackedJob(job, stubSuccess({ rendered: "the-rendered-output" }), { logFile });
    const content = fs.readFileSync(logFile, "utf8");
    assert.match(content, /Final output/);
    assert.match(content, /the-rendered-output/);
  });

  it("uses options.logFile in preference to job.logFile", async () => {
    const jobId = "rtr-log-opts";
    const optionsLog = path.join(tempDir, `${jobId}-opts.log`);
    const jobLog = path.join(tempDir, `${jobId}-job.log`);
    fs.writeFileSync(optionsLog, "", "utf8");
    fs.writeFileSync(jobLog, "", "utf8");
    const job = { id: jobId, workspaceRoot: process.cwd(), status: "pending", logFile: jobLog };
    writeJobFile(process.cwd(), jobId, job);
    upsertJob(process.cwd(), job);
    await runTrackedJob(job, stubSuccess({ rendered: "via-options" }), { logFile: optionsLog });
    assert.match(fs.readFileSync(optionsLog, "utf8"), /via-options/);
    // job.logFile must NOT have received the final output block
    assert.equal(fs.readFileSync(jobLog, "utf8"), "");
  });

  it("does not throw when no logFile is provided", async () => {
    const jobId = "rtr-log-none";
    const job = seedJob(jobId);
    // Neither options.logFile nor job.logFile set — appendLogBlock should be a no-op
    await runTrackedJob(job, stubSuccess({ rendered: "no log" }));
  });
});
