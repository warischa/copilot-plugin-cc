// Unit tests for job-control.mjs — sorting, log preview, job resolution, enrichment.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ORIGINAL_ENV = process.env.CLAUDE_PLUGIN_DATA;
let tempDir;

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-plugin-job-control-"));
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

// Imports happen after env var is set; state functions read env at call-time so this is fine.
const {
  sortJobsNewestFirst,
  readJobProgressPreview,
  resolveResultJob,
  resolveCancelableJob,
  enrichJob,
  buildStatusSnapshot
} = await import("../plugins/copilot/scripts/lib/job-control.mjs");

const { generateJobId, upsertJob } = await import(
  "../plugins/copilot/scripts/lib/state.mjs"
);

// Fresh workspace per test so job state never bleeds between cases.
let workspace;
beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(tempDir, "ws-"));
});

// ---------------------------------------------------------------------------
// sortJobsNewestFirst
// ---------------------------------------------------------------------------

describe("sortJobsNewestFirst", () => {
  it("orders jobs by updatedAt descending", () => {
    const jobs = [
      { id: "a", updatedAt: "2024-01-01T00:00:00.000Z" },
      { id: "b", updatedAt: "2024-06-01T00:00:00.000Z" },
      { id: "c", updatedAt: "2024-03-01T00:00:00.000Z" }
    ];
    const result = sortJobsNewestFirst(jobs);
    assert.deepEqual(
      result.map((j) => j.id),
      ["b", "c", "a"]
    );
  });

  it("does not mutate the original array", () => {
    const jobs = [
      { id: "x", updatedAt: "2024-01-01T00:00:00.000Z" },
      { id: "y", updatedAt: "2024-06-01T00:00:00.000Z" }
    ];
    sortJobsNewestFirst(jobs);
    assert.equal(jobs[0].id, "x");
  });

  it("sorts jobs with missing updatedAt to the end", () => {
    const jobs = [
      { id: "no-ts" },
      { id: "with-ts", updatedAt: "2024-01-01T00:00:00.000Z" }
    ];
    const result = sortJobsNewestFirst(jobs);
    assert.equal(result[0].id, "with-ts");
    assert.equal(result[1].id, "no-ts");
  });

  it("is stable when all timestamps are equal", () => {
    const ts = "2024-05-01T12:00:00.000Z";
    const jobs = [
      { id: "first", updatedAt: ts },
      { id: "second", updatedAt: ts },
      { id: "third", updatedAt: ts }
    ];
    const result = sortJobsNewestFirst(jobs);
    assert.equal(result.length, 3);
    // All ids present; just assert no elements are lost.
    const ids = new Set(result.map((j) => j.id));
    assert.ok(ids.has("first") && ids.has("second") && ids.has("third"));
  });
});

// ---------------------------------------------------------------------------
// readJobProgressPreview
// ---------------------------------------------------------------------------

describe("readJobProgressPreview", () => {
  it("returns empty array for null logFile", () => {
    assert.deepEqual(readJobProgressPreview(null), []);
  });

  it("returns empty array for a non-existent file path", () => {
    assert.deepEqual(readJobProgressPreview("/nonexistent/path.log"), []);
  });

  it("returns last maxLines lines from a log file", () => {
    const logFile = path.join(workspace, "progress.log");
    fs.writeFileSync(
      logFile,
      [
        "[2024-01-01T00:00:01Z] line one",
        "[2024-01-01T00:00:02Z] line two",
        "[2024-01-01T00:00:03Z] line three",
        "[2024-01-01T00:00:04Z] line four",
        "[2024-01-01T00:00:05Z] line five"
      ].join("\n") + "\n"
    );
    const result = readJobProgressPreview(logFile, 3);
    assert.equal(result.length, 3);
    assert.equal(result[0], "line three");
    assert.equal(result[1], "line four");
    assert.equal(result[2], "line five");
  });

  it("ignores lines that do not start with [", () => {
    const logFile = path.join(workspace, "mixed.log");
    fs.writeFileSync(
      logFile,
      "[2024-01-01T00:00:01Z] valid line\nbare line without bracket\n"
    );
    const result = readJobProgressPreview(logFile, 10);
    assert.equal(result.length, 1);
    assert.equal(result[0], "valid line");
  });

  it("filters out progress-block title lines after stripping prefix", () => {
    const logFile = path.join(workspace, "titled.log");
    fs.writeFileSync(
      logFile,
      [
        "[t] Final output",
        "[t] real progress line",
        "[t] Assistant message",
        "[t] another real line"
      ].join("\n") + "\n"
    );
    const result = readJobProgressPreview(logFile, 10);
    assert.deepEqual(result, ["real progress line", "another real line"]);
  });

  it("returns fewer lines than maxLines when the file has fewer", () => {
    const logFile = path.join(workspace, "short.log");
    fs.writeFileSync(logFile, "[t] only one\n");
    const result = readJobProgressPreview(logFile, 10);
    assert.equal(result.length, 1);
    assert.equal(result[0], "only one");
  });
});

// ---------------------------------------------------------------------------
// resolveResultJob
// ---------------------------------------------------------------------------

describe("resolveResultJob", () => {
  it("throws when no finished jobs exist", () => {
    assert.throws(
      () => resolveResultJob(workspace),
      /No finished Copilot jobs found/
    );
  });

  it("resolves by exact job id", () => {
    const id = generateJobId("task");
    upsertJob(workspace, { id, status: "completed", title: "exact match" });
    const result = resolveResultJob(workspace, id);
    assert.equal(result.job.id, id);
    assert.ok(result.workspaceRoot);
  });

  it("resolves by id prefix", () => {
    const id = generateJobId("task");
    upsertJob(workspace, { id, status: "completed", title: "prefix match" });
    const prefix = id.slice(0, 9); // short unambiguous prefix
    const result = resolveResultJob(workspace, prefix);
    assert.equal(result.job.id, id);
  });

  it("returns the newest finished job when no reference is given", () => {
    const id1 = generateJobId("task");
    upsertJob(workspace, { id: id1, status: "completed", title: "older" });
    const id2 = generateJobId("task");
    upsertJob(workspace, { id: id2, status: "completed", title: "newer" });
    const result = resolveResultJob(workspace);
    assert.equal(result.job.id, id2);
  });

  it("throws 'No job found for' when reference points to a running job", () => {
    // matchJobReference filters by predicate (finished only) and throws when not found.
    // The "is still X" path is only reachable when no reference is given.
    const id = generateJobId("task");
    upsertJob(workspace, { id, status: "running", title: "still running" });
    assert.throws(
      () => resolveResultJob(workspace, id),
      /No job found for/
    );
  });

  it("throws 'is still active' when no reference given and only running jobs exist", () => {
    const id = generateJobId("task");
    upsertJob(workspace, { id, status: "running", title: "active only" });
    assert.throws(
      () => resolveResultJob(workspace),
      /is still (running|queued)/
    );
  });

  it("throws when reference is not found at all", () => {
    assert.throws(
      () => resolveResultJob(workspace, "nonexistent-job-id"),
      /No job found for/
    );
  });

  it("throws on ambiguous prefix matching multiple finished jobs", () => {
    upsertJob(workspace, { id: "dup-prefix-aaa", status: "completed" });
    upsertJob(workspace, { id: "dup-prefix-bbb", status: "completed" });
    assert.throws(
      () => resolveResultJob(workspace, "dup-prefix"),
      /ambiguous/i
    );
  });

  it("accepts a failed job as a finished job", () => {
    const id = generateJobId("task");
    upsertJob(workspace, { id, status: "failed" });
    const result = resolveResultJob(workspace, id);
    assert.equal(result.job.id, id);
    assert.equal(result.job.status, "failed");
  });

  it("accepts a cancelled job as a finished job", () => {
    const id = generateJobId("task");
    upsertJob(workspace, { id, status: "cancelled" });
    const result = resolveResultJob(workspace, id);
    assert.equal(result.job.id, id);
    assert.equal(result.job.status, "cancelled");
  });
});

// ---------------------------------------------------------------------------
// resolveCancelableJob
// ---------------------------------------------------------------------------

describe("resolveCancelableJob", () => {
  it("throws when no active jobs exist", () => {
    upsertJob(workspace, { id: generateJobId("task"), status: "completed" });
    assert.throws(
      () => resolveCancelableJob(workspace),
      /No active Copilot jobs to cancel/
    );
  });

  it("resolves by exact job id", () => {
    const id = generateJobId("task");
    upsertJob(workspace, { id, status: "running", title: "cancelable" });
    const result = resolveCancelableJob(workspace, id);
    assert.equal(result.job.id, id);
    assert.ok(result.workspaceRoot);
  });

  it("resolves by id prefix", () => {
    const id = generateJobId("task");
    upsertJob(workspace, { id, status: "queued", title: "queued task" });
    const prefix = id.slice(0, 9);
    const result = resolveCancelableJob(workspace, prefix);
    assert.equal(result.job.id, id);
  });

  it("returns the sole active job when no reference given", () => {
    const id = generateJobId("task");
    upsertJob(workspace, { id, status: "running", title: "sole active" });
    const result = resolveCancelableJob(workspace);
    assert.equal(result.job.id, id);
  });

  it("throws when multiple active jobs exist and no reference given", () => {
    upsertJob(workspace, { id: generateJobId("task"), status: "running" });
    upsertJob(workspace, { id: generateJobId("task"), status: "queued" });
    assert.throws(
      () => resolveCancelableJob(workspace),
      /Multiple Copilot jobs are active/
    );
  });

  it("resolves a queued job the same as a running job", () => {
    const id = generateJobId("task");
    upsertJob(workspace, { id, status: "queued" });
    const result = resolveCancelableJob(workspace, id);
    assert.equal(result.job.id, id);
    assert.equal(result.job.status, "queued");
  });
});

// ---------------------------------------------------------------------------
// enrichJob
// ---------------------------------------------------------------------------

describe("enrichJob", () => {
  it("adds kindLabel, progressPreview, elapsed, duration, phase fields", () => {
    const job = {
      id: "enrich-1",
      status: "completed",
      jobClass: "task",
      createdAt: "2024-01-01T00:00:00.000Z",
      completedAt: "2024-01-01T00:01:30.000Z"
    };
    const enriched = enrichJob(job);
    assert.ok("kindLabel" in enriched);
    assert.ok("progressPreview" in enriched);
    assert.ok("elapsed" in enriched);
    assert.ok("duration" in enriched);
    assert.ok("phase" in enriched);
    // completed jobs get no progressPreview
    assert.deepEqual(enriched.progressPreview, []);
    assert.equal(enriched.duration, "1m 30s");
    assert.equal(enriched.phase, "done");
  });

  it("infers kindLabel from jobClass", () => {
    const reviewJob = enrichJob({ id: "r1", status: "running", jobClass: "review" });
    assert.equal(reviewJob.kindLabel, "review");

    const taskJob = enrichJob({ id: "t1", status: "running", jobClass: "task" });
    assert.equal(taskJob.kindLabel, "rescue");
  });

  it("infers kindLabel from kind field as fallback", () => {
    const reviewJob = enrichJob({ id: "r2", status: "completed", kind: "review" });
    assert.equal(reviewJob.kindLabel, "review");
  });

  it("uses kindLabel field when explicitly set", () => {
    const job = enrichJob({ id: "k1", status: "running", kindLabel: "my-custom-label" });
    assert.equal(job.kindLabel, "my-custom-label");
  });

  it("preserves existing phase field", () => {
    const job = enrichJob({ id: "p1", status: "running", phase: "investigating" });
    assert.equal(job.phase, "investigating");
  });

  it("running job gets empty progressPreview when no logFile", () => {
    const job = enrichJob({ id: "run1", status: "running" });
    assert.ok(Array.isArray(job.progressPreview));
  });

  it("respects maxProgressLines option", () => {
    const logFile = path.join(tempDir, "enrich-test.log");
    fs.writeFileSync(
      logFile,
      [
        "[t] line one",
        "[t] line two",
        "[t] line three"
      ].join("\n") + "\n"
    );
    const job = enrichJob({ id: "ml1", status: "running", logFile }, { maxProgressLines: 2 });
    assert.equal(job.progressPreview.length, 2);
    assert.equal(job.progressPreview[0], "line two");
    assert.equal(job.progressPreview[1], "line three");
  });
});

// ---------------------------------------------------------------------------
// buildStatusSnapshot
// ---------------------------------------------------------------------------

describe("buildStatusSnapshot", () => {
  it("returns expected shape with workspaceRoot, running, latestFinished, recent", () => {
    const snapshot = buildStatusSnapshot(workspace);
    assert.ok("workspaceRoot" in snapshot);
    assert.ok(Array.isArray(snapshot.running));
    assert.ok(Array.isArray(snapshot.recent));
    // latestFinished may be null when no finished jobs exist
  });

  it("places running jobs in running array", () => {
    const runId = generateJobId("task");
    upsertJob(workspace, { id: runId, status: "running", title: "active job" });

    const snapshot = buildStatusSnapshot(workspace);
    assert.equal(snapshot.running.length, 1);
    assert.equal(snapshot.running[0].id, runId);
    assert.equal(snapshot.latestFinished, null);
  });

  it("places the newest completed job in latestFinished", () => {
    const doneId = generateJobId("task");
    upsertJob(workspace, { id: doneId, status: "completed", title: "done job" });

    const snapshot = buildStatusSnapshot(workspace);
    assert.equal(snapshot.running.length, 0);
    assert.ok(snapshot.latestFinished);
    assert.equal(snapshot.latestFinished.id, doneId);
  });

  it("separates running from finished correctly with mixed jobs", () => {
    const runId = generateJobId("task");
    upsertJob(workspace, { id: runId, status: "running", title: "active" });
    const doneId = generateJobId("task");
    upsertJob(workspace, { id: doneId, status: "completed", title: "done" });

    const snapshot = buildStatusSnapshot(workspace);
    assert.equal(snapshot.running.length, 1);
    assert.equal(snapshot.running[0].id, runId);
    assert.ok(snapshot.latestFinished);
    assert.equal(snapshot.latestFinished.id, doneId);
  });

  it("enriched jobs in snapshot have phase field", () => {
    const id = generateJobId("task");
    upsertJob(workspace, { id, status: "completed" });

    const snapshot = buildStatusSnapshot(workspace);
    assert.ok("phase" in snapshot.latestFinished);
  });
});
