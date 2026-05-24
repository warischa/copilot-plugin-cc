// Tests for the post-0.3.0 bug fixes (B1, B2, B3).
// B1 — getJobKindLabel must map every jobClass to a sensible label, never "rescue" by default.
// B2 — REVIEW_BASELINE_DENY_TOOLS no longer contains "edit" (Copilot has no such tool).
// B3 — extractVersionLine strips the "Run 'copilot update'…" advisory line.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  getJobKindLabel,
  REVIEW_BASELINE_DENY_TOOLS
} from "../plugins/copilot/scripts/copilot-companion.mjs";
import { extractVersionLine } from "../plugins/copilot/scripts/lib/copilot.mjs";

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
