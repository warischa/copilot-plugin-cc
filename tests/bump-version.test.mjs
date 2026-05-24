// Tests for scripts/bump-version.mjs.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "bump-version.mjs");

let workRoot;

before(() => {
  workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-bump-version-"));
});

after(() => {
  fs.rmSync(workRoot, { recursive: true, force: true });
});

function writeJson(filePath, json) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(json, null, 2)}\n`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function freshFixture(version = "1.0.2") {
  const root = fs.mkdtempSync(path.join(workRoot, "fx-"));
  writeJson(path.join(root, "package.json"), {
    name: "@claude-copilot/copilot-plugin-cc",
    version
  });
  writeJson(path.join(root, "plugins", "copilot", ".claude-plugin", "plugin.json"), {
    name: "copilot",
    version
  });
  writeJson(path.join(root, ".claude-plugin", "marketplace.json"), {
    name: "claude-copilot",
    metadata: { version },
    plugins: [
      {
        name: "copilot",
        version,
        source: "./plugins/copilot"
      }
    ]
  });
  return root;
}

function runScript(args, opts = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: opts.cwd ?? REPO_ROOT,
    encoding: "utf8"
  });
}

describe("bump-version", () => {
  it("updates every release manifest", () => {
    const root = freshFixture("1.0.2");

    const result = runScript(["--root", root, "1.2.3"]);
    assert.equal(result.status, 0, result.stderr);

    assert.equal(readJson(path.join(root, "package.json")).version, "1.2.3");
    assert.equal(
      readJson(path.join(root, "plugins/copilot/.claude-plugin/plugin.json")).version,
      "1.2.3"
    );
    const market = readJson(path.join(root, ".claude-plugin/marketplace.json"));
    assert.equal(market.metadata.version, "1.2.3");
    assert.equal(market.plugins[0].version, "1.2.3");
  });

  it("--check passes when everything matches package.json", () => {
    const root = freshFixture("1.0.2");
    const result = runScript(["--root", root, "--check"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /All version metadata matches 1\.0\.2/);
  });

  it("--check fails with a useful diff when manifests are out of sync", () => {
    const root = freshFixture("1.0.2");
    // Bump only package.json, leaving the other manifests at 1.0.2
    writeJson(path.join(root, "package.json"), {
      name: "@claude-copilot/copilot-plugin-cc",
      version: "1.0.3"
    });
    const result = runScript(["--root", root, "--check"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /plugins\/copilot\/\.claude-plugin\/plugin\.json/);
    assert.match(result.stderr, /\.claude-plugin\/marketplace\.json metadata\.version/);
    assert.match(result.stderr, /plugins\[copilot\]\.version/);
  });

  it("rejects non-semver input", () => {
    const root = freshFixture("1.0.2");
    const result = runScript(["--root", root, "not-a-version"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /semver-like/);
  });

  it("accepts pre-release and build-metadata semver", () => {
    const root = freshFixture("1.0.2");
    const result = runScript(["--root", root, "2.0.0-rc.1+build.5"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      readJson(path.join(root, "package.json")).version,
      "2.0.0-rc.1+build.5"
    );
  });

  it("--help prints usage without erroring", () => {
    const result = runScript(["--help"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage:/);
    assert.match(result.stdout, /--check/);
  });
});
