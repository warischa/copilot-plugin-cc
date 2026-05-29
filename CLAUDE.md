# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Claude Code plugin (marketplace-style repo) that wraps the [GitHub Copilot CLI](https://github.com/features/copilot/cli) (`copilot` binary) so users can run code reviews and delegate tasks to Copilot through `/copilot:*` slash commands inside Claude Code.

## Installing this plugin

If asked to install or enable this plugin (as opposed to developing it), see [`README.md` "Install"](README.md) for the full flow. Quick reference — marketplace slug is `claude-copilot`, plugin name is `copilot`:

- **Global** (every session): `/plugin marketplace add warischa/copilot-plugin-cc` → `/plugin install copilot@claude-copilot` → `/reload-plugins`.
- **Project-level** (one repo): add a `.claude/settings.json` with `extraKnownMarketplaces["claude-copilot"]` (github `warischa/copilot-plugin-cc`, or a local `directory` path for plugin development) plus `enabledPlugins["copilot@claude-copilot"]: true`. Do **not** run `/plugin install` for this — the project settings enable it; `/reload-plugins` to pick it up.
- Verify either way with `/copilot:setup`.

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

`node --test tests/*.test.mjs`. Tests use temp `CLAUDE_PLUGIN_DATA` directories, temp git repos, and temp dirs so they don't touch user state. As of 2026-05-29 (post-v0.8.1) the suite has **433 tests** (5 skipped — the 5 real-binary integration tests are opt-in) covering most `lib/` modules directly — args, state, render, plugin-config, job-liveness, job-control, git (review-target + `collectReviewContext`), fs, prompts, workspace, tracked-jobs (+ `runTrackedJob`), process, the `copilot.mjs` JSONL event parsers (`describeEvent`, `captureFinalAnswer`), the `isEntryPoint` guard, a spawn-based `companion-cli` integration test for the CLI dispatcher, a `marketplace.test.mjs` install-readiness lint (manifest shape + the documented `copilot@claude-copilot` install id + payload), plus `run-dispatch.test.mjs` (task/plan dispatch option-mapping, session-name precedence, and validation via an injected runner — no live binary). The real-binary integration tests (`tests/integration.test.mjs`) are opt-in via `COPILOT_INTEGRATION=1` and cover the live handlers hermetic tests can't reach: `task` (foreground), `setup`, `review` + `adversarial-review` (incl. the read-only invariant — the reviewed file is unchanged on disk), and the full background `task-worker` lifecycle (`task --background` → `status --wait` → `result`). Measure with `node --test --experimental-test-coverage`; **CI (Node 20/22 × Linux/macOS/Windows) is the cross-platform gate** — local macOS green is not sufficient (see DESIGN.md §4). Coverage on `copilot-companion.mjs` is ~35% in the default (ungated) run — the integration tests skip, so they don't lift the default number — but rises to **~81% line / ~87% funcs when run with `COPILOT_INTEGRATION=1`** (the live tier exercises review/setup/worker). `process.mjs` `terminateProcessTree` stays capped by design. See DESIGN.md §5 "Test-coverage expansion".
