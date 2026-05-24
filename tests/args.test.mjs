import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseArgs, splitRawArgumentString } from "../plugins/copilot/scripts/lib/args.mjs";

describe("parseArgs", () => {
  it("collects boolean flags", () => {
    const { options, positionals } = parseArgs(["--wait", "--background"], {
      booleanOptions: ["wait", "background"]
    });
    assert.deepEqual(options, { wait: true, background: true });
    assert.deepEqual(positionals, []);
  });

  it("collects value options with space or equals", () => {
    const { options } = parseArgs(["--model", "gpt-5.4", "--effort=high"], {
      valueOptions: ["model", "effort"]
    });
    assert.equal(options.model, "gpt-5.4");
    assert.equal(options.effort, "high");
  });

  it("applies alias map", () => {
    const { options } = parseArgs(["-m", "fast"], {
      valueOptions: ["model"],
      aliasMap: { m: "model" }
    });
    assert.equal(options.model, "fast");
  });

  it("treats unknown long options as positionals", () => {
    const { positionals } = parseArgs(["--unknown", "hello"], {
      booleanOptions: ["wait"]
    });
    assert.deepEqual(positionals, ["--unknown", "hello"]);
  });

  it("passes through after --", () => {
    const { positionals } = parseArgs(["--", "--wait", "extra"], {
      booleanOptions: ["wait"]
    });
    assert.deepEqual(positionals, ["--wait", "extra"]);
  });

  it("throws when a required value is missing", () => {
    assert.throws(() => parseArgs(["--model"], { valueOptions: ["model"] }), /Missing value/);
  });
});

describe("splitRawArgumentString", () => {
  it("splits unquoted tokens", () => {
    assert.deepEqual(splitRawArgumentString("--wait one two"), ["--wait", "one", "two"]);
  });

  it("respects double quotes", () => {
    assert.deepEqual(splitRawArgumentString('fix "the bug" now'), ["fix", "the bug", "now"]);
  });

  it("respects single quotes", () => {
    assert.deepEqual(splitRawArgumentString("say 'hello world'"), ["say", "hello world"]);
  });

  it("handles escapes", () => {
    assert.deepEqual(splitRawArgumentString("foo\\ bar baz"), ["foo bar", "baz"]);
  });
});
