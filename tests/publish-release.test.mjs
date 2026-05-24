// Tests for scripts/publish-release.mjs.
// Exercise the pure pieces (arg parser, step builder, preflight) and the
// dry-run path end-to-end via the exported runner. We never spawn `git`,
// `npm`, or `gh` for real here.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  parseArgs,
  buildSteps,
  preflightChecks,
  createRunner
} from "../scripts/publish-release.mjs";

let workRoot;

before(() => {
  workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-publish-release-"));
});

after(() => {
  fs.rmSync(workRoot, { recursive: true, force: true });
});

function fakeRepo() {
  const root = fs.mkdtempSync(path.join(workRoot, "repo-"));
  fs.mkdirSync(path.join(root, ".git"));
  return root;
}

function fakeExec({ branch = "main", clean = true } = {}) {
  const calls = [];
  return {
    calls,
    exec(command, args) {
      calls.push({ command, args });
      if (command !== "git") {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return { status: 0, stdout: `${branch}\n`, stderr: "" };
      }
      if (args[0] === "status" && args[1] === "--porcelain") {
        return { status: 0, stdout: clean ? "" : " M file.txt\n", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    }
  };
}

describe("publish-release / parseArgs", () => {
  it("parses version + default options", () => {
    const opts = parseArgs(["0.3.0"]);
    assert.equal(opts.version, "0.3.0");
    assert.equal(opts.dryRun, false);
    assert.equal(opts.skipTests, false);
    assert.equal(opts.skipPush, false);
    assert.equal(opts.skipGhRelease, false);
    assert.equal(opts.allowDirty, false);
    assert.equal(opts.branch, "main");
    assert.equal(opts.remote, "origin");
  });

  it("honours every flag", () => {
    const opts = parseArgs([
      "1.0.0",
      "--dry-run",
      "--skip-tests",
      "--skip-push",
      "--skip-gh-release",
      "--allow-dirty",
      "--branch",
      "release",
      "--remote",
      "upstream"
    ]);
    assert.equal(opts.dryRun, true);
    assert.equal(opts.skipTests, true);
    assert.equal(opts.skipPush, true);
    assert.equal(opts.skipGhRelease, true);
    assert.equal(opts.allowDirty, true);
    assert.equal(opts.branch, "release");
    assert.equal(opts.remote, "upstream");
  });

  it("rejects unknown options", () => {
    assert.throws(() => parseArgs(["0.1.0", "--bogus"]), /Unknown option/);
  });

  it("rejects extra positional arguments", () => {
    assert.throws(() => parseArgs(["0.1.0", "0.1.1"]), /Unexpected extra argument/);
  });

  it("--branch requires a value", () => {
    assert.throws(() => parseArgs(["0.1.0", "--branch"]), /requires a value/);
  });
});

describe("publish-release / buildSteps", () => {
  it("emits the full release flow by default", () => {
    const steps = buildSteps({
      version: "0.3.0",
      root: "/repo",
      remote: "origin",
      branch: "main",
      skipTests: false,
      skipPush: false,
      skipGhRelease: false
    });

    const labels = steps.map((s) => s.label);
    assert.deepEqual(labels, [
      "bump-version",
      "test",
      "git add",
      "git commit",
      "git tag",
      "git push",
      "gh release"
    ]);

    const tag = steps.find((s) => s.label === "git tag");
    assert.deepEqual(tag.args, ["tag", "-a", "v0.3.0", "-m", "Release 0.3.0"]);

    const push = steps.find((s) => s.label === "git push");
    assert.deepEqual(push.args, ["push", "origin", "main", "--follow-tags"]);

    const gh = steps.find((s) => s.label === "gh release");
    assert.deepEqual(gh.args, [
      "release",
      "create",
      "v0.3.0",
      "--title",
      "Release 0.3.0",
      "--notes",
      "Release 0.3.0"
    ]);
  });

  it("honours skip flags", () => {
    const steps = buildSteps({
      version: "0.3.0",
      root: "/repo",
      remote: "origin",
      branch: "main",
      skipTests: true,
      skipPush: true,
      skipGhRelease: true
    });
    const labels = steps.map((s) => s.label);
    assert.deepEqual(labels, ["bump-version", "git add", "git commit", "git tag"]);
  });

  it("stages exactly the three manifest files", () => {
    const steps = buildSteps({
      version: "0.3.0",
      root: "/repo",
      remote: "origin",
      branch: "main",
      skipTests: true,
      skipPush: true,
      skipGhRelease: true
    });
    const add = steps.find((s) => s.label === "git add");
    assert.deepEqual(add.args, [
      "add",
      "package.json",
      "plugins/copilot/.claude-plugin/plugin.json",
      ".claude-plugin/marketplace.json"
    ]);
  });
});

describe("publish-release / preflightChecks", () => {
  it("passes when on the expected branch with a clean tree", () => {
    const repo = fakeRepo();
    const { exec } = fakeExec({ branch: "main", clean: true });
    const result = preflightChecks({ root: repo, branch: "main", allowDirty: false, exec });
    assert.equal(result.currentBranch, "main");
  });

  it("refuses when branch does not match", () => {
    const repo = fakeRepo();
    const { exec } = fakeExec({ branch: "feature", clean: true });
    assert.throws(
      () => preflightChecks({ root: repo, branch: "main", allowDirty: false, exec }),
      /Expected branch "main", currently on "feature"/
    );
  });

  it("refuses when the working tree is dirty", () => {
    const repo = fakeRepo();
    const { exec } = fakeExec({ branch: "main", clean: false });
    assert.throws(
      () => preflightChecks({ root: repo, branch: "main", allowDirty: false, exec }),
      /Working tree is not clean/
    );
  });

  it("allows a dirty tree when --allow-dirty is set", () => {
    const repo = fakeRepo();
    const { exec } = fakeExec({ branch: "main", clean: false });
    assert.doesNotThrow(() =>
      preflightChecks({ root: repo, branch: "main", allowDirty: true, exec })
    );
  });

  it("refuses when not in a git repository", () => {
    const notRepo = fs.mkdtempSync(path.join(workRoot, "notrepo-"));
    assert.throws(
      () => preflightChecks({ root: notRepo, branch: "main", allowDirty: false }),
      /Not a git repository/
    );
  });
});

describe("publish-release / createRunner dry-run", () => {
  it("records every command without executing it", () => {
    const logs = [];
    const execCalls = [];
    const { run, history } = createRunner({
      dryRun: true,
      log: (line) => logs.push(line),
      exec: (...args) => {
        execCalls.push(args);
        return { status: 0, stdout: "", stderr: "" };
      }
    });

    run("git", ["status"]);
    run("npm", ["test"]);

    assert.equal(execCalls.length, 0);
    assert.equal(history.length, 2);
    assert.match(logs[0], /\[dry-run\] git status/);
    assert.match(logs[1], /\[dry-run\] npm test/);
  });

  it("propagates real exec failures with stderr", () => {
    const { run } = createRunner({
      dryRun: false,
      log: () => {},
      exec: () => ({ status: 1, stdout: "", stderr: "boom" })
    });
    assert.throws(() => run("git", ["push"]), /Command failed.*status 1.*boom/s);
  });
});
