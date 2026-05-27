import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  resolveReviewTarget,
  detectDefaultBranch,
  getWorkingTreeState,
} from "../plugins/copilot/scripts/lib/git.mjs";

let repoClean;
let repoDirty;
let cleanBranchName;

function g(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function initRepo(dir) {
  g(dir, ["init"]);
  g(dir, ["config", "user.email", "test@example.com"]);
  g(dir, ["config", "user.name", "Test User"]);
  fs.writeFileSync(path.join(dir, "README.md"), "hello");
  g(dir, ["add", "."]);
  g(dir, ["commit", "-m", "init"]);
  let branch = execFileSync("git", ["branch", "--show-current"], {
    cwd: dir,
    encoding: "utf8",
  }).trim();
  // Ensure the branch name is one detectDefaultBranch can resolve
  if (!["main", "master", "trunk"].includes(branch)) {
    g(dir, ["branch", "-m", branch, "main"]);
    branch = "main";
  }
  return branch;
}

before(() => {
  repoClean = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-git-clean-"));
  cleanBranchName = initRepo(repoClean);

  repoDirty = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-git-dirty-"));
  initRepo(repoDirty);
  // Make the tree dirty with an untracked file
  fs.writeFileSync(path.join(repoDirty, "dirty.txt"), "dirty content");
});

after(() => {
  fs.rmSync(repoClean, { recursive: true, force: true });
  fs.rmSync(repoDirty, { recursive: true, force: true });
});

describe("detectDefaultBranch", () => {
  it("returns the local branch name when no remote is configured", () => {
    const branch = detectDefaultBranch(repoClean);
    assert.equal(branch, cleanBranchName);
  });
});

describe("getWorkingTreeState", () => {
  it("returns empty arrays and isDirty=false on a clean committed repo", () => {
    const state = getWorkingTreeState(repoClean);
    assert.deepEqual(state.staged, []);
    assert.deepEqual(state.unstaged, []);
    assert.deepEqual(state.untracked, []);
    assert.equal(state.isDirty, false);
  });

  it("detects an untracked file and marks isDirty=true", () => {
    const state = getWorkingTreeState(repoDirty);
    assert.equal(state.isDirty, true);
    assert.ok(state.untracked.includes("dirty.txt"), "dirty.txt should be in untracked");
  });

  it("detects a staged new file", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-git-staged-"));
    try {
      initRepo(tmp);
      fs.writeFileSync(path.join(tmp, "staged.txt"), "staged");
      g(tmp, ["add", "staged.txt"]);
      const state = getWorkingTreeState(tmp);
      assert.equal(state.isDirty, true);
      assert.ok(state.staged.includes("staged.txt"), "staged.txt should be in staged");
      assert.deepEqual(state.unstaged, []);
      assert.deepEqual(state.untracked, []);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("detects an unstaged modification to a tracked file", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-git-mod-"));
    try {
      initRepo(tmp);
      fs.writeFileSync(path.join(tmp, "README.md"), "modified content");
      const state = getWorkingTreeState(tmp);
      assert.equal(state.isDirty, true);
      assert.ok(state.unstaged.includes("README.md"), "README.md should be in unstaged");
      assert.deepEqual(state.staged, []);
      assert.deepEqual(state.untracked, []);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("resolveReviewTarget", () => {
  it("(a) options.base set overrides scope => mode branch, baseRef matches, explicit true", () => {
    const result = resolveReviewTarget(repoClean, { base: "my-base-ref", scope: "working-tree" });
    assert.equal(result.mode, "branch");
    assert.equal(result.baseRef, "my-base-ref");
    assert.equal(result.explicit, true);
  });

  it("(b) scope working-tree => mode working-tree, explicit true", () => {
    const result = resolveReviewTarget(repoClean, { scope: "working-tree" });
    assert.equal(result.mode, "working-tree");
    assert.equal(result.explicit, true);
    assert.equal(result.baseRef, undefined);
  });

  it("(c) scope branch => uses detectDefaultBranch as baseRef, explicit true", () => {
    const result = resolveReviewTarget(repoClean, { scope: "branch" });
    assert.equal(result.mode, "branch");
    assert.equal(result.baseRef, cleanBranchName);
    assert.equal(result.explicit, true);
  });

  it("(d) unsupported scope value throws", () => {
    assert.throws(
      () => resolveReviewTarget(repoClean, { scope: "staged" }),
      /Unsupported review scope/
    );
  });

  it("(e) scope auto on dirty working tree => mode working-tree, explicit false", () => {
    const result = resolveReviewTarget(repoDirty);
    assert.equal(result.mode, "working-tree");
    assert.equal(result.explicit, false);
  });

  it("(f) scope auto on clean tree => mode branch fallback, explicit false", () => {
    const result = resolveReviewTarget(repoClean);
    assert.equal(result.mode, "branch");
    assert.equal(result.baseRef, cleanBranchName);
    assert.equal(result.explicit, false);
  });
});
