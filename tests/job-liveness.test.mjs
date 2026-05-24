// Unit tests for the job-liveness sweep (DESIGN.md §5 item 3).

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ORIGINAL_ENV = process.env.CLAUDE_PLUGIN_DATA;
let tempDir;

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-plugin-liveness-"));
  process.env.CLAUDE_PLUGIN_DATA = tempDir;
});

after(() => {
  if (ORIGINAL_ENV === undefined) {
    delete process.env.CLAUDE_PLUGIN_DATA;
  } else {
    process.env.CLAUDE_PLUGIN_DATA = ORIGINAL_ENV;
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// Imports happen after env is set so resolveStateDir picks up the tempdir.
const { sweepDeadJobs, isProcessAlive } = await import(
  "../plugins/copilot/scripts/lib/job-liveness.mjs"
);
const { upsertJob, listJobs, writeJobFile, readJobFile, resolveJobFile } = await import(
  "../plugins/copilot/scripts/lib/state.mjs"
);

// Fresh workspace dir per test so jobs don't bleed between cases.
let workspace;
beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(tempDir, "ws-"));
});

describe("isProcessAlive", () => {
  it("reports the current process as alive", () => {
    assert.equal(isProcessAlive(process.pid), true);
  });

  it("reports an obviously-dead pid as not alive", () => {
    // PIDs above 2^22 are not used on Linux/macOS in practice.
    assert.equal(isProcessAlive(99999999), false);
  });

  it("treats invalid pid values as not alive", () => {
    assert.equal(isProcessAlive(null), false);
    assert.equal(isProcessAlive(0), false);
    assert.equal(isProcessAlive(-1), false);
    assert.equal(isProcessAlive(NaN), false);
  });
});

describe("sweepDeadJobs", () => {
  it("flips a running job with a dead pid to failed", () => {
    upsertJob(workspace, {
      id: "task-dead-1",
      status: "running",
      pid: 99999999,
      title: "Stuck task",
      startedAt: new Date().toISOString()
    });
    writeJobFile(workspace, "task-dead-1", {
      id: "task-dead-1",
      status: "running",
      pid: 99999999,
      title: "Stuck task"
    });

    const summary = sweepDeadJobs(workspace);

    assert.equal(summary.checked, 1);
    assert.equal(summary.swept.length, 1);
    assert.equal(summary.swept[0].id, "task-dead-1");
    assert.match(summary.swept[0].reason, /no longer exists/);

    const jobs = listJobs(workspace);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].status, "failed");
    assert.equal(jobs[0].phase, "failed");
    assert.equal(jobs[0].pid, null);
    assert.ok(jobs[0].liveness?.reason);

    const stored = readJobFile(resolveJobFile(workspace, "task-dead-1"));
    assert.equal(stored.status, "failed");
    assert.equal(stored.pid, null);
  });

  it("flips a running job with no pid recorded to failed", () => {
    upsertJob(workspace, {
      id: "task-no-pid",
      status: "running",
      pid: null,
      title: "Orphan record"
    });

    const summary = sweepDeadJobs(workspace);

    assert.equal(summary.swept.length, 1);
    assert.match(summary.swept[0].reason, /no pid recorded/);
    const jobs = listJobs(workspace);
    assert.equal(jobs[0].status, "failed");
  });

  it("leaves a running job with a live pid alone", () => {
    upsertJob(workspace, {
      id: "task-alive",
      status: "running",
      pid: process.pid,
      title: "Currently alive"
    });

    const summary = sweepDeadJobs(workspace);

    assert.equal(summary.checked, 1);
    assert.equal(summary.swept.length, 0);
    const jobs = listJobs(workspace);
    assert.equal(jobs[0].status, "running");
    assert.equal(jobs[0].pid, process.pid);
  });

  it("does not touch queued or already-completed jobs", () => {
    upsertJob(workspace, { id: "j-queued", status: "queued", pid: null });
    upsertJob(workspace, { id: "j-done", status: "completed", pid: null });
    upsertJob(workspace, { id: "j-failed", status: "failed", pid: null });

    const summary = sweepDeadJobs(workspace);

    assert.equal(summary.checked, 0);
    assert.equal(summary.swept.length, 0);
    const jobs = listJobs(workspace);
    const byId = Object.fromEntries(jobs.map((j) => [j.id, j.status]));
    assert.equal(byId["j-queued"], "queued");
    assert.equal(byId["j-done"], "completed");
    assert.equal(byId["j-failed"], "failed");
  });

  it("supports an injected isProcessAlive probe for deterministic tests", () => {
    upsertJob(workspace, { id: "task-probe", status: "running", pid: 12345 });

    const summary = sweepDeadJobs(workspace, {
      isProcessAlive: (pid) => pid === 12345 // pretend it's alive
    });

    assert.equal(summary.swept.length, 0);
    assert.equal(listJobs(workspace)[0].status, "running");
  });
});
