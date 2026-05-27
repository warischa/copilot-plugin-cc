// Hermetic coverage for the task/plan run-dispatch handlers in
// copilot-companion.mjs. These exercise the option-mapping, session-name
// precedence, prompt validation, and result/render shaping WITHOUT spawning the
// real copilot binary — by injecting a fake runner + availability check via the
// handlers' `deps` param (the same testability seam used in lib/copilot.mjs).
// This is the hermetic alternative to a live-copilot harness.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  executeTaskRun,
  executePlanRun,
} from "../plugins/copilot/scripts/copilot-companion.mjs";

const RESULT = {
  status: "completed",
  threadId: "sess-123",
  turnId: 2,
  finalMessage: "All done.",
  stderr: "",
  touchedFiles: ["a.js"],
};

// A fake copilot runner that records how it was called and returns a canned
// result, plus a no-op availability check.
function fakeDeps(result = RESULT) {
  const calls = [];
  return {
    calls,
    deps: {
      runCopilotPrompt: async (cwd, opts) => {
        calls.push({ cwd, opts });
        return result;
      },
      ensureCopilotAvailable: () => {},
    },
  };
}

let tempDir;
let priorPluginData;

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-run-dispatch-"));
  // Keep any incidental state access off real user state.
  priorPluginData = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = tempDir;
});

after(() => {
  if (priorPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = priorPluginData;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("executeTaskRun", () => {
  it("shapes the result and renders the final answer (happy path)", async () => {
    const { deps, calls } = fakeDeps();
    const out = await executeTaskRun({ cwd: tempDir, prompt: "Add a feature" }, deps);
    assert.equal(out.jobClass, "task");
    assert.equal(out.exitStatus, "completed");
    assert.equal(out.threadId, "sess-123");
    assert.equal(out.turnId, 2);
    assert.equal(out.payload.rawOutput, "All done.");
    assert.deepEqual(out.payload.touchedFiles, ["a.js"]);
    assert.match(out.rendered, /All done\./);
    assert.equal(calls.length, 1, "runner should be invoked exactly once");
  });

  it("forwards model/effort/autopilot options to the runner with allowAllTools", async () => {
    const { deps, calls } = fakeDeps();
    await executeTaskRun(
      { cwd: tempDir, prompt: "do x", model: "gpt-5.4", effort: "high", autopilot: true, maxAutopilotContinues: 3 },
      deps
    );
    const opts = calls[0].opts;
    assert.equal(opts.allowAllTools, true);
    assert.equal(opts.model, "gpt-5.4");
    assert.equal(opts.effort, "high");
    assert.equal(opts.autopilot, true);
    assert.equal(opts.maxAutopilotContinues, 3);
    assert.equal(opts.prompt, "do x");
  });

  it("honors an explicit --session-name, else auto-generates one", async () => {
    const explicit = fakeDeps();
    await executeTaskRun({ cwd: tempDir, prompt: "p", sessionName: "  my session  " }, explicit.deps);
    assert.equal(explicit.calls[0].opts.sessionName, "my session");

    const auto = fakeDeps();
    await executeTaskRun({ cwd: tempDir, prompt: "p" }, auto.deps);
    assert.match(auto.calls[0].opts.sessionName, /^copilot-task/);
  });

  it("throws (without invoking the runner) when no prompt and no resume", async () => {
    const { deps, calls } = fakeDeps();
    await assert.rejects(() => executeTaskRun({ cwd: tempDir }, deps), /Provide a prompt/);
    assert.equal(calls.length, 0);
  });
});

describe("executePlanRun", () => {
  it("runs in plan mode with the read-only deny list (happy path)", async () => {
    const { deps, calls } = fakeDeps();
    const out = await executePlanRun({ cwd: tempDir, prompt: "Plan the migration" }, deps);
    assert.equal(out.jobClass, "plan");
    assert.equal(out.jobTitle, "Copilot Plan");
    assert.equal(out.write, false);
    const opts = calls[0].opts;
    assert.equal(opts.planMode, true);
    assert.deepEqual(opts.denyTools, ["write", "shell"]);
    assert.equal(opts.allowAllTools, true);
  });

  it("honors an explicit --session-name, else auto-generates a plan name", async () => {
    const explicit = fakeDeps();
    await executePlanRun({ cwd: tempDir, prompt: "p", sessionName: "plan-x" }, explicit.deps);
    assert.equal(explicit.calls[0].opts.sessionName, "plan-x");

    const auto = fakeDeps();
    await executePlanRun({ cwd: tempDir, prompt: "p" }, auto.deps);
    assert.match(auto.calls[0].opts.sessionName, /^copilot-task/);
  });

  it("throws (without invoking the runner) when no prompt is given", async () => {
    const { deps, calls } = fakeDeps();
    await assert.rejects(() => executePlanRun({ cwd: tempDir }, deps), /Provide a prompt describing what to plan/);
    assert.equal(calls.length, 0);
  });
});
