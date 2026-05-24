// Tests for the post-0.3.0 bug fixes (B1, B2, B3).
// B1 — getJobKindLabel must map every jobClass to a sensible label, never "rescue" by default.
// B2 — REVIEW_BASELINE_DENY_TOOLS no longer contains "edit" (Copilot has no such tool).
// B3 — extractVersionLine strips the "Run 'copilot update'…" advisory line.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  getJobKindLabel,
  REVIEW_BASELINE_DENY_TOOLS
} from "../plugins/copilot/scripts/copilot-companion.mjs";
import {
  buildCopilotArgs,
  detectInstructionsFiles,
  extractVersionLine
} from "../plugins/copilot/scripts/lib/copilot.mjs";

let workRoot;

before(() => {
  workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-helpers-"));
});

after(() => {
  fs.rmSync(workRoot, { recursive: true, force: true });
});

function mkRepo(label) {
  const root = fs.mkdtempSync(path.join(workRoot, `${label}-`));
  return root;
}

function touch(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "");
}

describe("B1 getJobKindLabel", () => {
  it("returns the correct label for every known jobClass", () => {
    assert.equal(getJobKindLabel("task"), "task");
    assert.equal(getJobKindLabel("review"), "review");
    assert.equal(getJobKindLabel("adversarial-review"), "adversarial-review");
    assert.equal(getJobKindLabel("rescue"), "rescue");
  });

  it("does NOT label a plain task as rescue (regression test)", () => {
    assert.notEqual(getJobKindLabel("task"), "rescue");
  });

  it("falls back to the jobClass string when unknown", () => {
    assert.equal(getJobKindLabel("custom-kind"), "custom-kind");
  });

  it("defaults to 'task' when jobClass is missing", () => {
    assert.equal(getJobKindLabel(undefined), "task");
    assert.equal(getJobKindLabel(null), "task");
    assert.equal(getJobKindLabel(""), "task");
  });
});

describe("B2 REVIEW_BASELINE_DENY_TOOLS", () => {
  it("includes write and shell", () => {
    assert.ok(REVIEW_BASELINE_DENY_TOOLS.includes("write"));
    assert.ok(REVIEW_BASELINE_DENY_TOOLS.includes("shell"));
  });

  it("no longer includes 'edit' (Copilot CLI has no such tool)", () => {
    assert.ok(!REVIEW_BASELINE_DENY_TOOLS.includes("edit"));
  });

  it("is frozen", () => {
    assert.ok(Object.isFrozen(REVIEW_BASELINE_DENY_TOOLS));
  });
});

describe("B3 extractVersionLine", () => {
  it("returns the first non-empty line", () => {
    const input = "GitHub Copilot CLI 1.0.52.\nRun 'copilot update' to check for updates.";
    assert.equal(extractVersionLine(input), "GitHub Copilot CLI 1.0.52.");
  });

  it("trims surrounding whitespace and CR characters", () => {
    assert.equal(extractVersionLine("  v9.9.9  \r\nfollow-up\r\n"), "v9.9.9");
  });

  it("returns the same string when there's only one line", () => {
    assert.equal(extractVersionLine("v1.2.3"), "v1.2.3");
  });

  it("skips leading blank lines", () => {
    assert.equal(extractVersionLine("\n\nGitHub Copilot CLI 2.0.0\nnotice"), "GitHub Copilot CLI 2.0.0");
  });

  it("returns non-string input unchanged", () => {
    assert.equal(extractVersionLine(undefined), undefined);
    assert.equal(extractVersionLine(null), null);
  });
});

describe("D3 detectInstructionsFiles", () => {
  it("returns an empty list when nothing is present", () => {
    const repo = mkRepo("empty");
    const fakeHome = mkRepo("home");
    const found = detectInstructionsFiles(repo, { homedir: fakeHome });
    assert.deepEqual(found, []);
  });

  it("detects .github/copilot-instructions.md", () => {
    const repo = mkRepo("github-md");
    const fakeHome = mkRepo("home2");
    touch(path.join(repo, ".github", "copilot-instructions.md"));
    const found = detectInstructionsFiles(repo, { homedir: fakeHome });
    assert.equal(found.length, 1);
    assert.equal(found[0].scope, "repo");
    assert.ok(found[0].path.endsWith(path.join(".github", "copilot-instructions.md")));
  });

  it("detects AGENTS.md at the repo root", () => {
    const repo = mkRepo("agents");
    const fakeHome = mkRepo("home3");
    touch(path.join(repo, "AGENTS.md"));
    const found = detectInstructionsFiles(repo, { homedir: fakeHome });
    assert.equal(found.length, 1);
    assert.equal(found[0].scope, "repo");
  });

  it("detects modular .github/instructions/*.instructions.md files", () => {
    const repo = mkRepo("modular");
    const fakeHome = mkRepo("home4");
    touch(path.join(repo, ".github", "instructions", "frontend.instructions.md"));
    touch(path.join(repo, ".github", "instructions", "backend.instructions.md"));
    // A non-matching file in the same dir must be ignored.
    touch(path.join(repo, ".github", "instructions", "README.md"));
    const found = detectInstructionsFiles(repo, { homedir: fakeHome });
    const modular = found.filter((entry) => entry.scope === "repo-modular");
    assert.equal(modular.length, 2);
  });

  it("detects ~/.copilot/copilot-instructions.md as global scope", () => {
    const repo = mkRepo("with-global");
    const fakeHome = mkRepo("home5");
    touch(path.join(fakeHome, ".copilot", "copilot-instructions.md"));
    const found = detectInstructionsFiles(repo, { homedir: fakeHome });
    assert.equal(found.length, 1);
    assert.equal(found[0].scope, "global");
  });

  it("returns multiple entries when several variants coexist", () => {
    const repo = mkRepo("many");
    const fakeHome = mkRepo("home6");
    touch(path.join(repo, "AGENTS.md"));
    touch(path.join(repo, ".github", "copilot-instructions.md"));
    touch(path.join(fakeHome, ".copilot", "copilot-instructions.md"));
    const found = detectInstructionsFiles(repo, { homedir: fakeHome });
    assert.equal(found.length, 3);
    const scopes = found.map((entry) => entry.scope).sort();
    assert.deepEqual(scopes, ["global", "repo", "repo"]);
  });
});

describe("buildCopilotArgs (D5+D6+D8)", () => {
  it("baseline contains JSON output, no-color, no-auto-update, allow-all-tools", () => {
    const args = buildCopilotArgs({ prompt: "hi" });
    assert.deepEqual(args, [
      "-p",
      "hi",
      "--output-format",
      "json",
      "--no-color",
      "--no-auto-update",
      "--allow-all-tools"
    ]);
  });

  it("D5: planMode pushes --plan", () => {
    const args = buildCopilotArgs({ prompt: "x", planMode: true });
    assert.ok(args.includes("--plan"));
    assert.ok(!args.includes("--autopilot"));
  });

  it("D5+D6: planMode takes precedence over autopilot (mutually exclusive)", () => {
    const args = buildCopilotArgs({
      prompt: "x",
      planMode: true,
      autopilot: true,
      maxAutopilotContinues: 9
    });
    assert.ok(args.includes("--plan"));
    assert.ok(!args.includes("--autopilot"));
    assert.ok(!args.includes("--max-autopilot-continues"));
  });

  it("D6: autopilot pushes --autopilot and forwards continues count", () => {
    const args = buildCopilotArgs({
      prompt: "x",
      autopilot: true,
      maxAutopilotContinues: 7
    });
    assert.ok(args.includes("--autopilot"));
    const idx = args.indexOf("--max-autopilot-continues");
    assert.ok(idx >= 0);
    assert.equal(args[idx + 1], "7");
  });

  it("D6: --max-autopilot-continues only appears when value is a positive number", () => {
    const args = buildCopilotArgs({
      prompt: "x",
      autopilot: true,
      maxAutopilotContinues: 0
    });
    assert.ok(args.includes("--autopilot"));
    assert.ok(!args.includes("--max-autopilot-continues"));
  });

  it("D8: noCustomInstructions pushes --no-custom-instructions", () => {
    const args = buildCopilotArgs({
      prompt: "x",
      noCustomInstructions: true
    });
    assert.ok(args.includes("--no-custom-instructions"));
  });

  it("D8: omits --no-custom-instructions by default", () => {
    const args = buildCopilotArgs({ prompt: "x" });
    assert.ok(!args.includes("--no-custom-instructions"));
  });
});
