// Tests for the post-0.3.0 bug fixes (B1, B2, B3).
// B1 — getJobKindLabel must map every jobClass to a sensible label, never "rescue" by default.
// B2 — REVIEW_BASELINE_DENY_TOOLS no longer contains "edit" (Copilot has no such tool).
// B3 — extractVersionLine strips the "Run 'copilot update'…" advisory line.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  getJobKindLabel,
  parseAttachmentPaths,
  parseCommaSeparatedList,
  REVIEW_BASELINE_DENY_TOOLS
} from "../plugins/copilot/scripts/copilot-companion.mjs";
import {
  buildCopilotArgs,
  detectInstructionsFiles,
  extractVersionLine
} from "../plugins/copilot/scripts/lib/copilot.mjs";

let workRoot;

before(() => {
  workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-helpers-"));
});

after(() => {
  fs.rmSync(workRoot, { recursive: true, force: true });
});

function mkRepo(label) {
  const root = fs.mkdtempSync(path.join(workRoot, `${label}-`));
  return root;
}

function touch(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "");
}

describe("B1 getJobKindLabel", () => {
  it("returns the correct label for every known jobClass", () => {
    assert.equal(getJobKindLabel("task"), "task");
    assert.equal(getJobKindLabel("review"), "review");
    assert.equal(getJobKindLabel("adversarial-review"), "adversarial-review");
    assert.equal(getJobKindLabel("rescue"), "rescue");
  });

  it("does NOT label a plain task as rescue (regression test)", () => {
    assert.notEqual(getJobKindLabel("task"), "rescue");
  });

  it("falls back to the jobClass string when unknown", () => {
    assert.equal(getJobKindLabel("custom-kind"), "custom-kind");
  });

  it("defaults to 'task' when jobClass is missing", () => {
    assert.equal(getJobKindLabel(undefined), "task");
    assert.equal(getJobKindLabel(null), "task");
    assert.equal(getJobKindLabel(""), "task");
  });
});

describe("B2 REVIEW_BASELINE_DENY_TOOLS", () => {
  it("includes write and shell", () => {
    assert.ok(REVIEW_BASELINE_DENY_TOOLS.includes("write"));
    assert.ok(REVIEW_BASELINE_DENY_TOOLS.includes("shell"));
  });

  it("no longer includes 'edit' (Copilot CLI has no such tool)", () => {
    assert.ok(!REVIEW_BASELINE_DENY_TOOLS.includes("edit"));
  });

  it("is frozen", () => {
    assert.ok(Object.isFrozen(REVIEW_BASELINE_DENY_TOOLS));
  });
});

describe("B3 extractVersionLine", () => {
  it("returns the first non-empty line", () => {
    const input = "GitHub Copilot CLI 1.0.52.\nRun 'copilot update' to check for updates.";
    assert.equal(extractVersionLine(input), "GitHub Copilot CLI 1.0.52.");
  });

  it("trims surrounding whitespace and CR characters", () => {
    assert.equal(extractVersionLine("  v9.9.9  \r\nfollow-up\r\n"), "v9.9.9");
  });

  it("returns the same string when there's only one line", () => {
    assert.equal(extractVersionLine("v1.2.3"), "v1.2.3");
  });

  it("skips leading blank lines", () => {
    assert.equal(extractVersionLine("\n\nGitHub Copilot CLI 2.0.0\nnotice"), "GitHub Copilot CLI 2.0.0");
  });

  it("returns non-string input unchanged", () => {
    assert.equal(extractVersionLine(undefined), undefined);
    assert.equal(extractVersionLine(null), null);
  });
});

describe("D3 detectInstructionsFiles", () => {
  it("returns an empty list when nothing is present", () => {
    const repo = mkRepo("empty");
    const fakeHome = mkRepo("home");
    const found = detectInstructionsFiles(repo, { homedir: fakeHome });
    assert.deepEqual(found, []);
  });

  it("detects .github/copilot-instructions.md", () => {
    const repo = mkRepo("github-md");
    const fakeHome = mkRepo("home2");
    touch(path.join(repo, ".github", "copilot-instructions.md"));
    const found = detectInstructionsFiles(repo, { homedir: fakeHome });
    assert.equal(found.length, 1);
    assert.equal(found[0].scope, "repo");
    assert.ok(found[0].path.endsWith(path.join(".github", "copilot-instructions.md")));
  });

  it("detects AGENTS.md at the repo root", () => {
    const repo = mkRepo("agents");
    const fakeHome = mkRepo("home3");
    touch(path.join(repo, "AGENTS.md"));
    const found = detectInstructionsFiles(repo, { homedir: fakeHome });
    assert.equal(found.length, 1);
    assert.equal(found[0].scope, "repo");
  });

  it("detects modular .github/instructions/*.instructions.md files", () => {
    const repo = mkRepo("modular");
    const fakeHome = mkRepo("home4");
    touch(path.join(repo, ".github", "instructions", "frontend.instructions.md"));
    touch(path.join(repo, ".github", "instructions", "backend.instructions.md"));
    // A non-matching file in the same dir must be ignored.
    touch(path.join(repo, ".github", "instructions", "README.md"));
    const found = detectInstructionsFiles(repo, { homedir: fakeHome });
    const modular = found.filter((entry) => entry.scope === "repo-modular");
    assert.equal(modular.length, 2);
  });

  it("detects ~/.copilot/copilot-instructions.md as global scope", () => {
    const repo = mkRepo("with-global");
    const fakeHome = mkRepo("home5");
    touch(path.join(fakeHome, ".copilot", "copilot-instructions.md"));
    const found = detectInstructionsFiles(repo, { homedir: fakeHome });
    assert.equal(found.length, 1);
    assert.equal(found[0].scope, "global");
  });

  it("returns multiple entries when several variants coexist", () => {
    const repo = mkRepo("many");
    const fakeHome = mkRepo("home6");
    touch(path.join(repo, "AGENTS.md"));
    touch(path.join(repo, ".github", "copilot-instructions.md"));
    touch(path.join(fakeHome, ".copilot", "copilot-instructions.md"));
    const found = detectInstructionsFiles(repo, { homedir: fakeHome });
    assert.equal(found.length, 3);
    const scopes = found.map((entry) => entry.scope).sort();
    assert.deepEqual(scopes, ["global", "repo", "repo"]);
  });
});

describe("buildCopilotArgs (D5+D6+D8)", () => {
  it("baseline contains JSON output, no-color, no-auto-update, allow-all-tools, and 0.7.0 privacy defaults", () => {
    const args = buildCopilotArgs({ prompt: "hi" });
    assert.deepEqual(args, [
      "-p",
      "hi",
      "--output-format",
      "json",
      "--no-color",
      "--no-auto-update",
      "--allow-all-tools",
      "--no-remote",
      "--no-ask-user"
    ]);
  });

  it("D5: planMode pushes --plan", () => {
    const args = buildCopilotArgs({ prompt: "x", planMode: true });
    assert.ok(args.includes("--plan"));
    assert.ok(!args.includes("--autopilot"));
  });

  it("D5+D6: planMode takes precedence over autopilot (mutually exclusive)", () => {
    const args = buildCopilotArgs({
      prompt: "x",
      planMode: true,
      autopilot: true,
      maxAutopilotContinues: 9
    });
    assert.ok(args.includes("--plan"));
    assert.ok(!args.includes("--autopilot"));
    assert.ok(!args.includes("--max-autopilot-continues"));
  });

  it("D6: autopilot pushes --autopilot and forwards continues count", () => {
    const args = buildCopilotArgs({
      prompt: "x",
      autopilot: true,
      maxAutopilotContinues: 7
    });
    assert.ok(args.includes("--autopilot"));
    const idx = args.indexOf("--max-autopilot-continues");
    assert.ok(idx >= 0);
    assert.equal(args[idx + 1], "7");
  });

  it("D6: --max-autopilot-continues only appears when value is a positive number", () => {
    const args = buildCopilotArgs({
      prompt: "x",
      autopilot: true,
      maxAutopilotContinues: 0
    });
    assert.ok(args.includes("--autopilot"));
    assert.ok(!args.includes("--max-autopilot-continues"));
  });

  it("D8: noCustomInstructions pushes --no-custom-instructions", () => {
    const args = buildCopilotArgs({
      prompt: "x",
      noCustomInstructions: true
    });
    assert.ok(args.includes("--no-custom-instructions"));
  });

  it("D8: omits --no-custom-instructions by default", () => {
    const args = buildCopilotArgs({ prompt: "x" });
    assert.ok(!args.includes("--no-custom-instructions"));
  });
});

describe("buildCopilotArgs (D7 share flags / 0.6.0)", () => {
  it("D7: shareMarkdown alone pushes a bare --share", () => {
    const args = buildCopilotArgs({ prompt: "x", shareMarkdown: true });
    assert.ok(args.includes("--share"));
    // No --share=path / no --share-gist when only --share was requested.
    assert.ok(!args.some((arg) => arg.startsWith("--share=")));
    assert.ok(!args.includes("--share-gist"));
  });

  it("D7: shareMarkdownPath pushes --share=<path> and suppresses bare --share", () => {
    const args = buildCopilotArgs({
      prompt: "x",
      shareMarkdown: true,
      shareMarkdownPath: "/tmp/out.md"
    });
    assert.ok(args.includes("--share=/tmp/out.md"));
    // The bare --share token would double-emit, so it must be absent.
    assert.ok(!args.includes("--share"));
  });

  it("D7: shareMarkdownPath alone is enough — implies share", () => {
    const args = buildCopilotArgs({ prompt: "x", shareMarkdownPath: "out.md" });
    assert.ok(args.includes("--share=out.md"));
    assert.ok(!args.includes("--share"));
  });

  it("D7: shareGist pushes --share-gist independently of --share", () => {
    const args = buildCopilotArgs({ prompt: "x", shareGist: true });
    assert.ok(args.includes("--share-gist"));
    assert.ok(!args.includes("--share"));
  });

  it("D7: empty / whitespace shareMarkdownPath is ignored", () => {
    const args = buildCopilotArgs({ prompt: "x", shareMarkdownPath: "   " });
    assert.ok(!args.some((arg) => arg.startsWith("--share")));
  });

  it("D7: defaults emit no share flags", () => {
    const args = buildCopilotArgs({ prompt: "x" });
    assert.ok(!args.some((arg) => arg.startsWith("--share")));
  });
});

describe("buildCopilotArgs (D9 MCP flags / 0.6.0)", () => {
  it("D9: addGithubMcpTools emits one --add-github-mcp-tool per entry", () => {
    const args = buildCopilotArgs({
      prompt: "x",
      addGithubMcpTools: ["issues", "pull_requests"]
    });
    const flagIndexes = args
      .map((arg, idx) => (arg === "--add-github-mcp-tool" ? idx : -1))
      .filter((idx) => idx !== -1);
    assert.equal(flagIndexes.length, 2);
    assert.equal(args[flagIndexes[0] + 1], "issues");
    assert.equal(args[flagIndexes[1] + 1], "pull_requests");
  });

  it("D9: additionalMcpConfigs emits one --additional-mcp-config per entry", () => {
    const args = buildCopilotArgs({
      prompt: "x",
      additionalMcpConfigs: ["@./mcp.json", '{"servers":{}}']
    });
    const flagIndexes = args
      .map((arg, idx) => (arg === "--additional-mcp-config" ? idx : -1))
      .filter((idx) => idx !== -1);
    assert.equal(flagIndexes.length, 2);
    assert.equal(args[flagIndexes[0] + 1], "@./mcp.json");
    assert.equal(args[flagIndexes[1] + 1], '{"servers":{}}');
  });

  it("D9: empty / blank entries in MCP lists are skipped", () => {
    const args = buildCopilotArgs({
      prompt: "x",
      addGithubMcpTools: ["issues", "", "   "],
      additionalMcpConfigs: ["@a.json", null, undefined]
    });
    assert.equal(args.filter((arg) => arg === "--add-github-mcp-tool").length, 1);
    assert.equal(args.filter((arg) => arg === "--additional-mcp-config").length, 1);
  });

  it("D9: defaults emit no MCP flags", () => {
    const args = buildCopilotArgs({ prompt: "x" });
    assert.ok(!args.includes("--add-github-mcp-tool"));
    assert.ok(!args.includes("--additional-mcp-config"));
  });
});

describe("parseCommaSeparatedList (D9 helper)", () => {
  it("returns an empty array for null/empty input", () => {
    assert.deepEqual(parseCommaSeparatedList(undefined), []);
    assert.deepEqual(parseCommaSeparatedList(null), []);
    assert.deepEqual(parseCommaSeparatedList(""), []);
  });

  it("splits on commas and trims whitespace", () => {
    assert.deepEqual(parseCommaSeparatedList("issues, pull_requests , workflows"), [
      "issues",
      "pull_requests",
      "workflows"
    ]);
  });

  it("dedupes preserving first-seen order", () => {
    assert.deepEqual(parseCommaSeparatedList("a,b,a,c,b"), ["a", "b", "c"]);
  });

  it("drops empty entries from doubled commas or trailing commas", () => {
    assert.deepEqual(parseCommaSeparatedList("a,,b,"), ["a", "b"]);
  });

  it("flattens arrays via join (for last-write-wins inputs upstream)", () => {
    assert.deepEqual(parseCommaSeparatedList(["a,b", "c"]), ["a", "b", "c"]);
  });
});

describe("buildCopilotArgs (A privacy defaults / 0.7.0)", () => {
  it("emits --no-remote and --no-ask-user by default", () => {
    const args = buildCopilotArgs({ prompt: "x" });
    assert.ok(args.includes("--no-remote"));
    assert.ok(args.includes("--no-ask-user"));
  });

  it("allowRemote suppresses --no-remote but keeps --no-ask-user", () => {
    const args = buildCopilotArgs({ prompt: "x", allowRemote: true });
    assert.ok(!args.includes("--no-remote"));
    assert.ok(args.includes("--no-ask-user"));
  });

  it("allowAskUser suppresses --no-ask-user but keeps --no-remote", () => {
    const args = buildCopilotArgs({ prompt: "x", allowAskUser: true });
    assert.ok(args.includes("--no-remote"));
    assert.ok(!args.includes("--no-ask-user"));
  });

  it("both escape hatches together suppress both --no-* flags", () => {
    const args = buildCopilotArgs({
      prompt: "x",
      allowRemote: true,
      allowAskUser: true
    });
    assert.ok(!args.includes("--no-remote"));
    assert.ok(!args.includes("--no-ask-user"));
  });
});

describe("buildCopilotArgs (B allow/deny tool/url / 0.7.0)", () => {
  it("allowTools emits one --allow-tool=<pat> per entry", () => {
    const args = buildCopilotArgs({
      prompt: "x",
      allowTools: ["shell(git:*)", "write"]
    });
    assert.ok(args.includes("--allow-tool=shell(git:*)"));
    assert.ok(args.includes("--allow-tool=write"));
  });

  it("allowUrls emits one --allow-url=<pat> per entry", () => {
    const args = buildCopilotArgs({
      prompt: "x",
      allowUrls: ["github.com", "https://*.example.com"]
    });
    assert.ok(args.includes("--allow-url=github.com"));
    assert.ok(args.includes("--allow-url=https://*.example.com"));
  });

  it("denyUrls emits one --deny-url=<pat> per entry", () => {
    const args = buildCopilotArgs({
      prompt: "x",
      denyUrls: ["malicious.test"]
    });
    assert.ok(args.includes("--deny-url=malicious.test"));
  });

  it("blank or whitespace-only entries are skipped for all three lists", () => {
    const args = buildCopilotArgs({
      prompt: "x",
      allowTools: ["write", "", "   "],
      allowUrls: ["a.com", null, undefined],
      denyUrls: ["", "b.com"]
    });
    assert.equal(args.filter((a) => a.startsWith("--allow-tool=")).length, 1);
    assert.equal(args.filter((a) => a.startsWith("--allow-url=")).length, 1);
    assert.equal(args.filter((a) => a.startsWith("--deny-url=")).length, 1);
  });

  it("defaults emit no allow/deny tool/url flags", () => {
    const args = buildCopilotArgs({ prompt: "x" });
    assert.ok(!args.some((a) => a.startsWith("--allow-tool=")));
    assert.ok(!args.some((a) => a.startsWith("--allow-url=")));
    assert.ok(!args.some((a) => a.startsWith("--deny-url=")));
  });
});

describe("buildCopilotArgs (C attachments / 0.7.0)", () => {
  it("attachments emits one --attachment <path> per entry", () => {
    const args = buildCopilotArgs({
      prompt: "x",
      attachments: ["/tmp/a.png", "/tmp/b.log"]
    });
    const flagIndexes = args
      .map((arg, idx) => (arg === "--attachment" ? idx : -1))
      .filter((idx) => idx !== -1);
    assert.equal(flagIndexes.length, 2);
    assert.equal(args[flagIndexes[0] + 1], "/tmp/a.png");
    assert.equal(args[flagIndexes[1] + 1], "/tmp/b.log");
  });

  it("blank entries are skipped", () => {
    const args = buildCopilotArgs({
      prompt: "x",
      attachments: ["/tmp/a.png", "", "   ", null]
    });
    assert.equal(args.filter((a) => a === "--attachment").length, 1);
  });

  it("default emits no --attachment", () => {
    const args = buildCopilotArgs({ prompt: "x" });
    assert.ok(!args.includes("--attachment"));
  });
});

describe("parseAttachmentPaths (C helper / 0.7.0)", () => {
  let repoRoot;
  let fileA;
  let fileB;
  let subdir;

  before(() => {
    repoRoot = mkRepo("attachments");
    fileA = path.join(repoRoot, "a.png");
    fileB = path.join(repoRoot, "b.log");
    subdir = path.join(repoRoot, "sub");
    touch(fileA);
    touch(fileB);
    fs.mkdirSync(subdir, { recursive: true });
  });

  it("returns [] for null/empty input", () => {
    assert.deepEqual(parseAttachmentPaths(undefined, repoRoot), []);
    assert.deepEqual(parseAttachmentPaths("", repoRoot), []);
  });

  it("resolves comma-separated paths against cwd and returns absolute paths", () => {
    const result = parseAttachmentPaths("a.png,b.log", repoRoot);
    assert.deepEqual(result, [fileA, fileB]);
  });

  it("accepts absolute paths verbatim", () => {
    const result = parseAttachmentPaths(fileA, repoRoot);
    assert.deepEqual(result, [fileA]);
  });

  it("throws when a path does not exist", () => {
    assert.throws(
      () => parseAttachmentPaths("missing.png", repoRoot),
      /--attachment path not found: missing\.png/
    );
  });

  it("throws when a path is a directory", () => {
    assert.throws(
      () => parseAttachmentPaths("sub", repoRoot),
      /--attachment must be a file, got a directory: sub/
    );
  });
});
