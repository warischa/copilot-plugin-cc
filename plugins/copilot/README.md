# copilot

Use the [GitHub Copilot CLI](https://github.com/features/copilot/cli) from inside Claude Code for code reviews and task delegation.

## Commands

| Command | Purpose |
|---|---|
| `/copilot:setup` | Verify the Copilot CLI is installed and authenticated. Offers to install via npm if missing. |
| `/copilot:review` | Run a read-only Copilot code review on the working tree or a branch diff. |
| `/copilot:adversarial-review` | Challenge-style review that questions implementation approach, tradeoffs, and assumptions. |
| `/copilot:plan` | Use Copilot's plan mode (`--plan`) to produce a structured implementation plan — no code is written. |
| `/copilot:rescue` | Delegate a task to Copilot through the `copilot-rescue` subagent (investigate, fix, continue prior work). |
| `/copilot:status` | List active and recent Copilot jobs for the current repository. |
| `/copilot:result` | Show the stored final output for a finished Copilot job. |
| `/copilot:cancel` | Cancel an active background Copilot job. |

All slash commands run against the **current git repository**. Job state is scoped per-workspace.

## Subagents

| Subagent | Purpose |
|---|---|
| `copilot-rescue` | Thin forwarder that delegates a substantial debugging or implementation task to the Copilot CLI. Used proactively when the main Claude thread should hand off a task. |

## Skills

| Skill | Purpose |
|---|---|
| `copilot-cli-runtime` | Internal contract for the `copilot-companion.mjs` runtime. |
| `copilot-result-handling` | Internal guidance for how to present Copilot output to the user verbatim. |

## Quick start

```bash
/copilot:setup            # verify install + auth
/copilot:review           # review uncommitted work
/copilot:review --base main --background
/copilot:status
/copilot:result
```

```bash
/copilot:rescue investigate why CI is failing
/copilot:rescue --background --resume continue applying the fix
/copilot:rescue --model gpt-5.4 --effort high redesign the cache layer
/copilot:rescue --autopilot --max-autopilot-continues 10 refactor the data layer
```

```bash
/copilot:plan add OAuth2 with Google and GitHub providers
/copilot:plan --effort high migrate from REST to GraphQL in the public API
```

```bash
/copilot:adversarial-review --no-custom-instructions     # fresh-eyes review, ignores AGENTS.md
```

## Requirements

- **GitHub Copilot CLI** installed and authenticated
  - Install: `npm install -g @github/copilot`
  - Auth: `copilot login` (or set `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`)
- **Node.js 20+**
- **git** (commands operate on the current repository)

## Common flags

- `--wait` — run in the foreground and stream progress
- `--background` — queue the job and return immediately; check `/copilot:status` later
- `--base <ref>` — review a branch diff against `<ref>` (e.g. `--base main`)
- `--scope <auto|working-tree|branch>` — override review-target detection
- `--model <name>` — override the Copilot model (leave unset for the default)
- `--effort <none|low|medium|high|xhigh|max>` — set reasoning effort
- `--resume` — for `/copilot:rescue`, continue the latest rescue session in this repo
- `--fresh` — for `/copilot:rescue`, force a new session (skip the resume prompt)
- `--write` — for `/copilot:rescue`, allow Copilot to edit files (default; rescue is write-capable)
- `--autopilot` — for `/copilot:rescue`, run Copilot in autopilot mode (multi-turn auto-continue)
- `--max-autopilot-continues <N>` — cap the number of autopilot turns (Copilot default: 5)
- `--no-custom-instructions` — for `/copilot:adversarial-review`, bypass `AGENTS.md` / repo instructions for a fresh-eyes review
- `--share` / `--share-path <path>` / `--share-gist` — write the session transcript to markdown (default path / explicit path / secret GitHub gist). See the repo README "Sharing transcripts" table.
- `--mcp-tool <names>` / `--mcp-config <json|@file>` — for `/copilot:rescue` and `/copilot:plan`, extend the GitHub MCP toolset or augment MCP-config for one run. Not exposed on reviews (read-only contract).
- `--allow-tool <pats>` / `--allow-url <pats>` / `--deny-url <pats>` — symmetric allow/deny pass-through (comma lists) on all four agent commands. Copilot's deny rules always win, so reviews keep their `write`/`shell` deny baseline even if `--allow-tool=shell` is passed.
- `--attachment <paths>` — for `/copilot:rescue` only, attach images or native documents (comma list) to the initial prompt.
- `--allow-remote` / `--allow-ask-user` — opt out of the plugin's privacy hardening defaults (the plugin emits `--no-remote` and `--no-ask-user` for non-interactive runs; these flags suppress them individually).

## How it works

The plugin spawns the Copilot CLI in non-interactive mode and parses its JSONL event stream. By default it hardens two non-interactive defaults (`--no-remote` to disable remote session control from GitHub web/mobile, `--no-ask-user` to keep the agent from stalling on input that can't be answered):

```
copilot -p "<prompt>" --output-format json --allow-all-tools --no-remote --no-ask-user [--model <m>] [--effort <e>] [--resume=<id>] [--plan|--autopilot] [--share[=path]|--share-gist] [--add-github-mcp-tool <t>] [--additional-mcp-config <json|@file>] [--allow-tool=<p>] [--allow-url=<p>] [--deny-url=<p>] [--attachment <path>]
```

It captures the final assistant message and the Copilot `sessionId` so finished jobs can be reopened with `copilot --resume=<id>`. Background jobs run as detached workers and update state files under `$CLAUDE_PLUGIN_DATA/state/<workspace-slug>`.

## Configuration

This plugin does not override Copilot configuration. Set defaults (model, effort, etc.) in `~/.copilot/` or via standard Copilot environment variables — they are picked up automatically.

### Custom instructions (auto-loaded by Copilot)

Copilot CLI automatically reads instructions from these paths whenever you start a session — the plugin doesn't load them, but `/copilot:setup` reports which ones it found so you know what's active:

| Path | Scope |
|---|---|
| `~/.copilot/copilot-instructions.md` | global (all sessions) |
| `.github/copilot-instructions.md` | repo |
| `.github/instructions/*.instructions.md` | repo (modular) |
| `AGENTS.md` (repo root) | repo |
| `Copilot.md` / `GEMINI.md` / `CODEX.md` | repo |

Repo-level files take precedence over the global one. Keep them concise — see [Copilot CLI best practices](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-best-practices#use-custom-instructions-files).

### Plugin config

The plugin reads `~/.claude/plugins/copilot/config.json` (override with `COPILOT_PLUGIN_CONFIG_PATH`):

```json
{
  "model": "claude-sonnet-4-5",
  "effort": "high",
  "denyTools": ["shell(git push)"],
  "addDirs": ["/path/to/related/repo"],
  "redactSummary": false
}
```

| Key | Type | What it does |
|---|---|---|
| `model` | string | Default `--model` value when no flag is passed |
| `effort` | string | One of `none/low/medium/high/xhigh/max` |
| `denyTools` | string[] | Extra `--deny-tool=` entries appended to the baseline (`write`, `shell` for reviews) |
| `addDirs` | string[] | Extra `--add-dir` paths granted to the agent |
| `redactSummary` | boolean | **Privacy:** when `true`, stored task summaries show `[summary redacted]` instead of the first ~96 chars of the prompt. Useful if you paste secrets or PII into prompts. Default `false`. |

## Not in this version

- Stop-time review gate (Stop hook) — not shipped yet

## License

MIT.
