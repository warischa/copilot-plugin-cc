// Unit tests for the user-scoped plugin config loader (DESIGN.md §5 item 5).

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tempDir;
const ORIGINAL_OVERRIDE = process.env.COPILOT_PLUGIN_CONFIG_PATH;

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-plugin-config-"));
});

after(() => {
  if (ORIGINAL_OVERRIDE === undefined) {
    delete process.env.COPILOT_PLUGIN_CONFIG_PATH;
  } else {
    process.env.COPILOT_PLUGIN_CONFIG_PATH = ORIGINAL_OVERRIDE;
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const {
  loadPluginConfig,
  applyPluginDefaults,
  resolvePluginConfigPath,
  reportPluginConfigWarnings
} = await import("../plugins/copilot/scripts/lib/plugin-config.mjs");

function writeConfig(name, payload) {
  const filePath = path.join(tempDir, name);
  fs.writeFileSync(filePath, payload, "utf8");
  return filePath;
}

describe("resolvePluginConfigPath", () => {
  it("uses COPILOT_PLUGIN_CONFIG_PATH when set", () => {
    const resolved = resolvePluginConfigPath({
      env: { COPILOT_PLUGIN_CONFIG_PATH: "/tmp/x.json" }
    });
    assert.equal(resolved, path.resolve("/tmp/x.json"));
  });

  it("falls back to ~/.claude/plugins/copilot/config.json", () => {
    const resolved = resolvePluginConfigPath({
      env: {},
      homedir: "/home/test"
    });
    assert.equal(resolved, "/home/test/.claude/plugins/copilot/config.json");
  });
});

describe("loadPluginConfig", () => {
  it("returns just the path when the file doesn't exist", () => {
    const cfg = loadPluginConfig({ path: path.join(tempDir, "missing.json") });
    assert.equal(cfg.model, undefined);
    assert.equal(cfg.effort, undefined);
    assert.deepEqual(cfg._warnings, []);
  });

  it("reads valid model + effort", () => {
    const p = writeConfig("ok.json", JSON.stringify({ model: "gpt-5.4", effort: "high" }));
    const cfg = loadPluginConfig({ path: p });
    assert.equal(cfg.model, "gpt-5.4");
    assert.equal(cfg.effort, "high");
    assert.deepEqual(cfg._warnings, []);
  });

  it("normalizes effort casing", () => {
    const p = writeConfig("case.json", JSON.stringify({ effort: "  HIGH  " }));
    const cfg = loadPluginConfig({ path: p });
    assert.equal(cfg.effort, "high");
  });

  it("warns and ignores invalid effort", () => {
    const p = writeConfig("badEffort.json", JSON.stringify({ effort: "extreme" }));
    const cfg = loadPluginConfig({ path: p });
    assert.equal(cfg.effort, undefined);
    assert.equal(cfg._warnings.length, 1);
    assert.match(cfg._warnings[0], /effort/);
  });

  it("warns and ignores empty model", () => {
    const p = writeConfig("emptyModel.json", JSON.stringify({ model: "   " }));
    const cfg = loadPluginConfig({ path: p });
    assert.equal(cfg.model, undefined);
    assert.match(cfg._warnings[0], /model/);
  });

  it("warns and ignores malformed JSON", () => {
    const p = writeConfig("broken.json", "{not json");
    const cfg = loadPluginConfig({ path: p });
    assert.equal(cfg.model, undefined);
    assert.equal(cfg.effort, undefined);
    assert.match(cfg._warnings[0], /Could not read/);
  });

  it("warns and ignores when the file is a JSON array", () => {
    const p = writeConfig("array.json", "[]");
    const cfg = loadPluginConfig({ path: p });
    assert.equal(cfg.model, undefined);
    assert.match(cfg._warnings[0], /not a JSON object/);
  });

  it("ignores unknown keys without warning", () => {
    const p = writeConfig(
      "extra.json",
      JSON.stringify({ model: "gpt-5.4", verbosity: 9000, foo: "bar" })
    );
    const cfg = loadPluginConfig({ path: p });
    assert.equal(cfg.model, "gpt-5.4");
    assert.deepEqual(cfg._warnings, []);
  });
});

describe("applyPluginDefaults", () => {
  it("CLI options win over config defaults", () => {
    const out = applyPluginDefaults(
      { model: "gpt-cli", effort: "low" },
      { model: "gpt-config", effort: "high" }
    );
    assert.equal(out.model, "gpt-cli");
    assert.equal(out.effort, "low");
  });

  it("fills in defaults when CLI key is missing or null", () => {
    const out = applyPluginDefaults(
      { model: null },
      { model: "gpt-config", effort: "medium" }
    );
    assert.equal(out.model, "gpt-config");
    assert.equal(out.effort, "medium");
  });

  it("treats undefined CLI keys as missing", () => {
    const out = applyPluginDefaults({}, { model: "gpt-config" });
    assert.equal(out.model, "gpt-config");
  });

  it("does not mutate input", () => {
    const cli = { model: null };
    applyPluginDefaults(cli, { model: "gpt-config" });
    assert.equal(cli.model, null);
  });

  it("safely handles null/undefined pluginConfig", () => {
    const out = applyPluginDefaults({ model: "x" }, null);
    assert.equal(out.model, "x");
  });
});

describe("reportPluginConfigWarnings", () => {
  it("writes each warning prefixed with [copilot]", () => {
    const written = [];
    reportPluginConfigWarnings(
      { _warnings: ["one", "two"] },
      { write: (line) => written.push(line) }
    );
    assert.equal(written.length, 2);
    assert.match(written[0], /\[copilot\] one/);
    assert.match(written[1], /\[copilot\] two/);
  });

  it("no-ops when there are no warnings", () => {
    const written = [];
    reportPluginConfigWarnings({ _warnings: [] }, { write: (l) => written.push(l) });
    assert.equal(written.length, 0);
  });
});
