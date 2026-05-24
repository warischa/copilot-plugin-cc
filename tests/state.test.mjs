import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ORIGINAL_ENV = process.env.CLAUDE_PLUGIN_DATA;
let tempDir;

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-plugin-state-"));
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

const stateModule = await import("../plugins/copilot/scripts/lib/state.mjs");
const { generateJobId, listJobs, upsertJob, getConfig, setConfig } = stateModule;

describe("state", () => {
  it("upserts and lists jobs", () => {
    const cwd = tempDir;
    const id = generateJobId("test");
    upsertJob(cwd, { id, title: "first", status: "running" });
    let jobs = listJobs(cwd);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].id, id);
    assert.equal(jobs[0].status, "running");

    upsertJob(cwd, { id, status: "completed", summary: "done" });
    jobs = listJobs(cwd);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].status, "completed");
    assert.equal(jobs[0].summary, "done");
  });

  it("stores config keys", () => {
    const cwd = tempDir;
    setConfig(cwd, "exampleFlag", true);
    assert.equal(getConfig(cwd).exampleFlag, true);
  });

  it("generates unique job ids with prefix", () => {
    const a = generateJobId("task");
    const b = generateJobId("task");
    assert.notEqual(a, b);
    assert.ok(a.startsWith("task-"));
    assert.ok(b.startsWith("task-"));
  });
});
