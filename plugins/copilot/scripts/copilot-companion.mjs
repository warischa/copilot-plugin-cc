#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
  buildPersistentTaskSessionName,
  DEFAULT_CONTINUE_PROMPT,
  detectInstructionsFiles,
  getCopilotAuthStatus,
  getCopilotAvailability,
  runCopilotPrompt
} from "./lib/copilot.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { terminateProcessTree, binaryAvailable } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  generateJobId,
  listJobs,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import { sweepDeadJobs } from "./lib/job-liveness.mjs";
import {
  applyPluginDefaults,
  loadPluginConfig,
  reportPluginConfigWarnings
} from "./lib/plugin-config.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  renderReviewResult,
  renderStoredJobResult,
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport,
  renderTaskResult
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
// Mirrors plugin-config.mjs VALID_EFFORTS. Kept in sync with the
// `copilot help` choices for `--effort, --reasoning-effort`.
const VALID_REASONING_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh", "max"]);

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/copilot-companion.mjs setup [--json]",
      "  node scripts/copilot-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model>] [--share[=<path>]|--share-path <path>] [--share-gist]",
      "  node scripts/copilot-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model>] [--no-custom-instructions] [--share[=<path>]|--share-path <path>] [--share-gist] [focus ...]",
      "  node scripts/copilot-companion.mjs task [--background] [--write] [--resume-last|--resume|--fresh] [--autopilot [--max-autopilot-continues <N>]] [--model <model>] [--effort <none|low|medium|high|xhigh|max>] [--share[=<path>]|--share-path <path>] [--share-gist] [--mcp-tool <names>] [--mcp-config <json|@file>] [prompt]",
      "  node scripts/copilot-companion.mjs plan [--background] [--model <model>] [--effort <none|low|medium|high|xhigh|max>] [--share[=<path>]|--share-path <path>] [--share-gist] [--mcp-tool <names>] [--mcp-config <json|@file>] [prompt]",
      "  node scripts/copilot-companion.mjs status [job-id] [--all] [--json]",
      "  node scripts/copilot-companion.mjs result [job-id] [--json]",
      "  node scripts/copilot-companion.mjs cancel [job-id] [--json]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

// D9 / 0.6.0 — split a CLI comma-list into a deduped string[]. Used by
// `--mcp-tool foo,bar` to drive multiple `--add-github-mcp-tool` flags.
// Returns an empty array for null / empty input so callers can just
// check `.length`. We deliberately do NOT split on whitespace or accept
// JSON-style arrays — comma is the documented form, and MCP config
// JSON itself contains commas (use --mcp-config for that).
export function parseCommaSeparatedList(value) {
  if (value == null || value === "") {
    return [];
  }
  if (Array.isArray(value)) {
    return parseCommaSeparatedList(value.join(","));
  }
  const seen = new Set();
  const out = [];
  for (const raw of String(value).split(",")) {
    const trimmed = raw.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

// Parse a CLI value expected to be a positive integer (e.g.
// --max-autopilot-continues). Returns null when the value was not
// supplied. Throws for anything that isn't a positive integer so the
// user gets a clear error instead of a silently-dropped flag.
export function parsePositiveInteger(value, flagName) {
  if (value == null || value === "") {
    return null;
  }
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    throw new Error(`--${flagName} must be a positive integer, got: ${value}`);
  }
  return num;
}

function normalizeReasoningEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    throw new Error(
      `Unsupported reasoning effort "${effort}". Copilot supports: none, low, medium, high, xhigh, max.`
    );
  }
  return normalized;
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

function buildSetupReport(cwd, actionsTaken = []) {
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const copilotStatus = getCopilotAvailability(cwd);
  const authStatus = getCopilotAuthStatus(cwd);
  const pluginConfig = loadPluginConfig();
  const instructions = detectInstructionsFiles(cwd);

  const nextSteps = [];
  if (!copilotStatus.available) {
    nextSteps.push("Install GitHub Copilot CLI with `npm install -g @github/copilot`.");
  }
  if (copilotStatus.available && !authStatus.loggedIn) {
    nextSteps.push("Run `!copilot login` to authenticate.");
    nextSteps.push("Or set one of: COPILOT_GITHUB_TOKEN, GH_TOKEN, GITHUB_TOKEN.");
  }

  return {
    ready: nodeStatus.available && copilotStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    copilot: copilotStatus,
    auth: authStatus,
    pluginConfig: {
      path: pluginConfig._path,
      model: pluginConfig.model ?? null,
      effort: pluginConfig.effort ?? null,
      warnings: pluginConfig._warnings ?? []
    },
    instructions,
    actionsTaken,
    nextSteps
  };
}

function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const report = buildSetupReport(cwd, []);
  outputResult(options.json ? report : renderSetupReport(report), options.json);
}

function ensureCopilotAvailable(cwd) {
  const availability = getCopilotAvailability(cwd);
  if (!availability.available) {
    throw new Error(
      "GitHub Copilot CLI is not installed. Install it with `npm install -g @github/copilot`, then rerun `/copilot:setup`."
    );
  }
}

function buildReviewPrompt(context) {
  const template = loadPromptTemplate(ROOT_DIR, "review");
  return interpolateTemplate(template, {
    TARGET_LABEL: context.target.label,
    REVIEW_INPUT: context.content
  });
}

function buildAdversarialReviewPrompt(context, userFocus) {
  const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
  const focus = String(userFocus ?? "").trim();
  return interpolateTemplate(template, {
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focus || "(no specific focus area was provided)",
    REVIEW_INPUT: context.content
  });
}

// Review and adversarial-review must remain non-mutating, so we always
// enforce a baseline deny list. Plugin-config `denyTools` is *added* on top
// (deduped, baseline wins on collisions) — it can extend the deny list but
// never replace the read-only contract.
//
// Valid Copilot CLI tool tokens (per `copilot help` + docs): `write`, and
// `shell(<pattern>)` forms like `shell(git push)`. The bare `shell` token
// denies all shell tools. We previously included `edit`, but Copilot has no
// such tool — file edits are gated by `write`, and `edit` was silently
// ignored. Removed in 0.3.1.
export const REVIEW_BASELINE_DENY_TOOLS = Object.freeze(["write", "shell"]);

function buildReviewDenyTools(extra) {
  if (!Array.isArray(extra) || extra.length === 0) {
    return [...REVIEW_BASELINE_DENY_TOOLS];
  }
  const merged = new Set(REVIEW_BASELINE_DENY_TOOLS);
  for (const tool of extra) {
    if (typeof tool === "string" && tool.trim()) {
      merged.add(tool.trim());
    }
  }
  return [...merged];
}

async function executeReviewRun(request) {
  ensureCopilotAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });

  const context = collectReviewContext(request.cwd, target);
  const prompt = buildReviewPrompt(context);

  const result = await runCopilotPrompt(context.repoRoot, {
    prompt,
    model: request.model,
    allowAllTools: true,
    denyTools: buildReviewDenyTools(request.denyTools),
    addDirs: Array.isArray(request.addDirs) ? request.addDirs : undefined,
    shareMarkdown: Boolean(request.shareMarkdown),
    shareMarkdownPath: request.shareMarkdownPath ?? null,
    shareGist: Boolean(request.shareGist),
    onProgress: request.onProgress
  });

  const payload = {
    review: "Review",
    target,
    threadId: result.threadId,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    copilot: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.finalMessage
    },
    rawOutput: result.finalMessage
  };

  const rendered = renderReviewResult(
    {
      status: result.status,
      stdout: result.finalMessage,
      stderr: result.stderr
    },
    { reviewLabel: "Review", targetLabel: target.label }
  );

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered,
    summary: firstMeaningfulLine(result.finalMessage, "Review completed."),
    jobTitle: "Copilot Review",
    jobClass: "review",
    targetLabel: target.label
  };
}

async function executeAdversarialReviewRun(request) {
  ensureCopilotAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });

  const context = collectReviewContext(request.cwd, target);
  const prompt = buildAdversarialReviewPrompt(context, request.userFocus);

  const result = await runCopilotPrompt(context.repoRoot, {
    prompt,
    model: request.model,
    allowAllTools: true,
    denyTools: buildReviewDenyTools(request.denyTools),
    addDirs: Array.isArray(request.addDirs) ? request.addDirs : undefined,
    noCustomInstructions: Boolean(request.noCustomInstructions),
    shareMarkdown: Boolean(request.shareMarkdown),
    shareMarkdownPath: request.shareMarkdownPath ?? null,
    shareGist: Boolean(request.shareGist),
    onProgress: request.onProgress
  });

  const payload = {
    review: "Adversarial Review",
    target,
    userFocus: request.userFocus || null,
    threadId: result.threadId,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    copilot: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.finalMessage
    },
    rawOutput: result.finalMessage
  };

  const rendered = renderReviewResult(
    {
      status: result.status,
      stdout: result.finalMessage,
      stderr: result.stderr
    },
    { reviewLabel: "Adversarial Review", targetLabel: target.label }
  );

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered,
    summary: firstMeaningfulLine(result.finalMessage, "Adversarial review completed."),
    jobTitle: "Copilot Adversarial Review",
    jobClass: "review",
    targetLabel: target.label
  };
}

async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureCopilotAvailable(request.cwd);

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast
  });

  let resumeSessionId = null;
  if (request.resumeLast) {
    const latestThread = resolveLatestTrackedTaskSession(workspaceRoot, {
      excludeJobId: request.jobId
    });
    if (!latestThread) {
      throw new Error("No previous Copilot task session was found for this repository.");
    }
    resumeSessionId = latestThread;
  }

  if (!request.prompt && !resumeSessionId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  const result = await runCopilotPrompt(workspaceRoot, {
    prompt: request.prompt || (resumeSessionId ? DEFAULT_CONTINUE_PROMPT : ""),
    resumeSessionId,
    sessionName: resumeSessionId ? null : buildPersistentTaskSessionName(request.prompt || DEFAULT_CONTINUE_PROMPT),
    model: request.model,
    effort: request.effort,
    allowAllTools: true,
    denyTools: Array.isArray(request.denyTools) ? request.denyTools : undefined,
    addDirs: Array.isArray(request.addDirs) ? request.addDirs : undefined,
    autopilot: Boolean(request.autopilot),
    maxAutopilotContinues: request.maxAutopilotContinues ?? null,
    shareMarkdown: Boolean(request.shareMarkdown),
    shareMarkdownPath: request.shareMarkdownPath ?? null,
    shareGist: Boolean(request.shareGist),
    addGithubMcpTools: Array.isArray(request.addGithubMcpTools) ? request.addGithubMcpTools : undefined,
    additionalMcpConfigs: Array.isArray(request.additionalMcpConfigs) ? request.additionalMcpConfigs : undefined,
    onProgress: request.onProgress
  });

  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const failureMessage = result.stderr ?? "";
  const touchedFiles = Array.isArray(result.touchedFiles) ? result.touchedFiles : [];
  const rendered = renderTaskResult({ rawOutput, failureMessage, touchedFiles });
  const payload = {
    status: result.status,
    threadId: result.threadId,
    rawOutput,
    touchedFiles
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write: Boolean(request.write)
  };
}

// When `redactSummary` is true, the stored job summary is blanked out
// instead of containing the first ~96 chars of the prompt. Useful for
// users who paste tokens, secrets, or PII into prompts and don't want
// them lingering in state/jobs/*.json.
const REDACTED_SUMMARY = "[summary redacted]";

function buildTaskRunMetadata({ prompt, resumeLast = false, redactSummary = false }) {
  const title = resumeLast ? "Copilot Resume" : "Copilot Task";
  if (redactSummary) {
    return { title, summary: REDACTED_SUMMARY };
  }
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

function renderQueuedTaskLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check /copilot:status ${payload.jobId} for progress.\n`;
}

export function getJobKindLabel(jobClass) {
  switch (jobClass) {
    case "review":
      return "review";
    case "adversarial-review":
      return "adversarial-review";
    case "task":
      return "task";
    case "plan":
      return "plan";
    case "rescue":
      return "rescue";
    default:
      return typeof jobClass === "string" && jobClass.length > 0 ? jobClass : "task";
  }
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

function buildTaskJob(workspaceRoot, taskMetadata, write) {
  return createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write
  });
}

function buildTaskRequest({
  cwd,
  model,
  effort,
  prompt,
  write,
  resumeLast,
  jobId,
  denyTools,
  addDirs,
  autopilot = false,
  maxAutopilotContinues = null,
  shareMarkdown = false,
  shareMarkdownPath = null,
  shareGist = false,
  addGithubMcpTools = null,
  additionalMcpConfigs = null
}) {
  return {
    cwd,
    model,
    effort,
    prompt,
    write,
    resumeLast,
    jobId,
    denyTools: Array.isArray(denyTools) ? [...denyTools] : undefined,
    addDirs: Array.isArray(addDirs) ? [...addDirs] : undefined,
    autopilot: Boolean(autopilot),
    maxAutopilotContinues:
      Number.isFinite(maxAutopilotContinues) && maxAutopilotContinues > 0
        ? maxAutopilotContinues
        : null,
    shareMarkdown: Boolean(shareMarkdown) || Boolean(shareMarkdownPath),
    shareMarkdownPath: shareMarkdownPath ?? null,
    shareGist: Boolean(shareGist),
    addGithubMcpTools:
      Array.isArray(addGithubMcpTools) && addGithubMcpTools.length > 0
        ? [...addGithubMcpTools]
        : undefined,
    additionalMcpConfigs:
      Array.isArray(additionalMcpConfigs) && additionalMcpConfigs.length > 0
        ? [...additionalMcpConfigs]
        : undefined
  };
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }
  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentClaudeSession(jobs) {
  const sessionId = getCurrentClaudeSessionId();
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        job.threadId &&
        job.status !== "queued" &&
        job.status !== "running"
    ) ?? null
  );
}

function resolveLatestTrackedTaskSession(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentClaudeSession(jobs);
  const activeTask = visibleJobs.find((job) => job.jobClass === "task" && (job.status === "queued" || job.status === "running"));
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /copilot:status before continuing it.`);
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs);
  if (trackedTask) {
    return trackedTask.threadId;
  }
  return null;
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedTaskWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "copilot-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

function enqueueBackgroundTask(cwd, job, request, options = {}) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  // Tag the stored request with the job class so the worker dispatches to
  // the right executor (executeTaskRun for "task", executePlanRun for
  // "plan"). Defaults to "task" for backward compatibility.
  const taggedRequest = {
    ...request,
    jobClass: options.jobClass ?? request?.jobClass ?? "task"
  };

  const child = spawnDetachedTaskWorker(cwd, job.id);
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: child.pid ?? null,
    logFile,
    request: taggedRequest
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile
    },
    logFile
  };
}

async function handleReview(argv) {
  const { options: rawOptions } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd", "share-path"],
    booleanOptions: ["json", "background", "wait", "share", "share-gist"],
    aliasMap: {
      m: "model"
    }
  });

  const pluginConfig = loadPluginConfig();
  reportPluginConfigWarnings(pluginConfig);
  const options = applyPluginDefaults(rawOptions, pluginConfig);

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  const job = createCompanionJob({
    prefix: "review",
    kind: "review",
    title: "Copilot Review",
    workspaceRoot,
    jobClass: "review",
    summary: `Review ${target.label}`
  });

  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        base: options.base,
        scope: options.scope,
        model: options.model,
        denyTools: Array.isArray(options.denyTools) ? options.denyTools : undefined,
        addDirs: Array.isArray(options.addDirs) ? options.addDirs : undefined,
        shareMarkdown: Boolean(options.share) || Boolean(options["share-path"]),
        shareMarkdownPath: options["share-path"] ?? null,
        shareGist: Boolean(options["share-gist"]),
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleAdversarialReview(argv) {
  const { options: rawOptions, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd", "share-path"],
    booleanOptions: [
      "json",
      "background",
      "wait",
      "no-custom-instructions",
      "share",
      "share-gist"
    ],
    aliasMap: {
      m: "model"
    }
  });

  const pluginConfig = loadPluginConfig();
  reportPluginConfigWarnings(pluginConfig);
  const options = applyPluginDefaults(rawOptions, pluginConfig);

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });
  const userFocus = positionals.join(" ").trim();

  const job = createCompanionJob({
    prefix: "adversarial-review",
    kind: "review",
    title: "Copilot Adversarial Review",
    workspaceRoot,
    jobClass: "review",
    summary: `Adversarial review ${target.label}${userFocus ? ` — focus: ${userFocus}` : ""}`
  });

  await runForegroundCommand(
    job,
    (progress) =>
      executeAdversarialReviewRun({
        cwd,
        base: options.base,
        scope: options.scope,
        model: options.model,
        userFocus,
        denyTools: Array.isArray(options.denyTools) ? options.denyTools : undefined,
        addDirs: Array.isArray(options.addDirs) ? options.addDirs : undefined,
        noCustomInstructions: Boolean(options["no-custom-instructions"]),
        shareMarkdown: Boolean(options.share) || Boolean(options["share-path"]),
        shareMarkdownPath: options["share-path"] ?? null,
        shareGist: Boolean(options["share-gist"]),
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleTask(argv) {
  const { options: rawOptions, positionals } = parseCommandInput(argv, {
    valueOptions: [
      "model",
      "effort",
      "cwd",
      "prompt-file",
      "max-autopilot-continues",
      "share-path",
      "mcp-tool",
      "mcp-config"
    ],
    booleanOptions: [
      "json",
      "write",
      "resume-last",
      "resume",
      "fresh",
      "background",
      "autopilot",
      "share",
      "share-gist"
    ],
    aliasMap: {
      m: "model"
    }
  });

  const pluginConfig = loadPluginConfig();
  reportPluginConfigWarnings(pluginConfig);
  const options = applyPluginDefaults(rawOptions, pluginConfig);

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = options.model ?? null;
  const effort = normalizeReasoningEffort(options.effort);
  const denyTools = Array.isArray(options.denyTools) ? options.denyTools : undefined;
  const addDirs = Array.isArray(options.addDirs) ? options.addDirs : undefined;
  const autopilot = Boolean(options.autopilot);
  const maxAutopilotContinues = parsePositiveInteger(
    options["max-autopilot-continues"],
    "max-autopilot-continues"
  );
  if (maxAutopilotContinues != null && !autopilot) {
    throw new Error("--max-autopilot-continues requires --autopilot.");
  }
  // D7 — share flags: --share (boolean, default Copilot path) or
  // --share-path <file> (explicit path implies --share). --share-gist
  // uploads the transcript to a secret gist.
  const shareMarkdownPath =
    typeof options["share-path"] === "string" && options["share-path"].trim()
      ? options["share-path"].trim()
      : null;
  const shareMarkdown = Boolean(options.share) || Boolean(shareMarkdownPath);
  const shareGist = Boolean(options["share-gist"]);
  // D9 — MCP flags. --mcp-tool accepts a comma-separated list; --mcp-config
  // is a single JSON string or `@filepath` (Copilot's documented form).
  const addGithubMcpTools = parseCommaSeparatedList(options["mcp-tool"]);
  const additionalMcpConfigs =
    typeof options["mcp-config"] === "string" && options["mcp-config"].trim()
      ? [options["mcp-config"].trim()]
      : [];
  const prompt = readTaskPrompt(cwd, options, positionals);

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  const write = Boolean(options.write);
  const redactSummary = options.redactSummary === true;
  const taskMetadata = buildTaskRunMetadata({ prompt, resumeLast, redactSummary });

  if (options.background) {
    ensureCopilotAvailable(cwd);
    if (!prompt && !resumeLast) {
      throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
    }

    const job = buildTaskJob(workspaceRoot, taskMetadata, write);
    const request = buildTaskRequest({
      cwd,
      model,
      effort,
      prompt,
      write,
      resumeLast,
      jobId: job.id,
      denyTools,
      addDirs,
      autopilot,
      maxAutopilotContinues,
      shareMarkdown,
      shareMarkdownPath,
      shareGist,
      addGithubMcpTools,
      additionalMcpConfigs
    });
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    outputCommandResult({ ...payload, jobId: job.id, title: job.title }, renderQueuedTaskLaunch({ ...payload, jobId: job.id, title: job.title }), options.json);
    return;
  }

  const job = buildTaskJob(workspaceRoot, taskMetadata, write);
  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        cwd,
        model,
        effort,
        prompt,
        write,
        resumeLast,
        jobId: job.id,
        denyTools,
        addDirs,
        autopilot,
        maxAutopilotContinues,
        shareMarkdown,
        shareMarkdownPath,
        shareGist,
        addGithubMcpTools: addGithubMcpTools.length > 0 ? addGithubMcpTools : undefined,
        additionalMcpConfigs: additionalMcpConfigs.length > 0 ? additionalMcpConfigs : undefined,
        onProgress: progress
      }),
    { json: options.json }
  );
}

// D5 / 0.5.0: /copilot:plan runs Copilot in plan mode (--plan) to
// produce a structured implementation plan. This is a thin variant of
// the task flow with three forced settings:
//   - --plan tells Copilot to use plan mode (no code edits expected).
//   - We pass deny-tool=write,shell to enforce read-only as defense-in-
//     depth in case Copilot's plan mode ever tries to mutate the tree.
//   - We do NOT enable autopilot or resume — plans are single-shot.
async function executePlanRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureCopilotAvailable(request.cwd);

  if (!request.prompt) {
    throw new Error("Provide a prompt describing what to plan.");
  }

  const result = await runCopilotPrompt(workspaceRoot, {
    prompt: request.prompt,
    sessionName: buildPersistentTaskSessionName(`plan: ${request.prompt}`),
    model: request.model,
    effort: request.effort,
    allowAllTools: true,
    planMode: true,
    denyTools: ["write", "shell"],
    addDirs: Array.isArray(request.addDirs) ? request.addDirs : undefined,
    shareMarkdown: Boolean(request.shareMarkdown),
    shareMarkdownPath: request.shareMarkdownPath ?? null,
    shareGist: Boolean(request.shareGist),
    addGithubMcpTools: Array.isArray(request.addGithubMcpTools) ? request.addGithubMcpTools : undefined,
    additionalMcpConfigs: Array.isArray(request.additionalMcpConfigs) ? request.additionalMcpConfigs : undefined,
    onProgress: request.onProgress
  });

  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const failureMessage = result.stderr ?? "";
  const touchedFiles = Array.isArray(result.touchedFiles) ? result.touchedFiles : [];
  const rendered = renderTaskResult({
    rawOutput,
    failureMessage,
    touchedFiles
  });
  const payload = {
    status: result.status,
    threadId: result.threadId,
    rawOutput,
    touchedFiles
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, "Plan ready."),
    jobTitle: "Copilot Plan",
    jobClass: "plan",
    write: false
  };
}

async function handlePlan(argv) {
  const { options: rawOptions, positionals } = parseCommandInput(argv, {
    valueOptions: [
      "model",
      "effort",
      "cwd",
      "prompt-file",
      "share-path",
      "mcp-tool",
      "mcp-config"
    ],
    booleanOptions: ["json", "background", "share", "share-gist"],
    aliasMap: {
      m: "model"
    }
  });

  const pluginConfig = loadPluginConfig();
  reportPluginConfigWarnings(pluginConfig);
  const options = applyPluginDefaults(rawOptions, pluginConfig);

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = options.model ?? null;
  const effort = normalizeReasoningEffort(options.effort);
  const addDirs = Array.isArray(options.addDirs) ? options.addDirs : undefined;
  const prompt = readTaskPrompt(cwd, options, positionals);
  const redactSummary = options.redactSummary === true;

  const shareMarkdownPath =
    typeof options["share-path"] === "string" && options["share-path"].trim()
      ? options["share-path"].trim()
      : null;
  const shareMarkdown = Boolean(options.share) || Boolean(shareMarkdownPath);
  const shareGist = Boolean(options["share-gist"]);
  const addGithubMcpTools = parseCommaSeparatedList(options["mcp-tool"]);
  const additionalMcpConfigs =
    typeof options["mcp-config"] === "string" && options["mcp-config"].trim()
      ? [options["mcp-config"].trim()]
      : [];

  if (!prompt) {
    throw new Error("Provide a prompt, a prompt file, or piped stdin describing what to plan.");
  }

  const summary = redactSummary ? "[summary redacted]" : shorten(prompt);
  const job = createCompanionJob({
    prefix: "plan",
    kind: "plan",
    title: "Copilot Plan",
    workspaceRoot,
    jobClass: "plan",
    summary,
    write: false
  });

  if (options.background) {
    ensureCopilotAvailable(cwd);
    const request = {
      cwd,
      model,
      effort,
      prompt,
      jobId: job.id,
      addDirs,
      shareMarkdown,
      shareMarkdownPath,
      shareGist,
      addGithubMcpTools: addGithubMcpTools.length > 0 ? addGithubMcpTools : undefined,
      additionalMcpConfigs: additionalMcpConfigs.length > 0 ? additionalMcpConfigs : undefined
    };
    const { payload } = enqueueBackgroundTask(cwd, job, request, {
      jobClass: "plan"
    });
    outputCommandResult(
      { ...payload, jobId: job.id, title: job.title },
      renderQueuedTaskLaunch({ ...payload, jobId: job.id, title: job.title }),
      options.json
    );
    return;
  }

  await runForegroundCommand(
    job,
    (progress) =>
      executePlanRun({
        cwd,
        model,
        effort,
        prompt,
        addDirs,
        shareMarkdown,
        shareMarkdownPath,
        shareGist,
        addGithubMcpTools: addGithubMcpTools.length > 0 ? addGithubMcpTools : undefined,
        additionalMcpConfigs: additionalMcpConfigs.length > 0 ? additionalMcpConfigs : undefined,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }

  const { logFile, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );
  // Dispatch on the stored request's jobClass so plan jobs go to the
  // plan executor and tasks go to the task executor. Defaults to "task"
  // for jobs queued by older plugin versions before the tag existed.
  const executor =
    request.jobClass === "plan"
      ? () => executePlanRun({ ...request, onProgress: progress })
      : () => executeTaskRun({ ...request, onProgress: progress });

  await runTrackedJob(
    {
      ...storedJob,
      workspaceRoot,
      logFile
    },
    executor,
    { logFile }
  );
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);

  // Sweep any orphan "running" jobs whose worker processes have died.
  // This must happen before snapshots are built so /copilot:status never
  // shows a zombie record.
  let sweepSummary = null;
  try {
    sweepSummary = sweepDeadJobs(resolveWorkspaceRoot(cwd));
  } catch {
    // Sweeping is best-effort. If state is corrupt or the workspace root
    // can't be resolved, fall through to the normal status flow rather
    // than failing the command.
  }

  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  if (sweepSummary && sweepSummary.swept?.length > 0) {
    report.sweep = {
      swept: sweepSummary.swept.length,
      checked: sweepSummary.checked,
      ids: sweepSummary.swept.map((entry) => entry.id)
    };
  }
  outputResult(options.json ? report : renderStatusReport(report), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = {
    job,
    storedJob
  };

  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            threadId: candidate.threadId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};

  terminateProcessTree(job.pid ?? Number.NaN);
  appendLogLine(job.logFile, "Cancelled by user.");

  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };

  writeJobFile(workspaceRoot, job.id, {
    ...existing,
    ...nextJob,
    cancelledAt: completedAt
  });
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    errorMessage: "Cancelled by user.",
    completedAt
  });

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title
  };

  outputCommandResult(payload, renderCancelReport(nextJob), options.json);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleAdversarialReview(argv);
      break;
    case "task":
      await handleTask(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "plan":
      await handlePlan(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
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
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
