import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  interpolateTemplate,
} from "../plugins/copilot/scripts/lib/prompts.mjs";

describe("interpolateTemplate", () => {
  it("substitutes a single {{VAR}} placeholder", () => {
    assert.equal(interpolateTemplate("Hello, {{NAME}}!", { NAME: "world" }), "Hello, world!");
  });

  it("substitutes multiple distinct placeholders", () => {
    const result = interpolateTemplate("{{GREETING}}, {{NAME}}!", {
      GREETING: "Hi",
      NAME: "Alice",
    });
    assert.equal(result, "Hi, Alice!");
  });

  it("substitutes the same placeholder appearing multiple times", () => {
    const result = interpolateTemplate("{{X}} and {{X}}", { X: "foo" });
    assert.equal(result, "foo and foo");
  });

  it("replaces a missing variable with an empty string", () => {
    // The code returns "" when the key is not present in the variables object.
    const result = interpolateTemplate("before {{MISSING}} after", {});
    assert.equal(result, "before  after");
  });

  it("ignores lowercase-only placeholders (regex requires A-Z and _)", () => {
    const result = interpolateTemplate("{{lower}}", { lower: "should not match" });
    assert.equal(result, "{{lower}}");
  });

  it("substitutes placeholders containing underscores", () => {
    const result = interpolateTemplate("{{FIRST_NAME}}", { FIRST_NAME: "Bob" });
    assert.equal(result, "Bob");
  });

  it("returns the template unchanged when there are no placeholders", () => {
    const tmpl = "no placeholders here";
    assert.equal(interpolateTemplate(tmpl, { FOO: "bar" }), tmpl);
  });

  it("handles an empty template string", () => {
    assert.equal(interpolateTemplate("", { FOO: "bar" }), "");
  });
});
