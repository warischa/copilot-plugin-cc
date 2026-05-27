// Deeper-branch tests for collectReviewContext() from lib/git.mjs.
// Covers: explicit includeDiff override (true/false independent of size
// thresholds), multi-file working-tree fileCount, and diffBytes > 0 for
// real changes.

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-review-extra-"));
  tmpDirs.push(dir);
  g(dir, ["init"]);
  g(dir, ["config", "user.email", "test@example.com"]);
  g(dir, ["config", "user.name", "Test User"]);
  fs.writeFileSync(path.join(dir, "README.md"), "hello world\n");
  g(dir, ["add", "."]);
  g(dir, ["commit", "-m", "init"]);
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
// 1. options.includeDiff = true — overrides size thresholds
// -----------------------------------------------------------------------
describe("collectReviewContext — includeDiff:true override", () => {
  it("inputMode is inline-diff even when maxInlineFiles:0 would force self-collect", () => {
    const repo = makeTempRepo();
    fs.writeFileSync(path.join(repo, "README.md"), "hello world\nmodified\n");

    const target = { mode: "working-tree", label: "working tree diff", explicit: true };
    // maxInlineFiles:0 alone makes fileCount(1) > 0 false → self-collect;
    // includeDiff:true must short-circuit the ?? and override it.
    const ctx = collectReviewContext(repo, target, { maxInlineFiles: 0, includeDiff: true });

    assert.equal(ctx.inputMode, "inline-diff");
  });

  it("inputMode is inline-diff even when maxInlineDiffBytes:1 would force self-collect", () => {
    const repo = makeTempRepo();
    fs.writeFileSync(path.join(repo, "README.md"), "hello world\nbytes override\n");

    const target = { mode: "working-tree", label: "working tree diff", explicit: true };
    // Any real diff will exceed 1 byte, so threshold alone → self-collect.
    const ctx = collectReviewContext(repo, target, { maxInlineDiffBytes: 1, includeDiff: true });

    assert.equal(ctx.inputMode, "inline-diff");
  });

  it("inputMode is inline-diff for branch mode with includeDiff:true overriding maxInlineFiles:0", () => {
    const repo = makeTempRepo();
    g(repo, ["checkout", "-b", "force-inline"]);
    fs.writeFileSync(path.join(repo, "tiny.txt"), "x\n");
    g(repo, ["add", "tiny.txt"]);
    g(repo, ["commit", "-m", "add tiny"]);

    const target = resolveReviewTarget(repo, { base: "main" });
    const ctx = collectReviewContext(repo, target, { maxInlineFiles: 0, includeDiff: true });

    assert.equal(ctx.inputMode, "inline-diff");
  });
});

// -----------------------------------------------------------------------
// 2. options.includeDiff = false — overrides size thresholds
// -----------------------------------------------------------------------
describe("collectReviewContext — includeDiff:false override", () => {
  it("inputMode is self-collect for a single small file that would normally be inline-diff", () => {
    const repo = makeTempRepo();
    fs.writeFileSync(path.join(repo, "README.md"), "hello world\nsmall change\n");

    const target = { mode: "working-tree", label: "working tree diff", explicit: true };
    // 1 file, tiny bytes → thresholds would yield inline-diff without override.
    const ctx = collectReviewContext(repo, target, { includeDiff: false });

    assert.equal(ctx.inputMode, "self-collect");
  });

  it("inputMode is self-collect for branch mode with one small commit and includeDiff:false", () => {
    const repo = makeTempRepo();
    g(repo, ["checkout", "-b", "force-self-collect"]);
    fs.writeFileSync(path.join(repo, "small.txt"), "tiny content\n");
    g(repo, ["add", "small.txt"]);
    g(repo, ["commit", "-m", "add small file"]);

    const target = resolveReviewTarget(repo, { base: "main" });
    // 1 file, tiny diff → inline-diff by default; override to self-collect.
    const ctx = collectReviewContext(repo, target, { includeDiff: false });

    assert.equal(ctx.inputMode, "self-collect");
  });
});

// -----------------------------------------------------------------------
// 3. Multi-file working-tree — fileCount and changedFiles
// -----------------------------------------------------------------------
describe("collectReviewContext — multi-file working-tree", () => {
  it("fileCount is 3 for one unstaged modification and two untracked files", () => {
    const repo = makeTempRepo();
    fs.writeFileSync(path.join(repo, "README.md"), "hello world\nedited\n");
    fs.writeFileSync(path.join(repo, "new1.txt"), "file one\n");
    fs.writeFileSync(path.join(repo, "new2.txt"), "file two\n");

    const target = { mode: "working-tree", label: "working tree diff", explicit: true };
    const ctx = collectReviewContext(repo, target);

    assert.equal(ctx.fileCount, 3);
    assert.ok(ctx.changedFiles.includes("README.md"), "should include README.md");
    assert.ok(ctx.changedFiles.includes("new1.txt"), "should include new1.txt");
    assert.ok(ctx.changedFiles.includes("new2.txt"), "should include new2.txt");
  });

  it("fileCount is 2 for two staged new files", () => {
    const repo = makeTempRepo();
    fs.writeFileSync(path.join(repo, "alpha.txt"), "alpha\n");
    fs.writeFileSync(path.join(repo, "beta.txt"), "beta\n");
    g(repo, ["add", "alpha.txt", "beta.txt"]);

    const target = { mode: "working-tree", label: "working tree diff", explicit: true };
    const ctx = collectReviewContext(repo, target);

    assert.equal(ctx.fileCount, 2);
    assert.ok(ctx.changedFiles.includes("alpha.txt"), "should include alpha.txt");
    assert.ok(ctx.changedFiles.includes("beta.txt"), "should include beta.txt");
  });

  it("fileCount counts unique files when a file appears in both staged and unstaged buckets", () => {
    const repo = makeTempRepo();
    // Stage a partial change to README.md, then make another unstaged change.
    fs.writeFileSync(path.join(repo, "README.md"), "hello world\nstaged line\n");
    g(repo, ["add", "README.md"]);
    fs.writeFileSync(path.join(repo, "README.md"), "hello world\nstaged line\nunstaged line\n");

    const target = { mode: "working-tree", label: "working tree diff", explicit: true };
    const ctx = collectReviewContext(repo, target);

    // README.md appears in both staged and unstaged; should count as 1 unique file.
    assert.equal(ctx.fileCount, 1);
    assert.ok(ctx.changedFiles.includes("README.md"));
  });
});

// -----------------------------------------------------------------------
// 4. diffBytes > 0 for real changes
// -----------------------------------------------------------------------
describe("collectReviewContext — diffBytes > 0", () => {
  it("diffBytes is greater than 0 for an unstaged modification", () => {
    const repo = makeTempRepo();
    fs.writeFileSync(path.join(repo, "README.md"), "hello world\nactual content added\n");

    const target = { mode: "working-tree", label: "working tree diff", explicit: true };
    const ctx = collectReviewContext(repo, target);

    assert.ok(ctx.diffBytes > 0, `expected diffBytes > 0, got ${ctx.diffBytes}`);
  });

  it("diffBytes is greater than 0 for a staged new file", () => {
    const repo = makeTempRepo();
    fs.writeFileSync(path.join(repo, "staged.txt"), "staged content here\n");
    g(repo, ["add", "staged.txt"]);

    const target = { mode: "working-tree", label: "working tree diff", explicit: true };
    const ctx = collectReviewContext(repo, target);

    assert.ok(ctx.diffBytes > 0, `expected diffBytes > 0 for staged file, got ${ctx.diffBytes}`);
  });

  it("diffBytes is greater than 0 for a branch commit", () => {
    const repo = makeTempRepo();
    g(repo, ["checkout", "-b", "diffbytes-branch"]);
    fs.writeFileSync(path.join(repo, "data.txt"), "some real content\n");
    g(repo, ["add", "data.txt"]);
    g(repo, ["commit", "-m", "add data"]);

    const target = resolveReviewTarget(repo, { base: "main" });
    const ctx = collectReviewContext(repo, target);

    assert.ok(ctx.diffBytes > 0, `expected diffBytes > 0 for branch commit, got ${ctx.diffBytes}`);
  });
});
