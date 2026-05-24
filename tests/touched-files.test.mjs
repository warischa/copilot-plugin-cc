// Unit tests for the touched-files capture + summary
// (DESIGN.md §5 item 6).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { extractTouchedFilePath } = await import(
  "../plugins/copilot/scripts/lib/copilot.mjs"
);
const { renderTouchedFilesSummary, renderTaskResult } = await import(
  "../plugins/copilot/scripts/lib/render.mjs"
);

describe("extractTouchedFilePath", () => {
  it("returns the path for a well-formed file.change event", () => {
    assert.equal(
      extractTouchedFilePath({ type: "file.change", data: { path: "src/foo.ts" } }),
      "src/foo.ts"
    );
  });

  it("trims whitespace", () => {
    assert.equal(
      extractTouchedFilePath({ type: "file.change", data: { path: "  src/bar.ts  " } }),
      "src/bar.ts"
    );
  });

  it("returns null for unrelated events", () => {
    assert.equal(extractTouchedFilePath({ type: "assistant.message" }), null);
    assert.equal(extractTouchedFilePath({ type: "tool.call_end" }), null);
    assert.equal(extractTouchedFilePath({ type: "result" }), null);
  });

  it("returns null when the path is missing or empty", () => {
    assert.equal(extractTouchedFilePath({ type: "file.change" }), null);
    assert.equal(extractTouchedFilePath({ type: "file.change", data: {} }), null);
    assert.equal(
      extractTouchedFilePath({ type: "file.change", data: { path: "  " } }),
      null
    );
    assert.equal(
      extractTouchedFilePath({ type: "file.change", data: { path: null } }),
      null
    );
  });

  it("safely handles null / undefined events", () => {
    assert.equal(extractTouchedFilePath(null), null);
    assert.equal(extractTouchedFilePath(undefined), null);
  });
});

describe("renderTouchedFilesSummary", () => {
  it("returns null when nothing was touched", () => {
    assert.equal(renderTouchedFilesSummary([]), null);
    assert.equal(renderTouchedFilesSummary(undefined), null);
    assert.equal(renderTouchedFilesSummary(null), null);
  });

  it("singular vs plural", () => {
    assert.equal(renderTouchedFilesSummary(["a.ts"]), "Touched 1 file: a.ts");
    assert.equal(
      renderTouchedFilesSummary(["a.ts", "b.ts"]),
      "Touched 2 files: a.ts, b.ts"
    );
  });

  it("inlines many short paths when they fit the char budget", () => {
    const files = ["a", "b", "c", "d", "e", "f", "g"];
    const summary = renderTouchedFilesSummary(files);
    // Seven single-char names are well under the 160-char budget, so all
    // should render inline with no overflow suffix.
    assert.equal(summary, "Touched 7 files: a, b, c, d, e, f, g");
  });

  it("truncates when long paths overflow the char budget", () => {
    const files = [
      "src/some/long/feature/Module.tsx",
      "src/some/long/feature/Module.test.tsx",
      "src/some/long/feature/sub/component/HeavyComponent.tsx",
      "src/some/long/feature/sub/component/HeavyComponent.test.tsx",
      "src/some/long/feature/sub/component/Styles.module.css",
      "src/some/long/feature/sub/component/index.ts"
    ];
    const summary = renderTouchedFilesSummary(files);
    assert.match(summary, /^Touched 6 files: /);
    assert.match(summary, /\.\.\.and \d+ more$/);
    // Header line should stay close to the budget — not balloon to >300 chars.
    assert.ok(summary.length < 240, `summary too long: ${summary.length} chars`);
  });

  it("always shows at least one entry even if it exceeds the budget", () => {
    const pathologicallyLong = "x".repeat(500);
    const summary = renderTouchedFilesSummary([pathologicallyLong, "b"]);
    assert.match(summary, /Touched 2 files: x{500}, \.\.\.and 1 more/);
  });

  it("respects the hard ceiling on inline entries", () => {
    // 20 single-letter files all fit the char budget, but the hard cap is 12.
    const files = Array.from({ length: 20 }, (_, i) => `f${i}`);
    const summary = renderTouchedFilesSummary(files);
    assert.match(summary, /^Touched 20 files: f0, f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, f11, \.\.\.and 8 more$/);
  });
});

describe("renderTaskResult with touched files", () => {
  it("prepends the summary above the raw output", () => {
    const rendered = renderTaskResult({
      rawOutput: "Done — added two helpers.",
      touchedFiles: ["src/foo.ts", "src/bar.ts"]
    });
    assert.match(rendered, /^Touched 2 files: src\/foo\.ts, src\/bar\.ts\n\n/);
    assert.match(rendered, /Done — added two helpers\./);
  });

  it("does not add a header when nothing was touched", () => {
    const rendered = renderTaskResult({
      rawOutput: "hello",
      touchedFiles: []
    });
    assert.equal(rendered, "hello\n");
  });

  it("still works when touchedFiles is omitted (backward compat)", () => {
    const rendered = renderTaskResult({ rawOutput: "hi" });
    assert.equal(rendered, "hi\n");
  });

  it("prepends the summary even when the model returned no text", () => {
    const rendered = renderTaskResult({
      rawOutput: "",
      failureMessage: "",
      touchedFiles: ["only-touched-thing.ts"]
    });
    assert.match(rendered, /^Touched 1 file: only-touched-thing\.ts\n\n/);
    assert.match(rendered, /did not return a final message/);
  });
});
