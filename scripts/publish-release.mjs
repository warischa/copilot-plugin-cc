#!/usr/bin/env node
// Chain the manual release flow from docs/RELEASE.md into a single command.
//
// Steps (each can be skipped with a flag):
//   1. Verify clean working tree on the expected branch.
//   2. Run scripts/bump-version.mjs <version>.
//   3. Run `npm test`.                                       (--skip-tests)
//   4. git add the three manifest files + git commit + tag.
//   5. git push origin <branch> --follow-tags.               (--skip-push)
//   6. gh release create v<version>.                         (--skip-gh-release)
//
// --dry-run prints every command without executing it.
//
// The script intentionally stages only the manifest files bump-version.mjs
// touches — it never runs `git add -A`. Anything else in the working tree
// must be committed (or stashed) before running this script, otherwise it
// refuses to start unless --allow-dirty is passed.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const MANIFEST_FILES = [
  "package.json",
  "plugins/copilot/.claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json"
];

const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function usage() {
  return [
    "Usage:",
    "  node scripts/publish-release.mjs <version> [options]",
    "",
    "Options:",
    "  --dry-run          Print every command without running it.",
    "  --skip-tests       Skip `npm test`.",
    "  --skip-push        Skip `git push`.",
    "  --skip-gh-release  Skip `gh release create`.",
    "  --allow-dirty      Don't refuse to run when the tree has unrelated changes.",
    "  --branch <name>    Branch the release must be on (default: main).",
    "  --remote <name>    Remote to push to (default: origin).",
    "  --root <dir>       Repository root (default: cwd).",
    "  --help             Print this help.",
    "",
    "Example:",
    "  node scripts/publish-release.mjs 0.3.0",
    "  npm run publish-release -- 0.3.0 --dry-run"
  ].join("\n");
}

export function parseArgs(argv) {
  const options = {
    version: null,
    dryRun: false,
    skipTests: false,
    skipPush: false,
    skipGhRelease: false,
    allowDirty: false,
    branch: "main",
    remote: "origin",
    root: process.cwd(),
    help: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--skip-tests":
        options.skipTests = true;
        break;
      case "--skip-push":
        options.skipPush = true;
        break;
      case "--skip-gh-release":
        options.skipGhRelease = true;
        break;
      case "--allow-dirty":
        options.allowDirty = true;
        break;
      case "--branch": {
        const value = argv[++i];
        if (!value) throw new Error("--branch requires a value.");
        options.branch = value;
        break;
      }
      case "--remote": {
        const value = argv[++i];
        if (!value) throw new Error("--remote requires a value.");
        options.remote = value;
        break;
      }
      case "--root": {
        const value = argv[++i];
        if (!value) throw new Error("--root requires a value.");
        options.root = value;
        break;
      }
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
        if (options.version) throw new Error(`Unexpected extra argument: ${arg}`);
        options.version = arg;
    }
  }

  options.root = path.resolve(options.root);
  return options;
}

function validateVersion(version) {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`Expected a semver-like version such as 1.0.3, got: ${version}`);
  }
}

function formatCommand(command, args) {
  return [command, ...args].map((part) => (part.includes(" ") ? `"${part}"` : part)).join(" ");
}

export function createRunner({ dryRun, log = console.log, exec = spawnSync } = {}) {
  const history = [];

  function run(command, args, opts = {}) {
    const display = formatCommand(command, args);
    history.push({ command, args, opts, dryRun });

    if (dryRun) {
      log(`[dry-run] ${display}`);
      return { status: 0, stdout: "", stderr: "" };
    }

    log(`$ ${display}`);
    const result = exec(command, args, {
      cwd: opts.cwd,
      encoding: "utf8",
      stdio: opts.captureOutput ? "pipe" : "inherit"
    });

    if (result.status !== 0) {
      const stderr = result.stderr ? `\n${result.stderr}` : "";
      throw new Error(`Command failed (${display}) with status ${result.status}.${stderr}`);
    }

    return result;
  }

  return { run, history };
}

function gitOutput(exec, args, cwd) {
  const result = exec("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr ?? ""}`);
  }
  return (result.stdout ?? "").trim();
}

export function preflightChecks({ root, branch, allowDirty, exec = spawnSync } = {}) {
  if (!fs.existsSync(path.join(root, ".git"))) {
    throw new Error(`Not a git repository: ${root}`);
  }

  const currentBranch = gitOutput(exec, ["rev-parse", "--abbrev-ref", "HEAD"], root);
  if (currentBranch !== branch) {
    throw new Error(
      `Expected branch "${branch}", currently on "${currentBranch}". ` +
        `Pass --branch ${currentBranch} to override.`
    );
  }

  if (!allowDirty) {
    const status = gitOutput(exec, ["status", "--porcelain"], root);
    if (status) {
      throw new Error(
        `Working tree is not clean:\n${status}\n` +
          "Commit or stash unrelated changes, or pass --allow-dirty."
      );
    }
  }

  return { currentBranch };
}

export function buildSteps(options) {
  const tag = `v${options.version}`;
  const releaseTitle = `Release ${options.version}`;

  const steps = [
    {
      label: "bump-version",
      command: process.execPath,
      args: [path.join(options.root, "scripts/bump-version.mjs"), options.version]
    }
  ];

  if (!options.skipTests) {
    steps.push({ label: "test", command: "npm", args: ["test"] });
  }

  steps.push({ label: "git add", command: "git", args: ["add", ...MANIFEST_FILES] });
  steps.push({ label: "git commit", command: "git", args: ["commit", "-m", releaseTitle] });
  steps.push({ label: "git tag", command: "git", args: ["tag", "-a", tag, "-m", releaseTitle] });

  if (!options.skipPush) {
    steps.push({
      label: "git push",
      command: "git",
      args: ["push", options.remote, options.branch, "--follow-tags"]
    });
  }

  if (!options.skipGhRelease) {
    steps.push({
      label: "gh release",
      command: "gh",
      args: ["release", "create", tag, "--title", releaseTitle, "--notes", releaseTitle]
    });
  }

  return steps;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.version) {
    throw new Error(`Missing version.\n\n${usage()}`);
  }
  validateVersion(options.version);

  preflightChecks({
    root: options.root,
    branch: options.branch,
    allowDirty: options.allowDirty
  });

  const { run } = createRunner({ dryRun: options.dryRun });
  const steps = buildSteps(options);

  for (const step of steps) {
    run(step.command, step.args, { cwd: options.root });
  }

  const summary = options.dryRun
    ? `[dry-run] Would publish ${options.version}.`
    : `Published ${options.version}.`;
  console.log(summary);
}

const isDirectInvocation = (() => {
  try {
    const entry = process.argv[1] && path.resolve(process.argv[1]);
    const self = new URL(import.meta.url).pathname;
    return entry === self;
  } catch {
    return false;
  }
})();

if (isDirectInvocation) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
