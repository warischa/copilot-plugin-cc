// Unit tests for lib/tracked-jobs.mjs

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const {
  nowIso,
  createJobRecord,
  appendLogLine,
  appendLogBlock,
  createProgressReporter,
  createJobProgressUpdater,
  SESSION_ID_ENV,
} = await import("../plugins/copilot/scripts/lib/tracked-jobs.mjs");

const { writeJobFile, resolveJobFile } =
  await import("../plugins/copilot/scripts/lib/state.mjs");

// All state writes go into tempDir via CLAUDE_PLUGIN_DATA so real user state
// is never touched.  We also use process.cwd() as workspaceRoot: it is a git
// repo, so resolveWorkspaceRoot resolves it deterministically.

let tempDir;
const ORIGINAL_PLUGIN_DATA = process.env.CLAUDE_PLUGIN_DATA;

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-tracked-jobs-"));
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

// ---- nowIso ------------------------------------------------------------

describe("nowIso", () => {
  it("returns a valid ISO 8601 UTC string", () => {
    const result = nowIso();
    assert.match(result, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.ok(!Number.isNaN(Date.parse(result)));
  });

  it("returns a timestamp within a 2-second window of Date.now()", () => {
    const before = Date.now();
    const iso = nowIso();
    const after = Date.now();
    const ts = Date.parse(iso);
    assert.ok(ts >= before && ts <= after);
  });
});

// ---- createJobRecord ---------------------------------------------------

describe("createJobRecord", () => {
  it("merges base fields and injects createdAt", () => {
    const record = createJobRecord({ id: "job-1", status: "pending" }, { env: {} });
    assert.equal(record.id, "job-1");
    assert.equal(record.status, "pending");
    assert.match(record.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  it("includes sessionId when SESSION_ID_ENV is set in env", () => {
    const env = { [SESSION_ID_ENV]: "ses-abc" };
    const record = createJobRecord({ id: "job-2" }, { env });
    assert.equal(record.sessionId, "ses-abc");
  });

  it("omits sessionId when SESSION_ID_ENV is absent", () => {
    const record = createJobRecord({ id: "job-3" }, { env: {} });
    assert.equal(record.sessionId, undefined);
    assert.ok(!("sessionId" in record));
  });

  it("uses a custom sessionIdEnv key when provided", () => {
    const env = { MY_SESSION: "ses-xyz" };
    const record = createJobRecord({ id: "job-4" }, { env, sessionIdEnv: "MY_SESSION" });
    assert.equal(record.sessionId, "ses-xyz");
  });

  it("base fields are not mutated", () => {
    const base = { id: "job-5" };
    createJobRecord(base, { env: { [SESSION_ID_ENV]: "x" } });
    assert.equal(base.sessionId, undefined);
    assert.equal(base.createdAt, undefined);
  });
});

// ---- appendLogLine -----------------------------------------------------

describe("appendLogLine", () => {
  it("appends a timestamp-prefixed line to the log file", () => {
    const logFile = path.join(tempDir, "line-basic.log");
    fs.writeFileSync(logFile, "", "utf8");
    appendLogLine(logFile, "hello world");
    const content = fs.readFileSync(logFile, "utf8");
    assert.match(content, /^\[.*\] hello world\n$/);
  });

  it("trims the message before writing", () => {
    const logFile = path.join(tempDir, "line-trim.log");
    fs.writeFileSync(logFile, "", "utf8");
    appendLogLine(logFile, "  trimmed  ");
    const content = fs.readFileSync(logFile, "utf8");
    assert.match(content, /\] trimmed\n$/);
  });

  it("appends multiple lines in order", () => {
    const logFile = path.join(tempDir, "line-multi.log");
    fs.writeFileSync(logFile, "", "utf8");
    appendLogLine(logFile, "first");
    appendLogLine(logFile, "second");
    const lines = fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /first$/);
    assert.match(lines[1], /second$/);
  });

  it("does nothing when logFile is falsy", () => {
    // Must not throw
    appendLogLine(null, "ignored");
    appendLogLine("", "ignored");
    appendLogLine(undefined, "ignored");
  });

  it("does nothing when message is empty or whitespace-only", () => {
    const logFile = path.join(tempDir, "line-empty-msg.log");
    fs.writeFileSync(logFile, "initial", "utf8");
    appendLogLine(logFile, "");
    appendLogLine(logFile, "   ");
    appendLogLine(logFile, null);
    const content = fs.readFileSync(logFile, "utf8");
    assert.equal(content, "initial");
  });
});

// ---- appendLogBlock ----------------------------------------------------

describe("appendLogBlock", () => {
  it("appends a titled block with a leading blank line", () => {
    const logFile = path.join(tempDir, "block-basic.log");
    fs.writeFileSync(logFile, "", "utf8");
    appendLogBlock(logFile, "Result", "line one\nline two");
    const content = fs.readFileSync(logFile, "utf8");
    assert.match(content, /\n\[.*\] Result\nline one\nline two\n/);
  });

  it("trims trailing whitespace from body", () => {
    const logFile = path.join(tempDir, "block-trim.log");
    fs.writeFileSync(logFile, "", "utf8");
    appendLogBlock(logFile, "T", "content   \n   ");
    const content = fs.readFileSync(logFile, "utf8");
    // After trimEnd() the body should not end with spaces/blank lines before the newline
    assert.ok(!content.includes("content   \n"), "trailing spaces should be stripped");
  });

  it("does nothing when body is null, undefined, or empty string", () => {
    const logFile = path.join(tempDir, "block-empty.log");
    fs.writeFileSync(logFile, "start", "utf8");
    appendLogBlock(logFile, "Title", null);
    appendLogBlock(logFile, "Title", undefined);
    appendLogBlock(logFile, "Title", "");
    assert.equal(fs.readFileSync(logFile, "utf8"), "start");
  });

  it("does nothing when logFile is falsy", () => {
    appendLogBlock(null, "Title", "body");
    appendLogBlock("", "Title", "body");
  });
});

// ---- createProgressReporter -------------------------------------------

describe("createProgressReporter", () => {
  it("returns null when called with no arguments", () => {
    assert.equal(createProgressReporter(), null);
  });

  it("returns null when stderr=false, no logFile, no onEvent", () => {
    assert.equal(createProgressReporter({ stderr: false }), null);
  });

  it("(invariant) writes to process.stderr when stderr=true", () => {
    const written = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => {
      written.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    };

    try {
      const reporter = createProgressReporter({ stderr: true });
      reporter("hello from copilot");
    } finally {
      process.stderr.write = originalWrite;
    }

    assert.equal(written.length, 1);
    assert.match(written[0], /\[copilot\] hello from copilot\n/);
  });

  it("(invariant) uses stderrMessage field over message for stderr output", () => {
    const written = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => {
      written.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    };

    try {
      const reporter = createProgressReporter({ stderr: true });
      reporter({ message: "verbose message", stderrMessage: "concise stderr" });
    } finally {
      process.stderr.write = originalWrite;
    }

    assert.equal(written.length, 1);
    assert.match(written[0], /\[copilot\] concise stderr\n/);
    assert.ok(!written[0].includes("verbose message"));
  });

  it("does NOT write to stderr when stderr=false", () => {
    const written = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => {
      written.push(chunk);
      return true;
    };

    try {
      const logFile = path.join(tempDir, "reporter-no-stderr.log");
      fs.writeFileSync(logFile, "", "utf8");
      const reporter = createProgressReporter({ stderr: false, logFile });
      reporter("quiet message");
    } finally {
      process.stderr.write = originalWrite;
    }

    assert.equal(written.length, 0);
  });

  it("calls onEvent with a normalized event object", () => {
    const events = [];
    const reporter = createProgressReporter({ onEvent: (e) => events.push(e) });
    reporter({ message: "test", phase: "running", threadId: "t1", turnId: "u1" });
    assert.equal(events.length, 1);
    assert.equal(events[0].message, "test");
    assert.equal(events[0].phase, "running");
    assert.equal(events[0].threadId, "t1");
    assert.equal(events[0].turnId, "u1");
  });

  it("onEvent receives a normalized event even for plain string input", () => {
    const events = [];
    const reporter = createProgressReporter({ onEvent: (e) => events.push(e) });
    reporter("plain string event");
    assert.equal(events[0].message, "plain string event");
    assert.equal(events[0].phase, null);
    assert.equal(events[0].threadId, null);
  });

  it("writes message line to logFile when logFile is provided", () => {
    const logFile = path.join(tempDir, "reporter-log.log");
    fs.writeFileSync(logFile, "", "utf8");
    const reporter = createProgressReporter({ logFile });
    reporter("logged line");
    const content = fs.readFileSync(logFile, "utf8");
    assert.match(content, /\] logged line\n/);
  });

  it("writes logBody block to logFile when event has logTitle and logBody", () => {
    const logFile = path.join(tempDir, "reporter-block.log");
    fs.writeFileSync(logFile, "", "utf8");
    const reporter = createProgressReporter({ logFile });
    reporter({ message: "m", logTitle: "Output", logBody: "result text" });
    const content = fs.readFileSync(logFile, "utf8");
    assert.match(content, /Output\n/);
    assert.match(content, /result text/);
  });
});

// ---- createJobProgressUpdater ------------------------------------------

describe("createJobProgressUpdater", () => {
  it("returns a callable function", () => {
    const update = createJobProgressUpdater(process.cwd(), "job-type-check");
    assert.equal(typeof update, "function");
  });

  it("does not throw when event has no phase/threadId/turnId (no-op path)", () => {
    const update = createJobProgressUpdater(process.cwd(), "job-noop");
    // No state file exists; no fields change — should be a silent no-op
    update({ message: "ping" });
    update("plain string");
  });

  it("persists a new phase to the job file", () => {
    const jobId = "job-phase-persist";
    const cwd = process.cwd();
    writeJobFile(cwd, jobId, { id: jobId, status: "running" });

    const update = createJobProgressUpdater(cwd, jobId);
    update({ message: "started", phase: "executing" });

    const stored = JSON.parse(fs.readFileSync(resolveJobFile(cwd, jobId), "utf8"));
    assert.equal(stored.phase, "executing");
  });

  it("persists a new threadId to the job file", () => {
    const jobId = "job-thread-persist";
    const cwd = process.cwd();
    writeJobFile(cwd, jobId, { id: jobId, status: "running" });

    const update = createJobProgressUpdater(cwd, jobId);
    update({ message: "m", threadId: "thread-abc" });

    const stored = JSON.parse(fs.readFileSync(resolveJobFile(cwd, jobId), "utf8"));
    assert.equal(stored.threadId, "thread-abc");
  });

  it("persists a new turnId to the job file", () => {
    const jobId = "job-turn-persist";
    const cwd = process.cwd();
    writeJobFile(cwd, jobId, { id: jobId, status: "running" });

    const update = createJobProgressUpdater(cwd, jobId);
    update({ message: "m", turnId: "turn-99" });

    const stored = JSON.parse(fs.readFileSync(resolveJobFile(cwd, jobId), "utf8"));
    assert.equal(stored.turnId, "turn-99");
  });

  it("does not re-write the job file when the same phase is sent twice", () => {
    const jobId = "job-dedup-phase";
    const cwd = process.cwd();
    writeJobFile(cwd, jobId, { id: jobId, status: "running" });

    const update = createJobProgressUpdater(cwd, jobId);
    update({ message: "m", phase: "phase-one" });

    // Replace the file with a sentinel value
    writeJobFile(cwd, jobId, { id: jobId, status: "running", phase: "phase-one", sentinel: true });

    // Same phase — should be a no-op; sentinel must survive
    update({ message: "m", phase: "phase-one" });

    const stored = JSON.parse(fs.readFileSync(resolveJobFile(cwd, jobId), "utf8"));
    assert.equal(stored.sentinel, true, "second identical phase should not overwrite the file");
  });
});
