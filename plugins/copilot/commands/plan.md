---
description: Have Copilot produce a structured implementation plan (using its built-in plan mode) before any code is written
argument-hint: "[--wait|--background] [--model <model>] [--effort <none|low|medium|high|xhigh|max>] [--share[=<path>]|--share-path <path>] [--share-gist] [--mcp-tool <names>] [--mcp-config <json|@file>] [--allow-tool <pats>] [--allow-url <urls>] [--deny-url <urls>] [--secret-env <vars>] [--session-name <name>] [--allow-remote] [--allow-ask-user] [--allow-auto-update] [what to plan]"
allowed-tools: Bash(node:*), AskUserQuestion
---

Run Copilot in **plan mode** (`--plan`) via the companion script. Copilot analyzes the request against the current repository and produces a structured implementation plan with checkboxes — no code is written. The output is the plan itself, returned verbatim.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is plan-only. Copilot must not write or edit files.
- The plugin enforces this by passing `--deny-tool=write,shell` on top of `--plan`.
- Your only job is to launch the planner and return Copilot's output verbatim. Do not paraphrase or shorten.

Execution mode rules:
- If the raw arguments include `--wait`, run in the foreground.
- If the raw arguments include `--background`, run in a Claude background task.
- Otherwise, default to foreground — plans are usually short.

Argument handling:
- Preserve the user's arguments exactly.
- Do not strip `--wait` or `--background` yourself; the companion does that.
- `--model` and `--effort` are runtime-selection flags. Pass them through unchanged.
- Everything after the flags is the natural-language plan request.

Foreground flow:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" plan "$ARGUMENTS"
```
Return the command stdout verbatim, exactly as-is. No commentary before or after.

Background flow:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" plan "$ARGUMENTS"`,
  description: "Copilot plan",
  run_in_background: true
})
```
After launching, tell the user: "Copilot plan started in the background. Check `/copilot:status` for progress."

Notes:
- Plan mode is interactive about clarifying questions. In non-interactive `-p` mode (which the plugin uses), Copilot will skip those and produce its best plan with the information it has. If the request is ambiguous, the plan may include an "Assumptions" or "Open questions" section — surface that verbatim and let the user decide.
- The companion stores plan jobs the same way as `task` jobs; `/copilot:status` and `/copilot:result` work on them.
