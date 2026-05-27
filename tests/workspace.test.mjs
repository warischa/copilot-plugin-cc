import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "../plugins/copilot/scripts/lib/workspace.mjs";

let tempDir;

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-ws-test-"));
});

after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("resolveWorkspaceRoot", () => {
  it("returns a non-empty string for a non-git temp directory (falls back to cwd)", () => {
    const result = resolveWorkspaceRoot(tempDir);
    assert.equal(typeof result, "string");
    assert.ok(result.length > 0);
  });

  it("falls back to cwd when the directory is not a git repository", () => {
    // tempDir is not a git repo, so resolveWorkspaceRoot must return tempDir.
    const result = resolveWorkspaceRoot(tempDir);
    assert.equal(result, tempDir);
  });

  it("is deterministic — same input yields the same result", () => {
    const first = resolveWorkspaceRoot(tempDir);
    const second = resolveWorkspaceRoot(tempDir);
    assert.equal(first, second);
  });

  it("returns different roots for different non-git directories", () => {
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-ws-other-"));
    try {
      const a = resolveWorkspaceRoot(tempDir);
      const b = resolveWorkspaceRoot(otherDir);
      assert.notEqual(a, b);
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });
});
