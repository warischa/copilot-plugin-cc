// Liveness sweep for background Copilot jobs.
//
// Background jobs (spawned via `task --background`) detach a `task-worker`
// subprocess that updates its own job record on completion. If that worker
// dies abnormally (machine reboot, OOM kill, Ctrl-C of the foreground
// companion, etc.), the per-job record stays at `status: "running"`
// forever and pollutes `/copilot:status`.
//
// This module sweeps stale records by checking pid liveness with the
// classic `process.kill(pid, 0)` probe: signal 0 doesn't deliver anything,
// it just asks the kernel "does this pid exist?" — ESRCH means dead,
// EPERM means alive but not ours.

import fs from "node:fs";

import {
  listJobs,
  readJobFile,
  resolveJobFile,
  upsertJob,
  writeJobFile
} from "./state.mjs";

function nowIso() {
  return new Date().toISOString();
}

/**
 * Probe whether `pid` corresponds to a live process.
 *
 * Returns `true` if the process exists (even when we can't signal it,
 * EPERM), `false` if it's definitely gone (ESRCH), and `false` for any
 * other error — we'd rather false-flag a stuck job than leave a real
 * zombie record running forever.
 *
 * Exposed for tests; in production code, prefer `sweepDeadJobs`.
 */
export function isProcessAlive(pid) {
  if (pid == null || !Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && err.code === "EPERM") {
      // Process exists but we don't have permission to signal it.
      return true;
    }
    return false;
  }
}

function isRunningStatus(status) {
  return status === "running";
}

function diagnoseDeadJob(job) {
  if (job.pid == null) {
    return "Job record had status=running with no pid recorded.";
  }
  return `Process pid=${job.pid} no longer exists. Worker likely crashed or was killed.`;
}

/**
 * Inspect every job in state.json with `status: "running"` and flip the
 * ones whose worker process is no longer alive to `status: "failed"`.
 *
 * Queued jobs are intentionally left alone — they haven't claimed a pid
 * yet and the queue is small (worker spawns immediately after enqueue).
 *
 * Returns `{ swept: Array<{id, pid, reason}>, checked: number }` so
 * callers can surface a one-line summary if they want.
 */
export function sweepDeadJobs(workspaceRoot, options = {}) {
  const aliveProbe = options.isProcessAlive ?? isProcessAlive;
  const jobs = listJobs(workspaceRoot);
  const swept = [];
  let checked = 0;

  for (const job of jobs) {
    if (!isRunningStatus(job.status)) {
      continue;
    }
    checked += 1;
    if (aliveProbe(job.pid)) {
      continue;
    }

    const reason = diagnoseDeadJob(job);
    const completedAt = nowIso();

    // Update the per-job file if it exists; otherwise the state.json
    // record alone is enough — `/copilot:status` reads both.
    const jobFile = resolveJobFile(workspaceRoot, job.id);
    if (fs.existsSync(jobFile)) {
      try {
        const stored = readJobFile(jobFile);
        writeJobFile(workspaceRoot, job.id, {
          ...stored,
          status: "failed",
          phase: "failed",
          pid: null,
          completedAt: stored.completedAt ?? completedAt,
          errorMessage: stored.errorMessage ?? reason,
          liveness: { sweptAt: completedAt, reason }
        });
      } catch {
        // If the per-job file is corrupt, fall through to the state.json
        // update — at least the index will show the right status.
      }
    }

    upsertJob(workspaceRoot, {
      id: job.id,
      status: "failed",
      phase: "failed",
      pid: null,
      completedAt: job.completedAt ?? completedAt,
      errorMessage: job.errorMessage ?? reason,
      liveness: { sweptAt: completedAt, reason }
    });

    swept.push({ id: job.id, pid: job.pid ?? null, reason });
  }

  return { swept, checked };
}
