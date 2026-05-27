// Regression tests for isEntryPoint — the companion's "am I being run directly
// vs imported?" guard. A Windows bug (new URL(import.meta.url).pathname yields
// /C:/... which never equals path.resolve(argv1) === C:\...) meant main() never
// ran when the CLI was spawned on Windows. These pin the cross-platform contract.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { isEntryPoint } from "../plugins/copilot/scripts/copilot-companion.mjs";

describe("isEntryPoint", () => {
  it("returns false when argv[1] is missing", () => {
    assert.equal(isEntryPoint(undefined, "file:///whatever.mjs"), false);
    assert.equal(isEntryPoint(null, "file:///whatever.mjs"), false);
    assert.equal(isEntryPoint("", "file:///whatever.mjs"), false);
  });

  it("returns true when argv[1] resolves to the module's own file", () => {
    // pathToFileURL + fileURLToPath must round-trip to agree with path.resolve
    // on every OS. If the implementation regresses to new URL(...).pathname this
    // assertion fails on Windows (/C:/... vs C:\...).
    const p = path.resolve(path.join("some", "dir", "copilot-companion.mjs"));
    const url = pathToFileURL(p).href;
    assert.equal(isEntryPoint(p, url), true);
  });

  it("returns false when argv[1] points at a different file", () => {
    const url = pathToFileURL(path.resolve("a", "companion.mjs")).href;
    const other = path.resolve("b", "companion.mjs");
    assert.equal(isEntryPoint(other, url), false);
  });

  it("does not throw on a malformed module URL", () => {
    assert.equal(isEntryPoint("/some/path", "not-a-valid-url"), false);
  });
});
