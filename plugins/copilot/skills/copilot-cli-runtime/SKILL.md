---
name: copilot-cli-runtime
description: Internal helper contract for calling the copilot-companion runtime from Claude Code
---

# copilot-cli-runtime

This skill exists for the `copilot:copilot-rescue` subagent. It documents the contract for the `copilot-companion.mjs` runtime that powers `/copilot:rescue`.

## What you can and cannot do

- You may invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" task ...` via a single `Bash` call to delegate work to the GitHub Copilot CLI.
- You may not inspect the repository, run tools yourself, or do follow-up work after the companion returns.

## Subcommand: `task`

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" task \
    [--background] \
    [--write] \
    [--resume-last] \
    [--model <model>] \
    [--effort <low|medium|high|xhigh>] \
    [prompt text...]
```

- `--background` queues the task as a detached worker and returns immediately with a job id.
- `--write` enables Copilot's tool surface so it can edit files. Default for rescue.
- `--resume-last` resumes the most recent task session in this repository (via `copilot --resume=<sessionId>`).
- `--model <name>` selects a Copilot model. Leave unset unless the user explicitly asks.
- `--effort <level>` sets reasoning effort. Leave unset unless the user explicitly asks.

## Return contract

- stdout is the final assistant message from Copilot, verbatim.
- A non-zero exit means Copilot failed. The error message is written to stderr.
- Resume hints (`copilot --resume=<sessionId>`) are appended by `/copilot:result`, not by `task` itself.

## Anti-patterns

- Do not parse the JSONL emitted by `copilot --output-format json` yourself. The companion already does that.
- Do not call `copilot` directly. Always go through `copilot-companion.mjs`.
- Do not call `task` with `--background` and then poll `--wait` or `BashOutput` in the same turn. Background launches return immediately and the user (or another command) checks `/copilot:status` later.
