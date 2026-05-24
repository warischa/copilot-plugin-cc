# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Claude Code plugin (marketplace-style repo) that wraps the [GitHub Copilot CLI](https://github.com/features/copilot/cli) (`copilot` binary) so users can run code reviews and delegate tasks to Copilot through `/copilot:*` slash commands inside Claude Code.

## Conceptual source

**Reference implementation: [https://github.com/openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc)**

This plugin is a direct port of `openai/codex-plugin-cc`, re-pointed from the OpenAI Codex CLI to the GitHub Copilot CLI. **Always check that repo first** when:

- Adding a feature that already exists there (e.g. `/codex:adversarial-review`, Stop-hook review gate, structured `ReviewOutput` schema)
- Debugging the job-tracking / state / render layers (those modules were ported with minimal changes)
- Designing a new command or subagent (mirror their command/agent shape)
- Wondering why a piece of code looks the way it does (it probably mirrors their version)

A local sibling clone is at `../codex-plugin-cc/` — use `Read` against `plugins/codex/scripts/lib/*.mjs` to compare patterns directly.

See `DESIGN.md` §1 for the full concept-mapping table (codex → copilot) and which files were reused as-is vs rewritten.

## Commands

```bash
npm test                                                   # full test suite (node --test tests/*.test.mjs)
node --test tests/render.test.mjs                          # single test file
node plugins/copilot/scripts/copilot-companion.mjs help    # companion CLI usage
node plugins/copilot/scripts/copilot-companion.mjs setup   # verify copilot install + auth
```

No build step, no linter, no bundler. The plugin runs Node.js source directly.

## Architecture

### Two-layer wrapper

1. **Slash commands** (`plugins/copilot/commands/*.md`) — thin markdown files that shell out to the companion script via:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" <subcommand> "$ARGUMENTS"
   ```
   They contain prompt-level rules (when to ask user, when to background, how to render). They do NOT contain business logic.

2. **Node.js companion** (`plugins/copilot/scripts/copilot-companion.mjs` + `lib/`) — all business logic. Dispatches subcommands (`setup`, `review`, `task`, `status`, `result`, `cancel`, `task-worker`, `task-resume-candidate`).

### Runtime driver

`lib/copilot.mjs` is the only file that knows how to talk to the `copilot` binary. It spawns:
```
copilot -p "<prompt>" --output-format json --allow-all-tools [flags...]
```
and parses the JSONL event stream (`user.message`, `assistant.message`, `assistant.turn_end`, `result`, ...). Final answer comes from `assistant.message` with `phase: "final_answer"`. Copilot session id comes from the `result` event's `sessionId` field — this is what `--resume=<id>` uses.

`--allow-all-tools` is required for `-p` non-interactive mode. The CLI hangs without it.

### Job model

Every command run creates a tracked job. State lives under `$CLAUDE_PLUGIN_DATA/state/<workspace-slug>-<hash>/` (fallback: `os.tmpdir()/copilot-companion/`):
- `state.json` — index of jobs (capped at 50 newest)
- `jobs/<id>.json` — per-job record (status, threadId, result, rendered, request)
- `jobs/<id>.log` — append-only progress log

Background jobs (`--background`) spawn a detached `task-worker` subprocess that re-enters the companion with `--job-id` to pick up the stored request.

### Field naming

`threadId` in stored jobs **= Copilot session id**. The name is inherited from the codex-plugin-cc port to keep the storage layer plugin-agnostic. Only user-facing strings call it "Copilot session ID". Don't rename the storage field.

### Workspace scoping

Jobs are scoped per git repository via `lib/workspace.mjs` (uses `git rev-parse --show-toplevel`, falls back to `cwd`). The state directory slug is `basename(workspaceRoot)-sha256(realpath(workspaceRoot)).slice(0,16)`.

### Session scoping

`SESSION_ID_ENV = "COPILOT_COMPANION_SESSION_ID"` filters job lists by Claude Code session when set. This keeps `/copilot:status` and resume candidates scoped to the current Claude conversation.

## Invariants — do not break

- Slash commands and the rescue subagent return Copilot's stdout **verbatim**. No paraphrasing, no summarizing. The `copilot-result-handling` skill documents this.
- The companion script is the **only** path to invoke `copilot`. Slash commands should never shell directly to `copilot`.
- Review is **read-only**. The review prompt template (`prompts/review.md`) instructs Copilot not to edit, and the companion passes `--deny-tool=write,edit,shell` to enforce best-effort.
- `--resume` / `--fresh` / `--background` / `--wait` are routing flags handled in the command markdown and the companion arg parser. They are stripped before being forwarded as natural-language task text.

## Where to extend

| Goal | Where to start |
|---|---|
| Add a new subcommand | `copilot-companion.mjs` switch in `main()`, plus a matching `commands/<name>.md` |
| Change how Copilot is invoked | `lib/copilot.mjs` — `buildCopilotArgs()` + `runCopilotPrompt()` |
| Change job lifecycle | `lib/tracked-jobs.mjs` (`runTrackedJob`) + `lib/state.mjs` |
| Change output formatting | `lib/render.mjs` |
| Port a codex feature (e.g. adversarial review, Stop gate) | Check `codex-plugin-cc/plugins/codex/{commands,scripts}` for the reference implementation |

## Tests

`node --test tests/*.test.mjs`. Tests use a temp `CLAUDE_PLUGIN_DATA` directory so they don't touch user state. Coverage is intentionally minimal (args parser, state CRUD, render functions) — no integration tests against the real `copilot` binary.
