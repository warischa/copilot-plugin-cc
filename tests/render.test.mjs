import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  renderReviewResult,
  renderSetupReport,
  renderTaskResult,
  renderStoredJobResult,
  renderCancelReport
} from "../plugins/copilot/scripts/lib/render.mjs";

describe("renderReviewResult", () => {
  it("includes target label and stdout body", () => {
    const out = renderReviewResult(
      { status: 0, stdout: "Looks good.", stderr: "" },
      { reviewLabel: "Review", targetLabel: "working tree diff" }
    );
    assert.match(out, /Copilot Review/);
    assert.match(out, /working tree diff/);
    assert.match(out, /Looks good\./);
  });

  it("notes failures when stdout is empty and status non-zero", () => {
    const out = renderReviewResult(
      { status: 1, stdout: "", stderr: "boom" },
      { reviewLabel: "Review", targetLabel: "branch diff" }
    );
    assert.match(out, /Copilot review failed/);
    assert.match(out, /boom/);
  });
});

describe("renderSetupReport", () => {
  it("renders ready=true with no next steps", () => {
    const out = renderSetupReport({
      ready: true,
      node: { detail: "v22" },
      npm: { detail: "10" },
      copilot: { detail: "ok" },
      auth: { detail: "ok" },
      actionsTaken: [],
      nextSteps: []
    });
    assert.match(out, /Status: ready/);
  });

  it("renders next steps when not ready", () => {
    const out = renderSetupReport({
      ready: false,
      node: { detail: "v22" },
      npm: { detail: "10" },
      copilot: { detail: "not found" },
      auth: { detail: "n/a" },
      actionsTaken: [],
      nextSteps: ["Install Copilot."]
    });
    assert.match(out, /Status: needs attention/);
    assert.match(out, /Install Copilot/);
  });
});

describe("renderTaskResult", () => {
  it("returns raw output when present", () => {
    assert.equal(renderTaskResult({ rawOutput: "hello" }), "hello\n");
  });
  it("falls back to failure message", () => {
    assert.equal(renderTaskResult({ rawOutput: "", failureMessage: "boom" }), "boom\n");
  });
});

describe("renderStoredJobResult", () => {
  it("includes resume command when threadId present", () => {
    const out = renderStoredJobResult(
      { id: "x", title: "t", status: "completed" },
      { threadId: "abc-123", result: { rawOutput: "done" } }
    );
    assert.match(out, /Copilot session ID: abc-123/);
    assert.match(out, /copilot --resume=abc-123/);
  });
});

describe("renderCancelReport", () => {
  it("mentions /copilot:status follow-up", () => {
    const out = renderCancelReport({ id: "job-1", title: "T", summary: "S" });
    assert.match(out, /Cancelled job-1/);
    assert.match(out, /\/copilot:status/);
  });
});
