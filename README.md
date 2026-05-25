# GitHub Copilot plugin for Claude Code

Use the [GitHub Copilot CLI](https://github.com/features/copilot/cli) from inside Claude Code for code reviews and task delegation.

This plugin gives Claude Code users a workflow that mirrors what `openai/codex-plugin-cc` provides for OpenAI Codex — but backed by GitHub Copilot CLI instead.

## What you get

- `/copilot:review` — read-only code review of your current work
- `/copilot:rescue` — delegate a task (investigate, fix, continue prior work) to Copilot via the `copilot:copilot-rescue` subagent
- `/copilot:status`, `/copilot:result`, `/copilot:cancel` — manage background jobs
- `/copilot:setup` — verify install + auth

## Requirements

- **GitHub Copilot CLI** (`copilot`) installed and authenticated
  - Install: `npm install -g @github/copilot`
  - Auth: `copilot login` (or set `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`)
  - Requires a GitHub Copilot subscription
- **Node.js 20+**
- **git** (commands operate on the current repository)

## Install

Add the marketplace in Claude Code (from the public GitHub source):

```bash
/plugin marketplace add warischa/copilot-plugin-cc
```

Or from a local checkout:

```bash
/plugin marketplace add /path/to/copilot-plugin-cc
```

Install the plugin:

```bash
/plugin install copilot@claude-copilot
```

> [!NOTE]
> `claude-copilot` here is the **marketplace slug** declared in `.claude-plugin/marketplace.json` — not a GitHub organization. The source repo lives under [`warischa/copilot-plugin-cc`](https://github.com/warischa/copilot-plugin-cc). See [DESIGN.md §2 "Project identity"](DESIGN.md) for why the slug is deliberately impersonal.

Reload plugins:

```bash
/reload-plugins
```

Then run:

```bash
/copilot:setup
```

`/copilot:setup` reports whether Copilot is installed and authenticated. If Copilot is missing and npm is available, it can offer to install it for you.

If Copilot is installed but not logged in:

```bash
!copilot login
```

After install you should see the `/copilot:*` slash commands and the `copilot:copilot-rescue` subagent.

A simple first run:

```bash
/copilot:review --background
/copilot:status
/copilot:result
```

## Usage

### `/copilot:review`

Runs a read-only Copilot code review.

> [!NOTE]
> Reviews on multi-file changes can take a while. Background is generally recommended.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review. Also supports `--wait` and `--background`.

```bash
/copilot:review
/copilot:review --base main
/copilot:review --background
```

The command is read-only and will not modify any files. Background runs can be monitored with `/copilot:status` and stopped with `/copilot:cancel`.

### `/copilot:rescue`

Hands a task to Copilot through the `copilot:copilot-rescue` subagent.

Use it when you want Copilot to:

- investigate a bug
- try a fix
- continue a previous Copilot task
- take a fresh pass with a different model or effort level

> [!NOTE]
> Open-ended tasks can run for a while. Use `--background` and check back with `/copilot:status`.

Flags: `--background`, `--wait`, `--resume`, `--fresh`, `--model <name>`, `--effort <none|low|medium|high|xhigh|max>`, `--autopilot`, `--max-autopilot-continues <N>`, `--share`, `--share-path <path>`, `--share-gist`, `--mcp-tool <names>`, `--mcp-config <json|@file>`.

```bash
/copilot:rescue investigate why the tests started failing
/copilot:rescue fix the failing test with the smallest safe patch
/copilot:rescue --resume apply the top fix from the last run
/copilot:rescue --model gpt-5.4 --effort medium investigate the flaky integration test
/copilot:rescue --background investigate the regression
/copilot:rescue --autopilot --max-autopilot-continues 3 finish the refactor
/copilot:rescue --share investigate the regression and share the transcript
/copilot:rescue --mcp-tool issues,pull_requests look up the open PRs blocking this fix
```

You can also simply ask the main thread to delegate:

```text
Ask Copilot to redesign the database connection to be more resilient.
```

Notes:

- If you do not pass `--model` or `--effort`, Copilot picks its own defaults.
- Follow-up rescue requests can continue the latest Copilot session in the repo via `--resume`.
- See [Resume forms](#resume-forms) below for the full set of session-resume options.
- `--share` writes a markdown transcript at `./copilot-session-<id>.md` after the run; `--share-path <path>` overrides the location; `--share-gist` uploads to a secret GitHub gist instead. See [Sharing transcripts](#sharing-transcripts).
- `--mcp-tool` and `--mcp-config` pass through to Copilot's [MCP integration](#mcp-passthrough).

### `/copilot:status`

Shows running and recent Copilot jobs for the current repository.

```bash
/copilot:status
/copilot:status task-abc123
```

### `/copilot:result`

Shows the final stored Copilot output for a finished job. When available it includes the Copilot session ID so you can reopen the run with `copilot --resume=<id>` (see [Resume forms](#resume-forms) for other options).

```bash
/copilot:result
/copilot:result task-abc123
```

### `/copilot:cancel`

Cancels an active background Copilot job.

```bash
/copilot:cancel
/copilot:cancel task-abc123
```

### `/copilot:setup`

Checks whether the `copilot` CLI is installed and authenticated. If `copilot` is missing and npm is available, can offer to install it.

### Resume forms

Copilot CLI exposes four ways to pick up a prior session. The plugin maps to them as follows:

| Copilot flag | When it's used |
|---|---|
| `--resume=<id-or-prefix-or-name>` | What the plugin emits internally when you pass `/copilot:rescue --resume`. It always uses the stored session id from the previous tracked task. |
| `--continue` | Not used by the plugin (we always have a specific id). Useful from the bare `copilot` CLI if you want the most recent session without naming it. |
| `--connect[=sessionId]` | Connect to a *remote* session running on another machine (linked to GitHub web/mobile). The plugin does not orchestrate this directly. |
| `--session-id <uuid>` | Resume by uuid, or pre-set the uuid for a new session. The plugin lets Copilot generate ids. |

Practical tips:

- After any rescue/task, the plugin prints `Copilot session ID: <id>` and a `Resume in Copilot: copilot --resume=<id>` hint — copy that to drop into the same session from a terminal.
- `--resume`'s name match is **case-insensitive exact** against `--name`. The plugin names tracked tasks `copilot-task <first 56 chars of your prompt>`, so you can resume by quoting that name.
- `--connect` is for cross-device handoff. If you started a long-running Copilot session in your browser and want to attach from the CLI, that's the flag — outside the plugin's tracked-job lifecycle.

See [`copilot help`](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started) for the full list.

### Sharing transcripts

For any of `/copilot:review`, `/copilot:adversarial-review`, `/copilot:rescue`, and `/copilot:plan`:

| Flag | What Copilot writes |
|---|---|
| `--share` | Markdown transcript at `./copilot-session-<id>.md` (Copilot default). |
| `--share-path <path>` | Markdown transcript at the explicit path. Implies `--share`. |
| `--share-gist` | Uploads the transcript to a **secret** GitHub gist after the run. Can be combined with `--share`/`--share-path`. |

```bash
/copilot:review --share
/copilot:review --share-path reviews/2026-05-25-auth.md
/copilot:rescue --share-gist investigate the regression
```

The file write happens **after** the run completes, so the plugin's read-only contract on reviews still holds while Copilot is working — the markdown file is the only side effect, and only if you opted in.

### MCP passthrough

`/copilot:rescue` and `/copilot:plan` accept two pass-through flags that wire into Copilot's MCP integration:

| Flag | Notes |
|---|---|
| `--mcp-tool <names>` | Comma-separated list of GitHub MCP tools to enable on top of Copilot's default subset. Each name becomes a `--add-github-mcp-tool <name>` to Copilot. |
| `--mcp-config <json\|@file>` | Single additional MCP servers configuration. Either an inline JSON string or `@<path>` to a JSON file. Augments `~/.copilot/mcp-config.json` for this run only. |

```bash
/copilot:rescue --mcp-tool issues,pull_requests close the linked tickets
/copilot:plan --mcp-config @./mcp/sentry.json plan the sentry breadcrumb work
```

MCP flags are **not** exposed on `/copilot:review` and `/copilot:adversarial-review` — those commands keep their read-only contract by refusing to extend the tool surface at run time.

## How it works

The plugin wraps the GitHub Copilot CLI in non-interactive mode:

```
copilot -p "<prompt>" --output-format json --allow-all-tools [--model <m>] [--effort <e>] [--resume=<id>] [--name <session-name>] [--plan|--autopilot] [--share[=path]|--share-gist] [--add-github-mcp-tool <t>] [--additional-mcp-config <json|@file>]
```

It parses the JSONL event stream (`assistant.message`, `assistant.turn_end`, `result`, ...) to surface progress, capture the final answer, and record the Copilot `sessionId` for later resume.

State is stored under `$CLAUDE_PLUGIN_DATA/state/<workspace-slug>` so that:

- `/copilot:status` and `/copilot:result` find jobs scoped to the current repository
- Background jobs survive across slash command invocations within the same Claude session

## Configuration

This plugin does not override any Copilot configuration. If you want to set defaults (model, effort, etc.) configure them in `~/.copilot/` or via the standard Copilot environment variables — they will be picked up automatically.

## Tests

```bash
npm test
```

Runs `node --test tests/*.test.mjs`.

## Releasing

Use the bump-version script to keep `package.json`, the plugin manifest, and the marketplace manifest in sync. The full workflow — picking a semver bump, running the script, tagging, pushing — is documented in [docs/RELEASE.md](./docs/RELEASE.md).

Quick reference:

```bash
npm run version:check          # verify manifests are aligned with package.json
npm run bump-version -- 0.2.0  # bump every manifest to 0.2.0
```

## Differences from `codex-plugin-cc`

| Codex plugin | This plugin |
|---|---|
| Stop-time review gate | not in v1 |
| Codex app server (JSON-RPC) | direct `copilot -p ... --output-format json` JSONL stream |
| Built-in structured review schema | verbatim prose review |
| `spark` model alias | none — pass `--model` explicitly |
| `--write` ⇒ `workspace-write` sandbox | `--write` is a metadata flag; tools default to `--allow-all-tools` |

## License

MIT. See [LICENSE](./LICENSE).

This project is not affiliated with GitHub, OpenAI, or Anthropic. See [NOTICE](./NOTICE).
