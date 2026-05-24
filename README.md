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

Flags: `--background`, `--wait`, `--resume`, `--fresh`, `--model <name>`, `--effort <low|medium|high|xhigh>`.

```bash
/copilot:rescue investigate why the tests started failing
/copilot:rescue fix the failing test with the smallest safe patch
/copilot:rescue --resume apply the top fix from the last run
/copilot:rescue --model gpt-5.4 --effort medium investigate the flaky integration test
/copilot:rescue --background investigate the regression
```

You can also simply ask the main thread to delegate:

```text
Ask Copilot to redesign the database connection to be more resilient.
```

Notes:

- If you do not pass `--model` or `--effort`, Copilot picks its own defaults.
- Follow-up rescue requests can continue the latest Copilot session in the repo via `--resume`.

### `/copilot:status`

Shows running and recent Copilot jobs for the current repository.

```bash
/copilot:status
/copilot:status task-abc123
```

### `/copilot:result`

Shows the final stored Copilot output for a finished job. When available it includes the Copilot session ID so you can reopen the run with `copilot --resume=<id>`.

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

## How it works

The plugin wraps the GitHub Copilot CLI in non-interactive mode:

```
copilot -p "<prompt>" --output-format json --allow-all-tools [--model <m>] [--effort <e>] [--resume=<id>] [--name <session-name>]
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
