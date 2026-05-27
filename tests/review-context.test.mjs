// Unit tests for collectReviewContext() exported from lib/git.mjs.
// Each test builds its own isolated git fixture in a temp directory.

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  collectReviewContext,
  resolveReviewTarget,
} from "../plugins/copilot/scripts/lib/git.mjs";

// Helpers ---------------------------------------------------------------

function g(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

const tmpDirs = [];

function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-review-ctx-"));
  tmpDirs.push(dir);
  g(dir, ["init"]);
  g(dir, ["config", "user.email", "test@example.com"]);
  g(dir, ["config", "user.name", "Test User"]);
  fs.writeFileSync(path.join(dir, "README.md"), "hello world\n");
  g(dir, ["add", "."]);
  g(dir, ["commit", "-m", "init"]);
  // Normalise branch name so detectDefaultBranch can resolve it.
  const branch = execFileSync("git", ["branch", "--show-current"], {
    cwd: dir,
    encoding: "utf8",
  }).trim();
  if (branch !== "main") {
    g(dir, ["branch", "-m", branch, "main"]);
  }
  return dir;
}

after(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------
// 1. Working-tree mode — single modified file fits inline limits
// -----------------------------------------------------------------------
describe("collectReviewContext — working-tree inline-diff", () => {
  it("inputMode is inline-diff, fileCount is 1, changedFiles includes the modified file", () => {
    const repo = makeTempRepo();
    fs.writeFileSync(path.join(repo, "README.md"), "hello world\nline added\n");

    const target = { mode: "working-tree", label: "working tree diff", explicit: true };
    const ctx = collectReviewContext(repo, target);

    assert.equal(ctx.inputMode, "inline-diff");
    assert.equal(ctx.fileCount, 1);
    assert.ok(
      ctx.changedFiles.includes("README.md"),
      `expected changedFiles to include README.md, got: ${JSON.stringify(ctx.changedFiles)}`
    );
  });
});

// -----------------------------------------------------------------------
// 2. Working-tree mode — forced to self-collect via maxInlineFiles: 0
// -----------------------------------------------------------------------
describe("collectReviewContext — working-tree self-collect", () => {
  it("inputMode is self-collect when maxInlineFiles: 0", () => {
    const repo = makeTempRepo();
    fs.writeFileSync(path.join(repo, "README.md"), "hello world\nforced self-collect\n");

    const target = { mode: "working-tree", label: "working tree diff", explicit: true };
    const ctx = collectReviewContext(repo, target, { maxInlineFiles: 0 });

    assert.equal(ctx.inputMode, "self-collect");
  });

  it("inputMode is self-collect when maxInlineDiffBytes is tiny", () => {
    const repo = makeTempRepo();
    fs.writeFileSync(path.join(repo, "README.md"), "hello world\nself-collect via bytes\n");

    const target = { mode: "working-tree", label: "working tree diff", explicit: true };
    // 1 byte limit — any real diff will exceed it.
    const ctx = collectReviewContext(repo, target, { maxInlineDiffBytes: 1 });

    assert.equal(ctx.inputMode, "self-collect");
  });
});

// -----------------------------------------------------------------------
// 3. Branch mode — committed change on feature vs base
// -----------------------------------------------------------------------
describe("collectReviewContext — branch mode", () => {
  it("fileCount and changedFiles reflect the committed change on the feature branch", () => {
    const repo = makeTempRepo();

    // Create a feature branch and commit a new file on it.
    g(repo, ["checkout", "-b", "feature"]);
    fs.writeFileSync(path.join(repo, "feature.txt"), "feature content\n");
    g(repo, ["add", "feature.txt"]);
    g(repo, ["commit", "-m", "add feature"]);

    const target = resolveReviewTarget(repo, { base: "main" });
    assert.equal(target.mode, "branch");
    assert.equal(target.baseRef, "main");

    const ctx = collectReviewContext(repo, target);

    assert.equal(ctx.fileCount, 1);
    assert.ok(
      ctx.changedFiles.includes("feature.txt"),
      `expected changedFiles to include feature.txt, got: ${JSON.stringify(ctx.changedFiles)}`
    );
  });

  it("reflects multiple committed files when more than one file changed", () => {
    const repo = makeTempRepo();

    g(repo, ["checkout", "-b", "multi-feature"]);
    fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
    fs.writeFileSync(path.join(repo, "b.txt"), "b\n");
    g(repo, ["add", "a.txt", "b.txt"]);
    g(repo, ["commit", "-m", "add a and b"]);

    const target = resolveReviewTarget(repo, { base: "main" });
    const ctx = collectReviewContext(repo, target);

    assert.equal(ctx.fileCount, 2);
    assert.ok(ctx.changedFiles.includes("a.txt"));
    assert.ok(ctx.changedFiles.includes("b.txt"));
  });
});

// -----------------------------------------------------------------------
// 4. Returned object shape
// -----------------------------------------------------------------------
describe("collectReviewContext — returned object shape", () => {
  it("has cwd, repoRoot, branch, target, fileCount, diffBytes, inputMode", () => {
    const repo = makeTempRepo();
    fs.writeFileSync(path.join(repo, "README.md"), "shape check\n");

    const target = { mode: "working-tree", label: "working tree diff", explicit: true };
    const ctx = collectReviewContext(repo, target);

    for (const key of ["cwd", "repoRoot", "branch", "target", "fileCount", "diffBytes", "inputMode"]) {
      assert.ok(key in ctx, `missing key: ${key}`);
    }
    // target reference is preserved verbatim
    assert.equal(ctx.target, target);
    // diffBytes is a non-negative number
    assert.ok(typeof ctx.diffBytes === "number" && ctx.diffBytes >= 0);
    // branch is a non-empty string
    assert.ok(typeof ctx.branch === "string" && ctx.branch.length > 0);
  });
});
