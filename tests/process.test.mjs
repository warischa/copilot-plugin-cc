// Unit tests for lib/process.mjs
// Covers: formatCommandFailure, binaryAvailable, runCommand, runCommandChecked.
// terminateProcessTree is intentionally excluded — it kills process trees and
// is unsafe to exercise in CI.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";

const {
  formatCommandFailure,
  binaryAvailable,
  runCommand,
  runCommandChecked,
} = await import("../plugins/copilot/scripts/lib/process.mjs");

// The running Node binary — guaranteed to exist and respond to --version.
const NODE = process.execPath;

// ─── formatCommandFailure ──────────────────────────────────────────────────

describe("formatCommandFailure", () => {
  it("formats command + args + exit code", () => {
    const msg = formatCommandFailure({
      command: "git",
      args: ["status"],
      status: 1,
      signal: null,
      stdout: "",
      stderr: "",
    });
    assert.equal(msg, "git status: exit=1");
  });

  it("uses signal instead of exit when signal is set", () => {
    const msg = formatCommandFailure({
      command: "node",
      args: [],
      status: null,
      signal: "SIGTERM",
      stdout: "",
      stderr: "",
    });
    assert.match(msg, /signal=SIGTERM/);
  });

  it("appends stderr when present", () => {
    const msg = formatCommandFailure({
      command: "npm",
      args: ["install"],
      status: 1,
      signal: null,
      stdout: "some stdout",
      stderr: "fatal: disk full",
    });
    assert.match(msg, /fatal: disk full/);
  });

  it("falls back to stdout when stderr is empty", () => {
    const msg = formatCommandFailure({
      command: "tool",
      args: [],
      status: 1,
      signal: null,
      stdout: "only stdout output",
      stderr: "",
    });
    assert.match(msg, /only stdout output/);
  });

  it("omits output section when both stdout and stderr are empty", () => {
    const msg = formatCommandFailure({
      command: "tool",
      args: [],
      status: 2,
      signal: null,
      stdout: "",
      stderr: "",
    });
    assert.equal(msg, "tool: exit=2");
  });

  it("handles command with no args", () => {
    const msg = formatCommandFailure({
      command: "ls",
      args: [],
      status: 127,
      signal: null,
      stdout: "",
      stderr: "",
    });
    assert.equal(msg, "ls: exit=127");
  });
});

// ─── binaryAvailable ──────────────────────────────────────────────────────

describe("binaryAvailable", () => {
  it("returns available=true for the running node binary", () => {
    const result = binaryAvailable(NODE, ["--version"]);
    assert.equal(result.available, true);
    assert.ok(result.detail, "detail should be non-empty");
  });

  it("detail contains the version string for node --version", () => {
    const result = binaryAvailable(NODE, ["--version"]);
    assert.match(result.detail, /v\d+\.\d+/);
  });

  it("returns available=false for a non-existent binary", () => {
    const result = binaryAvailable("this-binary-absolutely-does-not-exist-xyz99");
    assert.equal(result.available, false);
    assert.equal(result.detail, "not found");
  });

  it("returns available=false when the command exits non-zero", () => {
    // node -e 'process.exit(1)' exits with code 1
    const result = binaryAvailable(NODE, ["-e", "process.exit(1)"]);
    assert.equal(result.available, false);
  });
});

// ─── runCommand ───────────────────────────────────────────────────────────

describe("runCommand", () => {
  it("captures stdout and returns status 0 for a successful command", () => {
    const result = runCommand(NODE, ["-e", "process.stdout.write('hello')"]);
    assert.equal(result.stdout, "hello");
    assert.equal(result.status, 0);
    assert.equal(result.error, null);
  });

  it("captures stderr separately from stdout", () => {
    const result = runCommand(NODE, [
      "-e",
      "process.stderr.write('err'); process.stdout.write('out');",
    ]);
    assert.equal(result.stdout, "out");
    assert.equal(result.stderr, "err");
  });

  it("returns the non-zero exit code without throwing", () => {
    const result = runCommand(NODE, ["-e", "process.exit(42)"]);
    assert.equal(result.status, 42);
    assert.equal(result.error, null);
  });

  it("echoes command and args back on the result", () => {
    const result = runCommand(NODE, ["--version"]);
    assert.equal(result.command, NODE);
    assert.deepEqual(result.args, ["--version"]);
  });

  it("returns an error (not a throw) for a missing binary", () => {
    const result = runCommand("this-binary-absolutely-does-not-exist-xyz99", []);
    assert.ok(result.error instanceof Error);
    assert.equal(result.error.code, "ENOENT");
  });
});

// ─── runCommandChecked ────────────────────────────────────────────────────

describe("runCommandChecked", () => {
  it("returns the result when the command succeeds", () => {
    const result = runCommandChecked(NODE, ["-e", "process.stdout.write('ok')"]);
    assert.equal(result.stdout, "ok");
    assert.equal(result.status, 0);
  });

  it("throws an Error containing the formatted failure when exit code is non-zero", () => {
    assert.throws(
      () => runCommandChecked(NODE, ["-e", "process.exit(3)"]),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /exit=3/);
        return true;
      }
    );
  });

  it("throws the spawning error when the binary is not found", () => {
    assert.throws(
      () => runCommandChecked("this-binary-absolutely-does-not-exist-xyz99", []),
      (err) => {
        assert.ok(err instanceof Error);
        assert.equal(err.code, "ENOENT");
        return true;
      }
    );
  });

  it("throws with stderr included in the message when available", () => {
    assert.throws(
      () =>
        runCommandChecked(NODE, [
          "-e",
          "process.stderr.write('boom'); process.exit(1);",
        ]),
      (err) => {
        assert.match(err.message, /boom/);
        return true;
      }
    );
  });
});
