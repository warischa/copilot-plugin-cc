---
name: copilot-result-handling
description: Internal guidance for presenting Copilot helper output back to the user
---

# copilot-result-handling

This skill applies to the `/copilot:rescue`, `/copilot:review`, and `/copilot:result` commands.

## Cardinal rule

Return Copilot's stdout **verbatim** to the user. Do not paraphrase, summarize, or rewrite.

## Why

The slash commands are intentionally thin wrappers. Reformatting the output:

- hides line numbers and file paths that users need to navigate
- erases the verdict Copilot already concluded with
- breaks downstream commands that pipe the result

## When to add to the response

The only allowed additions are:

- The "started in the background as <job-id>" line that `task --background` already emits
- The Copilot session ID + `copilot --resume=<id>` hint that `/copilot:result` already emits
- A one-line confirmation if you ran a background command (e.g., "Copilot review started in the background. Check `/copilot:status` for progress.")

## When stdout is empty

If `task` or `review` returns empty stdout, surface the stderr instead. Do not invent a summary.
