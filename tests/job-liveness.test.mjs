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

  it("flips a long-running job with a still-alive pid as suspected PID-reuse", () => {
    const startedAt = new Date("2025-01-01T00:00:00Z").toISOString();
    upsertJob(workspace, {
      id: "task-stale",
      status: "running",
      pid: 12345,
      startedAt
    });

    // 8h after startedAt — exceeds the default 6h threshold.
    const now = () => Date.parse("2025-01-01T08:00:00Z");
    const summary = sweepDeadJobs(workspace, {
      isProcessAlive: () => true, // pretend pid is still alive
      now
    });

    assert.equal(summary.checked, 1);
    assert.equal(summary.swept.length, 1);
    assert.match(summary.swept[0].reason, /pid=12345 was reused/);
    assert.equal(listJobs(workspace)[0].status, "failed");
  });

  it("leaves a long-running job alone when startedAt is missing", () => {
    upsertJob(workspace, {
      id: "task-no-start",
      status: "running",
      pid: 12345
      // no startedAt — can't reason about age
    });

    const summary = sweepDeadJobs(workspace, {
      isProcessAlive: () => true,
      now: () => Date.now() + 24 * 60 * 60 * 1000 // pretend a day has passed
    });

    assert.equal(summary.swept.length, 0);
    assert.equal(listJobs(workspace)[0].status, "running");
  });

  it("respects a custom maxRunningAgeMs threshold", () => {
    const startedAt = new Date("2025-01-01T00:00:00Z").toISOString();
    upsertJob(workspace, {
      id: "task-young",
      status: "running",
      pid: 12345,
      startedAt
    });

    const summary = sweepDeadJobs(workspace, {
      isProcessAlive: () => true,
      now: () => Date.parse("2025-01-01T00:00:10Z"), // 10s after start
      maxRunningAgeMs: 60 * 60 * 1000 // 1h — way more than 10s
    });

    assert.equal(summary.swept.length, 0);
  });

  it("setting maxRunningAgeMs=0 disables the PID-reuse mitigation", () => {
    const startedAt = new Date("2025-01-01T00:00:00Z").toISOString();
    upsertJob(workspace, {
      id: "task-ancient",
      status: "running",
      pid: 12345,
      startedAt
    });

    const summary = sweepDeadJobs(workspace, {
      isProcessAlive: () => true,
      now: () => Date.parse("2030-01-01T00:00:00Z"), // 5 years later
      maxRunningAgeMs: 0
    });

    assert.equal(summary.swept.length, 0);
    assert.equal(listJobs(workspace)[0].status, "running");
  });
});
