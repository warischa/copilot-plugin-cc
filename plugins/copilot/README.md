# copilot

Use the [GitHub Copilot CLI](https://github.com/features/copilot/cli) from inside Claude Code for code reviews and task delegation.

## Commands

| Command | Purpose |
|---|---|
| `/copilot:setup` | Verify the Copilot CLI is installed and authenticated. Offers to install via npm if missing. |
| `/copilot:review` | Run a read-only Copilot code review on the working tree or a branch diff. |
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

## How it works

The plugin spawns the Copilot CLI in non-interactive mode and parses its JSONL event stream:

```
copilot -p "<prompt>" --output-format json --allow-all-tools [--model <m>] [--effort <e>] [--resume=<id>]
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
- `/copilot:plan` (uses Copilot's `--mode plan`) — under consideration for 0.5.0

## License

MIT.
