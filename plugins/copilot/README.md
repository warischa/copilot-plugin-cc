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
- **Node.js 18.18+**
- **git** (commands operate on the current repository)

## Common flags

- `--wait` — run in the foreground and stream progress
- `--background` — queue the job and return immediately; check `/copilot:status` later
- `--base <ref>` — review a branch diff against `<ref>` (e.g. `--base main`)
- `--scope <auto|working-tree|branch>` — override review-target detection
- `--model <name>` — override the Copilot model (leave unset for the default)
- `--effort <low|medium|high|xhigh>` — set reasoning effort
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

## Not in this version

- `/copilot:adversarial-review` — use `/copilot:review` and steer with a more pointed request in the conversation
- Stop-time review gate (Stop hook) — not shipped in v1

## License

MIT.
