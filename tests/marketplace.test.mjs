// Install-readiness lint. Verifies the marketplace + plugin manifests are
// structurally valid and mutually consistent so that
//   /plugin marketplace add <source>
//   /plugin install copilot@claude-copilot
// resolve correctly. Pairs with `npm run version:check` (which guards version
// *sync* across manifests); this guards manifest *shape* + the documented
// install id + the slash-command payload. Fully offline — no network.

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), "utf8"));

describe("marketplace manifest (install-readiness)", () => {
  let marketplace, plugin, pkg, pluginEntry, pluginDir;

  before(() => {
    marketplace = readJson(".claude-plugin/marketplace.json");
    pkg = readJson("package.json");
    pluginEntry = marketplace.plugins?.[0];
    const src = (pluginEntry?.source ?? "").replace(/^\.\//, "");
    pluginDir = path.join(REPO_ROOT, src);
    plugin = readJson(path.join(src, ".claude-plugin", "plugin.json"));
  });

  it("declares the documented marketplace + plugin ids (`copilot@claude-copilot`)", () => {
    // Guards the install command published in README "Install" and CLAUDE.md.
    assert.equal(marketplace.name, "claude-copilot");
    assert.ok(
      Array.isArray(marketplace.plugins) && marketplace.plugins.length >= 1,
      "marketplace must declare at least one plugin"
    );
    assert.equal(pluginEntry.name, "copilot");
  });

  it("plugin source is a relative ./ path that resolves to a matching plugin.json", () => {
    assert.ok(
      typeof pluginEntry.source === "string" && pluginEntry.source.startsWith("./"),
      "plugin source should be a relative ./ path"
    );
    assert.ok(
      fs.existsSync(path.join(pluginDir, ".claude-plugin", "plugin.json")),
      "plugin.json must exist at the declared source"
    );
    assert.equal(plugin.name, pluginEntry.name, "plugin.json name must match the marketplace entry");
  });

  it("version is consistent across every manifest that declares one", () => {
    const versions = { "package.json": pkg.version, "plugin.json": plugin.version };
    if (marketplace.metadata?.version !== undefined) {
      versions["marketplace.metadata"] = marketplace.metadata.version;
    }
    if (pluginEntry.version !== undefined) {
      versions["marketplace.plugin"] = pluginEntry.version;
    }
    const unique = [...new Set(Object.values(versions))];
    assert.equal(unique.length, 1, `versions diverge: ${JSON.stringify(versions)}`);
    assert.match(unique[0], /^\d+\.\d+\.\d+/, "version should be semver");
  });

  it("ships the slash-command payload that install exposes", () => {
    const commandsDir = path.join(pluginDir, "commands");
    assert.ok(fs.existsSync(commandsDir), "commands/ directory must exist");
    const commands = fs.readdirSync(commandsDir).filter((f) => f.endsWith(".md"));
    assert.ok(commands.length >= 1, "expected at least one slash-command markdown file");
    // setup is the documented post-install entry point (/copilot:setup).
    assert.ok(commands.includes("setup.md"), "setup.md must be present");
  });
});
