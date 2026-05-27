// Unit tests for the Copilot JSONL event-stream parsers in lib/copilot.mjs.
//
// These pin the exact shape the plugin expects from Copilot's `--output-format
// json` event stream. They are the drift-catch surface called out in
// SESSION-HANDOFF / CLAUDE.md: if a future Copilot CLI version renames an
// event type or moves the final-answer/session-id fields, these tests fail
// loudly instead of the plugin silently producing empty results.
//
//   - describeEvent(event)        -> progress line + phase, or null
//   - captureFinalAnswer(state,e) -> mutates run state (final answer / session
//                                    id / exit code) per the documented invariants
//
// Both are exported purely for testability; neither has runtime side effects
// beyond the optional state.onProgress callback.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  describeEvent,
  captureFinalAnswer
} from "../plugins/copilot/scripts/lib/copilot.mjs";

describe("describeEvent", () => {
  it("returns null for noise/session lifecycle events", () => {
    for (const type of [
      "session.mcp_server_status_changed",
      "session.mcp_servers_loaded",
      "session.skills_loaded",
      "session.tools_updated",
      "assistant.message_start",
      "assistant.message_delta"
    ]) {
      assert.equal(describeEvent({ type }), null, `expected null for ${type}`);
    }
  });

  it("returns null for an unknown event type (forward-compatible)", () => {
    assert.equal(describeEvent({ type: "some.future.event" }), null);
  });

  it("maps user.message to a 'starting' phase", () => {
    assert.deepEqual(describeEvent({ type: "user.message" }), {
      message: "Prompt delivered to Copilot.",
      phase: "starting"
    });
  });

  it("maps assistant.reasoning to 'investigating'", () => {
    assert.deepEqual(describeEvent({ type: "assistant.reasoning" }), {
      message: "Reasoning step recorded.",
      phase: "investigating"
    });
  });

  it("interpolates the turn id on turn start/end", () => {
    const start = describeEvent({ type: "assistant.turn_start", data: { turnId: 3 } });
    assert.equal(start.phase, "starting");
    assert.match(start.message, /Turn started \(3\)/);

    const end = describeEvent({ type: "assistant.turn_end", data: { turnId: 3 } });
    assert.equal(end.phase, "finalizing");
    assert.match(end.message, /Turn ended \(3\)/);
  });

  it("flags the final-answer assistant.message as 'finalizing' with a preview + tool count", () => {
    const out = describeEvent({
      type: "assistant.message",
      data: {
        phase: "final_answer",
        content: "All done.",
        toolRequests: [{}, {}]
      }
    });
    assert.equal(out.phase, "finalizing");
    assert.match(out.message, /\(2 tool requests\)/);
    assert.match(out.message, /All done\./);
  });

  it("treats a non-final assistant.message as 'investigating'", () => {
    const out = describeEvent({
      type: "assistant.message",
      data: { phase: "in_progress", content: "thinking", toolRequests: [] }
    });
    assert.equal(out.phase, "investigating");
    assert.match(out.message, /\(0 tool requests\)/);
  });

  it("uses the no-content message form when content is absent", () => {
    const out = describeEvent({ type: "assistant.message", data: { toolRequests: [{}] } });
    assert.equal(out.message, "Assistant message (1 tool requests).");
  });

  it("maps tool + command events to their phases", () => {
    assert.equal(
      describeEvent({ type: "tool.call_start", data: { name: "grep" } }).phase,
      "investigating"
    );
    assert.match(
      describeEvent({ type: "tool.call_start", data: { name: "grep" } }).message,
      /grep/
    );
    assert.equal(
      describeEvent({ type: "command.start", data: { command: "ls -la" } }).phase,
      "running"
    );
    const cmdEnd = describeEvent({ type: "command.end", data: { exitCode: 2 } });
    assert.equal(cmdEnd.phase, "running");
    assert.match(cmdEnd.message, /exit 2/);
  });

  it("maps file.change to the 'editing' phase with the path", () => {
    assert.deepEqual(
      describeEvent({ type: "file.change", data: { path: "src/a.js" } }),
      { message: "File changed: src/a.js", phase: "editing" }
    );
  });

  it("maps a successful result to 'finalizing' and a failed result to 'failed'", () => {
    const ok = describeEvent({ type: "result", exitCode: 0 });
    assert.equal(ok.phase, "finalizing");
    assert.match(ok.message, /completed/);

    const bad = describeEvent({ type: "result", exitCode: 1 });
    assert.equal(bad.phase, "failed");
    assert.match(bad.message, /failed/);
  });
});

describe("captureFinalAnswer", () => {
  function makeState() {
    const progressCalls = [];
    return {
      state: { onProgress: (evt) => progressCalls.push(evt) },
      progressCalls
    };
  }

  it("captures the final answer + turn id and emits a progress log", () => {
    const { state, progressCalls } = makeState();
    captureFinalAnswer(state, {
      type: "assistant.message",
      data: { phase: "final_answer", content: "The answer is 42.", turnId: 7 }
    });
    assert.equal(state.lastFinalAnswer, "The answer is 42.");
    assert.equal(state.turnId, 7);
    assert.equal(progressCalls.length, 1, "expected one progress event for the final answer");
  });

  it("does NOT overwrite when a final-answer message has empty content", () => {
    const { state } = makeState();
    state.lastFinalAnswer = "previous";
    captureFinalAnswer(state, {
      type: "assistant.message",
      data: { phase: "final_answer", content: "" }
    });
    assert.equal(state.lastFinalAnswer, "previous");
  });

  it("falls back to capturing a non-final assistant.message with string content", () => {
    const { state, progressCalls } = makeState();
    captureFinalAnswer(state, {
      type: "assistant.message",
      data: { phase: "in_progress", content: "interim text" }
    });
    assert.equal(state.lastFinalAnswer, "interim text");
    // The fallback path does not emit a progress log.
    assert.equal(progressCalls.length, 0);
  });

  it("captures session id and exit code from the result event", () => {
    const { state } = makeState();
    captureFinalAnswer(state, {
      type: "result",
      sessionId: "sess-abc-123",
      exitCode: 0
    });
    assert.equal(state.sessionId, "sess-abc-123");
    assert.equal(state.resultExitCode, 0);
  });

  it("ignores a result event with no sessionId without clobbering state", () => {
    const { state } = makeState();
    state.sessionId = "keep-me";
    captureFinalAnswer(state, { type: "result", exitCode: 3 });
    assert.equal(state.sessionId, "keep-me");
    assert.equal(state.resultExitCode, 3);
  });
});
