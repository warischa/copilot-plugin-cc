// U1 helper. Status + phase are distinct fields but at terminal states
// they say the same thing. `completed` jobs always end at phase=done;
// `failed` / `cancelled` similarly carry no additional information in the
// phase field. Suppress those duplications in the rendered output.
const REDUNDANT_PHASE_BY_STATUS = {
  completed: new Set(["done"]),
  failed: new Set(["failed", "error", "done"]),
  cancelled: new Set(["cancelled", "done"])
};

export function isRedundantPhase(status, phase) {
  const set = REDUNDANT_PHASE_BY_STATUS[status];
  return Boolean(set && phase && set.has(phase));
}

function formatJobLine(job) {
  const parts = [job.id, `${job.status || "unknown"}`];
  if (job.kindLabel) {
    parts.push(job.kindLabel);
  }
  if (job.title) {
    parts.push(job.title);
  }
  return parts.join(" | ");
}

function escapeMarkdownCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function formatCopilotResumeCommand(job) {
  if (!job?.threadId) {
    return null;
  }
  return `copilot --resume=${job.threadId}`;
}

function appendActiveJobsTable(lines, jobs) {
  lines.push("Active jobs:");
  lines.push("| Job | Kind | Status | Phase | Elapsed | Copilot Session ID | Summary | Actions |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const job of jobs) {
    const actions = [`/copilot:status ${job.id}`];
    if (job.status === "queued" || job.status === "running") {
      actions.push(`/copilot:cancel ${job.id}`);
    }
    lines.push(
      `| ${escapeMarkdownCell(job.id)} | ${escapeMarkdownCell(job.kindLabel)} | ${escapeMarkdownCell(job.status)} | ${escapeMarkdownCell(job.phase ?? "")} | ${escapeMarkdownCell(job.elapsed ?? "")} | ${escapeMarkdownCell(job.threadId ?? "")} | ${escapeMarkdownCell(job.summary ?? "")} | ${actions.map((action) => `\`${action}\``).join("<br>")} |`
    );
  }
}

function pushJobDetails(lines, job, options = {}) {
  lines.push(`- ${formatJobLine(job)}`);
  if (job.summary) {
    lines.push(`  Summary: ${job.summary}`);
  }
  // U1: skip the phase line when it would duplicate the lifecycle status.
  // A completed job will always have phase=done; printing both is noise.
  if (job.phase && !isRedundantPhase(job.status, job.phase)) {
    lines.push(`  Phase: ${job.phase}`);
  }
  if (options.showElapsed && job.elapsed) {
    lines.push(`  Elapsed: ${job.elapsed}`);
  }
  if (options.showDuration && job.duration) {
    lines.push(`  Duration: ${job.duration}`);
  }
  if (job.threadId) {
    lines.push(`  Copilot session ID: ${job.threadId}`);
  }
  const resumeCommand = formatCopilotResumeCommand(job);
  if (resumeCommand) {
    lines.push(`  Resume in Copilot: ${resumeCommand}`);
  }
  if (job.logFile && options.showLog) {
    lines.push(`  Log: ${job.logFile}`);
  }
  if ((job.status === "queued" || job.status === "running") && options.showCancelHint) {
    lines.push(`  Cancel: /copilot:cancel ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && options.showResultHint) {
    lines.push(`  Result: /copilot:result ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && job.jobClass === "task" && job.write && options.showReviewHint) {
    lines.push("  Review changes: /copilot:review --wait");
  }
  if (job.progressPreview?.length) {
    lines.push("  Progress:");
    for (const line of job.progressPreview) {
      lines.push(`    ${line}`);
    }
  }
}

export function renderSetupReport(report) {
  const lines = [
    "# Copilot Setup",
    "",
    `Status: ${report.ready ? "ready" : "needs attention"}`,
    "",
    "Checks:",
    `- node: ${report.node.detail}`,
    `- npm: ${report.npm.detail}`,
    `- copilot: ${report.copilot.detail}`,
    `- auth: ${report.auth.detail}`,
    ""
  ];

  if (report.pluginConfig) {
    const cfg = report.pluginConfig;
    const summary = [];
    if (cfg.model) {
      summary.push(`model=${cfg.model}`);
    }
    if (cfg.effort) {
      summary.push(`effort=${cfg.effort}`);
    }
    const label = summary.length > 0 ? summary.join(", ") : "(no defaults set)";
    lines.push(`Plugin config (${cfg.path}): ${label}`);
    if (Array.isArray(cfg.warnings) && cfg.warnings.length > 0) {
      for (const warning of cfg.warnings) {
        lines.push(`  ! ${warning}`);
      }
    }
    lines.push("");
  }

  if (Array.isArray(report.instructions) && report.instructions.length > 0) {
    lines.push("Copilot custom instructions auto-loaded:");
    for (const entry of report.instructions) {
      lines.push(`- [${entry.scope}] ${entry.path}`);
    }
    lines.push("");
  }

  if (report.actionsTaken.length > 0) {
    lines.push("Actions taken:");
    for (const action of report.actionsTaken) {
      lines.push(`- ${action}`);
    }
    lines.push("");
  }

  if (report.nextSteps.length > 0) {
    lines.push("Next steps:");
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderReviewResult(result, meta) {
  const stdout = String(result.stdout ?? "").trim();
  const stderr = String(result.stderr ?? "").trim();
  const lines = [
    `# Copilot ${meta.reviewLabel}`,
    "",
    `Target: ${meta.targetLabel}`,
    ""
  ];

  if (stdout) {
    lines.push(stdout);
  } else if (result.status === 0) {
    lines.push("Copilot review completed without any output.");
  } else {
    lines.push("Copilot review failed.");
  }

  if (stderr) {
    lines.push("", "stderr:", "", "```text", stderr, "```");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

// Inline file-summary budget. A typical Copilot rescue touches 1–5 short
// paths and fits cleanly on one line, but real refactors often hit 8–10
// files with long paths and the previous count-of-5 cap silently truncated
// most of the useful context. Use a character budget so short paths get
// more inline entries and long paths stop earlier, then fall back to a
// hard ceiling so a single pathologically long line can't dominate.
const INLINE_FILES_CHAR_BUDGET = 160;
const INLINE_FILES_HARD_CAP = 12;

function pickInlineFiles(files) {
  const shown = [];
  let charsUsed = 0;
  for (const file of files) {
    if (shown.length >= INLINE_FILES_HARD_CAP) break;
    // 2 chars accounts for the ", " separator before each entry beyond
    // the first. We still always include at least one file even if it
    // exceeds the budget — truncating to zero would hide everything.
    const addedCost = (shown.length === 0 ? 0 : 2) + file.length;
    if (shown.length > 0 && charsUsed + addedCost > INLINE_FILES_CHAR_BUDGET) {
      break;
    }
    shown.push(file);
    charsUsed += addedCost;
  }
  return shown;
}

export function renderTouchedFilesSummary(touchedFiles) {
  if (!Array.isArray(touchedFiles) || touchedFiles.length === 0) {
    return null;
  }
  const total = touchedFiles.length;
  const shown = pickInlineFiles(touchedFiles);
  const overflow = total - shown.length;
  const suffix = overflow > 0 ? `, ...and ${overflow} more` : "";
  const noun = total === 1 ? "file" : "files";
  return `Touched ${total} ${noun}: ${shown.join(", ")}${suffix}`;
}

export function renderTaskResult(parsedResult) {
  const rawOutput = typeof parsedResult?.rawOutput === "string" ? parsedResult.rawOutput : "";
  const touchedFiles = Array.isArray(parsedResult?.touchedFiles) ? parsedResult.touchedFiles : [];
  const summaryLine = renderTouchedFilesSummary(touchedFiles);
  const header = summaryLine ? `${summaryLine}\n\n` : "";

  if (rawOutput) {
    const trimmed = rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`;
    return `${header}${trimmed}`;
  }

  const message = String(parsedResult?.failureMessage ?? "").trim() || "Copilot did not return a final message.";
  return `${header}${message}\n`;
}

export function renderStatusReport(report) {
  const lines = [
    "# Copilot Status",
    ""
  ];

  if (report.sweep && report.sweep.swept > 0) {
    const noun = report.sweep.swept === 1 ? "job" : "jobs";
    const ids = Array.isArray(report.sweep.ids) ? report.sweep.ids.join(", ") : "";
    const idSuffix = ids ? ` (${ids})` : "";
    lines.push(`Swept ${report.sweep.swept} orphan ${noun}${idSuffix}.`, "");
  }

  if (report.running.length > 0) {
    appendActiveJobsTable(lines, report.running);
    lines.push("");
    lines.push("Live details:");
    for (const job of report.running) {
      pushJobDetails(lines, job, {
        showElapsed: true,
        showLog: true
      });
    }
    lines.push("");
  }

  if (report.latestFinished) {
    lines.push("Latest finished:");
    pushJobDetails(lines, report.latestFinished, {
      showDuration: true,
      showLog: report.latestFinished.status === "failed"
    });
    lines.push("");
  }

  if (report.recent.length > 0) {
    lines.push("Recent jobs:");
    for (const job of report.recent) {
      pushJobDetails(lines, job, {
        showDuration: true,
        showLog: job.status === "failed"
      });
    }
    lines.push("");
  } else if (report.running.length === 0 && !report.latestFinished) {
    lines.push("No jobs recorded yet.", "");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderJobStatusReport(job) {
  const lines = ["# Copilot Job Status", ""];
  pushJobDetails(lines, job, {
    showElapsed: job.status === "queued" || job.status === "running",
    showDuration: job.status !== "queued" && job.status !== "running",
    showLog: true,
    showCancelHint: true,
    showResultHint: true,
    showReviewHint: true
  });
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderStoredJobResult(job, storedJob) {
  const threadId = storedJob?.threadId ?? job.threadId ?? null;
  const resumeCommand = threadId ? `copilot --resume=${threadId}` : null;

  const rawOutput =
    (typeof storedJob?.result?.rawOutput === "string" && storedJob.result.rawOutput) ||
    (typeof storedJob?.result?.copilot?.stdout === "string" && storedJob.result.copilot.stdout) ||
    "";
  if (rawOutput) {
    const output = rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`;
    if (!threadId) {
      return output;
    }
    return `${output}\nCopilot session ID: ${threadId}\nResume in Copilot: ${resumeCommand}\n`;
  }

  if (storedJob?.rendered) {
    const output = storedJob.rendered.endsWith("\n") ? storedJob.rendered : `${storedJob.rendered}\n`;
    if (!threadId) {
      return output;
    }
    return `${output}\nCopilot session ID: ${threadId}\nResume in Copilot: ${resumeCommand}\n`;
  }

  const lines = [
    `# ${job.title ?? "Copilot Result"}`,
    "",
    `Job: ${job.id}`,
    `Status: ${job.status}`
  ];

  if (threadId) {
    lines.push(`Copilot session ID: ${threadId}`);
    lines.push(`Resume in Copilot: ${resumeCommand}`);
  }

  if (job.summary) {
    lines.push(`Summary: ${job.summary}`);
  }

  if (job.errorMessage) {
    lines.push("", job.errorMessage);
  } else if (storedJob?.errorMessage) {
    lines.push("", storedJob.errorMessage);
  } else {
    lines.push("", "No captured result payload was stored for this job.");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderCancelReport(job) {
  const lines = [
    "# Copilot Cancel",
    "",
    `Cancelled ${job.id}.`,
    ""
  ];

  if (job.title) {
    lines.push(`- Title: ${job.title}`);
  }
  if (job.summary) {
    lines.push(`- Summary: ${job.summary}`);
  }
  lines.push("- Check `/copilot:status` for the updated queue.");

  return `${lines.join("\n").trimEnd()}\n`;
}
