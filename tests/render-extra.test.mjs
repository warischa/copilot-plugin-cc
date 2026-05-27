import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isRedundantPhase,
  renderSetupReport,
  renderReviewResult,
  renderStatusReport,
  renderJobStatusReport,
  renderStoredJobResult,
  renderCancelReport,
  renderTouchedFilesSummary,
} from "../plugins/copilot/scripts/lib/render.mjs";

// ---------------------------------------------------------------------------
// isRedundantPhase
// ---------------------------------------------------------------------------

describe("isRedundantPhase", () => {
  it("returns true for completed/done", () => {
    assert.equal(isRedundantPhase("completed", "done"), true);
  });
  it("returns true for failed/failed", () => {
    assert.equal(isRedundantPhase("failed", "failed"), true);
  });
  it("returns true for failed/error", () => {
    assert.equal(isRedundantPhase("failed", "error"), true);
  });
  it("returns true for failed/done", () => {
    assert.equal(isRedundantPhase("failed", "done"), true);
  });
  it("returns true for cancelled/cancelled", () => {
    assert.equal(isRedundantPhase("cancelled", "cancelled"), true);
  });
  it("returns true for cancelled/done", () => {
    assert.equal(isRedundantPhase("cancelled", "done"), true);
  });
  it("returns false for running/done", () => {
    assert.equal(isRedundantPhase("running", "done"), false);
  });
  it("returns false for completed/running (non-redundant phase)", () => {
    assert.equal(isRedundantPhase("completed", "running"), false);
  });
  it("returns false when status is null", () => {
    assert.equal(isRedundantPhase(null, "done"), false);
  });
  it("returns false when phase is null", () => {
    assert.equal(isRedundantPhase("completed", null), false);
  });
});

// ---------------------------------------------------------------------------
// renderTouchedFilesSummary
// ---------------------------------------------------------------------------

describe("renderTouchedFilesSummary", () => {
  it("returns null for empty array", () => {
    assert.equal(renderTouchedFilesSummary([]), null);
  });
  it("returns null for non-array (null)", () => {
    assert.equal(renderTouchedFilesSummary(null), null);
  });
  it("returns null for non-array (undefined)", () => {
    assert.equal(renderTouchedFilesSummary(undefined), null);
  });
  it("uses singular noun for one file", () => {
    const out = renderTouchedFilesSummary(["foo.js"]);
    assert.match(out, /Touched 1 file: foo\.js/);
  });
  it("uses plural noun for multiple files", () => {
    const out = renderTouchedFilesSummary(["a.js", "b.js"]);
    assert.match(out, /Touched 2 files: a\.js, b\.js/);
  });
  it("truncates with overflow suffix when char budget exceeded", () => {
    // 20 long paths easily exceed the 160-char budget
    const files = Array.from({ length: 20 }, (_, i) => `src/really/long/path/to/module${i}.ts`);
    const out = renderTouchedFilesSummary(files);
    assert.match(out, /Touched 20 files:/);
    assert.match(out, /\.\.\.and \d+ more/);
  });
  it("always includes at least the first file even if it exceeds budget alone", () => {
    const files = ["x".repeat(200), "b.js"];
    const out = renderTouchedFilesSummary(files);
    assert.match(out, /Touched 2 files:/);
    assert.match(out, /\.\.\.and 1 more/);
  });
});

// ---------------------------------------------------------------------------
// renderSetupReport — uncovered branches
// ---------------------------------------------------------------------------

const baseSetupReport = {
  ready: true,
  node: { detail: "v22" },
  npm: { detail: "10" },
  copilot: { detail: "ok" },
  auth: { detail: "ok" },
  actionsTaken: [],
  nextSteps: [],
};

describe("renderSetupReport — pluginConfig section", () => {
  it("renders model and effort when both present", () => {
    const out = renderSetupReport({
      ...baseSetupReport,
      pluginConfig: { path: "/cfg.json", model: "claude-3", effort: "high", warnings: [] },
    });
    assert.match(out, /Plugin config \(\/cfg\.json\)/);
    assert.match(out, /model=claude-3/);
    assert.match(out, /effort=high/);
  });

  it("renders '(no defaults set)' when model and effort absent", () => {
    const out = renderSetupReport({
      ...baseSetupReport,
      pluginConfig: { path: "/cfg.json", warnings: [] },
    });
    assert.match(out, /\(no defaults set\)/);
  });

  it("renders warnings prefixed with '!'", () => {
    const out = renderSetupReport({
      ...baseSetupReport,
      pluginConfig: { path: "/cfg.json", warnings: ["unknown key: foo", "deprecated: bar"] },
    });
    assert.match(out, /! unknown key: foo/);
    assert.match(out, /! deprecated: bar/);
  });
});

describe("renderSetupReport — instructions section", () => {
  it("renders instructions with scope and path", () => {
    const out = renderSetupReport({
      ...baseSetupReport,
      instructions: [
        { scope: "project", path: "/repo/.copilot/instructions.md" },
        { scope: "global", path: "/home/user/.copilot/instructions.md" },
      ],
    });
    assert.match(out, /Copilot custom instructions auto-loaded/);
    assert.match(out, /\[project\] \/repo\/.copilot\/instructions\.md/);
    assert.match(out, /\[global\] \/home\/user\/.copilot\/instructions\.md/);
  });

  it("omits instructions section when list is empty", () => {
    const out = renderSetupReport({ ...baseSetupReport, instructions: [] });
    assert.doesNotMatch(out, /auto-loaded/);
  });
});

describe("renderSetupReport — actionsTaken section", () => {
  it("renders actionsTaken list", () => {
    const out = renderSetupReport({
      ...baseSetupReport,
      actionsTaken: ["Created config file.", "Logged in to Copilot."],
    });
    assert.match(out, /Actions taken:/);
    assert.match(out, /Created config file\./);
    assert.match(out, /Logged in to Copilot\./);
  });
});

// ---------------------------------------------------------------------------
// renderReviewResult — uncovered branches
// ---------------------------------------------------------------------------

describe("renderReviewResult — additional branches", () => {
  it("shows 'completed without any output' when stdout empty and status 0", () => {
    const out = renderReviewResult(
      { status: 0, stdout: "", stderr: "" },
      { reviewLabel: "Review", targetLabel: "HEAD~1" }
    );
    assert.match(out, /Copilot review completed without any output/);
  });

  it("includes stderr block when stdout is non-empty and stderr present", () => {
    const out = renderReviewResult(
      { status: 0, stdout: "Looks good.", stderr: "warn: something" },
      { reviewLabel: "Review", targetLabel: "HEAD~1" }
    );
    assert.match(out, /Looks good\./);
    assert.match(out, /stderr:/);
    assert.match(out, /warn: something/);
  });
});

// ---------------------------------------------------------------------------
// renderStatusReport — uncovered branches
// ---------------------------------------------------------------------------

describe("renderStatusReport — running jobs", () => {
  it("renders active jobs table and live details for running jobs", () => {
    const out = renderStatusReport({
      running: [
        {
          id: "run-1",
          status: "running",
          kindLabel: "task",
          title: "Do something",
          phase: "working",
          elapsed: "5s",
          threadId: "tid-abc",
          summary: "Almost done",
        },
      ],
      recent: [],
      latestFinished: null,
    });
    assert.match(out, /Active jobs:/);
    assert.match(out, /run-1/);
    assert.match(out, /tid-abc/);
    assert.match(out, /Live details:/);
    assert.match(out, /Elapsed: 5s/);
  });

  it("includes cancel action in active jobs table for running job", () => {
    const out = renderStatusReport({
      running: [{ id: "r1", status: "running", kindLabel: "task" }],
      recent: [],
      latestFinished: null,
    });
    assert.match(out, /\/copilot:cancel r1/);
  });
});

describe("renderStatusReport — latestFinished", () => {
  it("renders latestFinished with duration", () => {
    const out = renderStatusReport({
      running: [],
      recent: [],
      latestFinished: {
        id: "job-done",
        status: "completed",
        kindLabel: "task",
        title: "Finished task",
        duration: "12s",
      },
    });
    assert.match(out, /Latest finished:/);
    assert.match(out, /job-done/);
    assert.match(out, /Duration: 12s/);
  });

  it("includes log path for failed latestFinished", () => {
    const out = renderStatusReport({
      running: [],
      recent: [],
      latestFinished: {
        id: "job-fail",
        status: "failed",
        logFile: "/tmp/job-fail.log",
      },
    });
    assert.match(out, /\/tmp\/job-fail\.log/);
  });
});

describe("renderStatusReport — recent jobs", () => {
  it("renders recent jobs list", () => {
    const out = renderStatusReport({
      running: [],
      recent: [
        { id: "old-1", status: "completed", title: "Old task", duration: "3s" },
        { id: "old-2", status: "failed", title: "Bad task" },
      ],
      latestFinished: null,
    });
    assert.match(out, /Recent jobs:/);
    assert.match(out, /old-1/);
    assert.match(out, /old-2/);
  });
});

describe("renderStatusReport — empty state", () => {
  it("renders 'No jobs recorded yet' when nothing to show", () => {
    const out = renderStatusReport({
      running: [],
      recent: [],
      latestFinished: null,
    });
    assert.match(out, /No jobs recorded yet/);
  });
});

// ---------------------------------------------------------------------------
// renderJobStatusReport
// ---------------------------------------------------------------------------

describe("renderJobStatusReport", () => {
  it("renders header with job id and status", () => {
    const out = renderJobStatusReport({ id: "job-42", status: "running", kindLabel: "task", title: "My task" });
    assert.match(out, /# Copilot Job Status/);
    assert.match(out, /job-42/);
    assert.match(out, /running/);
  });

  it("shows elapsed and cancel hint for running job", () => {
    const out = renderJobStatusReport({ id: "job-run", status: "running", elapsed: "20s" });
    assert.match(out, /Elapsed: 20s/);
    assert.match(out, /Cancel: \/copilot:cancel job-run/);
  });

  it("shows duration and result hint for completed job", () => {
    const out = renderJobStatusReport({ id: "job-done", status: "completed", duration: "45s" });
    assert.match(out, /Duration: 45s/);
    assert.match(out, /Result: \/copilot:result job-done/);
  });

  it("shows review hint for completed task with write=true", () => {
    const out = renderJobStatusReport({ id: "job-w", status: "completed", jobClass: "task", write: true });
    assert.match(out, /Review changes: \/copilot:review --wait/);
  });

  it("omits review hint for queued task even with write=true", () => {
    const out = renderJobStatusReport({ id: "job-q", status: "queued", jobClass: "task", write: true });
    assert.doesNotMatch(out, /Review changes/);
  });

  it("shows threadId and resume command when present", () => {
    const out = renderJobStatusReport({ id: "job-t", status: "completed", threadId: "sid-xyz" });
    assert.match(out, /Copilot session ID: sid-xyz/);
    assert.match(out, /copilot --resume=sid-xyz/);
  });

  it("shows progress preview lines", () => {
    const out = renderJobStatusReport({
      id: "job-p",
      status: "running",
      progressPreview: ["Step 1 done", "Step 2 in progress"],
    });
    assert.match(out, /Progress:/);
    assert.match(out, /Step 1 done/);
    assert.match(out, /Step 2 in progress/);
  });

  it("suppresses redundant phase for completed/done", () => {
    const out = renderJobStatusReport({ id: "job-c", status: "completed", phase: "done" });
    assert.doesNotMatch(out, /Phase: done/);
  });

  it("shows non-redundant phase for running job", () => {
    const out = renderJobStatusReport({ id: "job-r", status: "running", phase: "planning" });
    assert.match(out, /Phase: planning/);
  });

  it("shows log file", () => {
    const out = renderJobStatusReport({ id: "job-l", status: "failed", logFile: "/tmp/job-l.log" });
    assert.match(out, /Log: \/tmp\/job-l\.log/);
  });
});

// ---------------------------------------------------------------------------
// renderStoredJobResult — uncovered branches
// ---------------------------------------------------------------------------

describe("renderStoredJobResult — additional branches", () => {
  it("returns raw output only (no session line) when no threadId", () => {
    const out = renderStoredJobResult(
      { id: "j1", title: "T", status: "completed" },
      { result: { rawOutput: "output text" } }
    );
    assert.match(out, /output text/);
    assert.doesNotMatch(out, /Copilot session ID/);
  });

  it("uses copilot.stdout as rawOutput fallback with threadId", () => {
    const out = renderStoredJobResult(
      { id: "j6", title: "T", status: "completed" },
      { result: { copilot: { stdout: "copilot stdout output" } }, threadId: "t-77" }
    );
    assert.match(out, /copilot stdout output/);
    assert.match(out, /Copilot session ID: t-77/);
    assert.match(out, /copilot --resume=t-77/);
  });

  it("uses rendered fallback when no rawOutput, without threadId", () => {
    const out = renderStoredJobResult(
      { id: "j2", title: "T", status: "completed" },
      { rendered: "pre-rendered result" }
    );
    assert.match(out, /pre-rendered result/);
    assert.doesNotMatch(out, /Copilot session ID/);
  });

  it("appends session lines to rendered fallback when threadId present", () => {
    const out = renderStoredJobResult(
      { id: "j3", title: "T", status: "completed" },
      { rendered: "pre-rendered result", threadId: "t-99" }
    );
    assert.match(out, /pre-rendered result/);
    assert.match(out, /Copilot session ID: t-99/);
    assert.match(out, /copilot --resume=t-99/);
  });

  it("falls back to lines format when no rawOutput and no rendered", () => {
    const out = renderStoredJobResult(
      { id: "j4", title: "My Job", status: "failed", summary: "It broke" },
      {}
    );
    assert.match(out, /# My Job/);
    assert.match(out, /Job: j4/);
    assert.match(out, /Status: failed/);
    assert.match(out, /Summary: It broke/);
    assert.match(out, /No captured result payload/);
  });

  it("shows job.errorMessage in fallback lines format", () => {
    const out = renderStoredJobResult(
      { id: "j5", title: "T", status: "failed", errorMessage: "timed out" },
      {}
    );
    assert.match(out, /timed out/);
    assert.doesNotMatch(out, /No captured result payload/);
  });

  it("shows storedJob.errorMessage in fallback lines format", () => {
    const out = renderStoredJobResult(
      { id: "j7", title: "T", status: "failed" },
      { errorMessage: "network error" }
    );
    assert.match(out, /network error/);
  });

  it("includes threadId lines in fallback format when threadId present", () => {
    const out = renderStoredJobResult(
      { id: "j8", title: "T", status: "failed" },
      { threadId: "t-fallback" }
    );
    assert.match(out, /Copilot session ID: t-fallback/);
    assert.match(out, /copilot --resume=t-fallback/);
  });
});

// ---------------------------------------------------------------------------
// renderCancelReport — no title/summary
// ---------------------------------------------------------------------------

describe("renderCancelReport — minimal (no title/summary)", () => {
  it("renders cancel confirmation without Title/Summary lines", () => {
    const out = renderCancelReport({ id: "job-bare" });
    assert.match(out, /# Copilot Cancel/);
    assert.match(out, /Cancelled job-bare/);
    assert.match(out, /\/copilot:status/);
    assert.doesNotMatch(out, /Title:/);
    assert.doesNotMatch(out, /Summary:/);
  });
});
