# Session handoff — 2026-05-24 (updated)

## Current task and status

**Status:** Done. v1 MVP of `copilot-plugin-cc` is complete, tested, and documented. All 36 files are staged but **not committed**.

Last action: added a "Conceptual source" section to `CLAUDE.md` pointing future Claude instances at [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) as the reference implementation to consult before extending.

## Goal

Build a Claude Code plugin (`copilot-plugin-cc`) that wraps the **GitHub Copilot CLI** (`copilot` binary) using the same architectural pattern as [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc). Users get `/copilot:review`, `/copilot:rescue`, `/copilot:status`, `/copilot:result`, `/copilot:cancel`, `/copilot:setup` inside Claude Code.

## What was done

- Scaffolded a marketplace-style repo at `/Users/waris.c/claudecode/Claude-Copilot/copilot-plugin-cc/`
- Forked ~70% of codex-plugin-cc runtime-agnostic libs (args, state, tracked-jobs, render, process, git, fs, workspace, prompts, job-control), translated codex→copilot strings
- Wrote `plugins/copilot/scripts/lib/copilot.mjs` (~330 LOC) — spawns `copilot -p ... --output-format json` and parses the JSONL event stream (`assistant.message`, `assistant.turn_end`, `result`)
- Wrote `plugins/copilot/scripts/copilot-companion.mjs` — CLI dispatcher (slimmer than codex's: no broker/app-server plumbing)
- 6 slash commands + 1 subagent (`copilot-rescue`) + 2 skills + 1 prompt template
- 3 smoke test files (args, state, render) — **21/21 passing**
- Both repo-level `README.md` and plugin-level `plugins/copilot/README.md` (matching the official Anthropic plugins convention)
- `CLAUDE.md` (architecture map for future Claude instances) with a prominent "Conceptual source" section pointing at [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) and the local sibling clone at `../codex-plugin-cc/`
- `DESIGN.md` (codex→copilot concept mapping, decisions + omissions + next-step menu)

## Locked design decisions

- **Scope:** MVP only — setup + review + rescue + status/result/cancel. No adversarial-review, no Stop-hook gate, no spark alias.
- **Review output:** verbatim prose passthrough (no structured JSON schema).
- **Rescue permissions:** `--allow-all-tools` (required for non-interactive mode anyway).
- **License:** MIT.
- **Author/branding:** `Claude-Copilot` (org-style, no person).
- **Tests:** minimal smoke tests, not a full port of codex's test suite.
- **Storage field naming:** `threadId` retained as the canonical field name for Copilot's session id (cosmetic rename would have churned ~6 files).

See `DESIGN.md` §2 for the full reasoning behind each.

## Files touched

All under `/Users/waris.c/claudecode/Claude-Copilot/copilot-plugin-cc/`:

- Repo root: `.gitignore`, `LICENSE`, `NOTICE`, `README.md`, `package.json`, `CLAUDE.md`, `DESIGN.md`, `SESSION-HANDOFF.md`, `.claude-plugin/marketplace.json`
- Plugin: `plugins/copilot/{.claude-plugin/plugin.json, README.md}`
- Commands: `plugins/copilot/commands/{setup,review,rescue,status,result,cancel}.md`
- Agent: `plugins/copilot/agents/copilot-rescue.md`
- Skills: `plugins/copilot/skills/{copilot-cli-runtime,copilot-result-handling}/SKILL.md`
- Prompts: `plugins/copilot/prompts/review.md`
- Hooks: `plugins/copilot/hooks/` (empty dir — placeholder)
- Scripts: `plugins/copilot/scripts/copilot-companion.mjs` + `lib/{args,copilot,fs,git,job-control,process,prompts,render,state,tracked-jobs,workspace}.mjs`
- Tests: `tests/{args,state,render}.test.mjs`

`codex-plugin-cc/` (sibling directory) was read-only — used as reference, never modified.

## Assumptions

- User has Node 18.18+ and the `copilot` CLI installed (verified at v1.0.52 in this session).
- User has a GitHub Copilot subscription and is logged in (verified via macOS keychain probe).
- `$CLAUDE_PLUGIN_DATA` is set when running inside Claude Code; falls back to `os.tmpdir()/copilot-companion/` outside.
- Future Copilot CLI versions will keep emitting JSONL with the `assistant.message` + `result` event types observed today. If those change, `lib/copilot.mjs` is the only file that needs updating.

## Blockers

None.

## Commands run

- `npm test` (= `node --test tests/*.test.mjs`) → **21 pass / 0 fail**
- `node plugins/copilot/scripts/copilot-companion.mjs help` → prints usage
- `node plugins/copilot/scripts/copilot-companion.mjs setup` → reports ready: copilot v1.0.52, auth via macOS keychain
- `node plugins/copilot/scripts/copilot-companion.mjs status` → "No jobs recorded yet"
- `copilot -p "respond with just the word hello" --output-format json --allow-all-tools --no-color` (used to discover the JSONL event schema)

## Tests done vs not done

**Done (unit/smoke):**
- `args.test.mjs` — arg parser including alias map, value options, passthrough, escape handling
- `state.test.mjs` — job upsert/list, config set/get, generateJobId uniqueness
- `render.test.mjs` — review/setup/task/stored-job/cancel renderers

**Not done (deliberate v1 omission):**
- No integration test against the real `copilot` binary
- No end-to-end `/copilot:review` test from a Claude Code session
- No background-job lifecycle test
- No cross-platform auth detection test (only macOS keychain path verified)

See `DESIGN.md` §5 item 1 for the integration test design.

## Remaining work (none for v1)

Nothing for v1. Future iterations are enumerated in `DESIGN.md` §5 "Next-step menu" in rough priority order:

1. Integration smoke test against real `copilot`
2. `/copilot:adversarial-review`
3. Liveness sweep for orphan background jobs
4. Linux/Windows auth detection
5. Plugin-level model/effort defaults
6. Post-run summary of touched files in `/copilot:rescue`
7. Marketplace publish + bump-version script

## Next steps

For the next Claude Code session, in order:

1. Read `CLAUDE.md` (architecture map + "Conceptual source" section pointing at [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc)) and `DESIGN.md` (decisions + open items) before touching anything.
2. If asked to commit: `git add -A` (already done — 36 files staged) → `git commit` with a message summarizing the v1 MVP build.
3. If asked to extend: pick from the `DESIGN.md` §5 menu. Each item names the files to start from. Always cross-reference the codex-plugin-cc sibling clone at `../codex-plugin-cc/plugins/codex/` before designing — most patterns already exist there.
4. If `copilot` CLI changes: re-probe with `copilot -p "ping" --output-format json --allow-all-tools --no-color` and diff against the `describeEvent()` switch in `lib/copilot.mjs`.

## Important context

- This project sits as a sibling of `codex-plugin-cc/` (a fully-built reference implementation for OpenAI Codex). When in doubt about a design pattern, check the codex version first — most of our architecture is a direct port.
- The user's name in `package.json` / `plugin.json` is `Claude-Copilot` (org-style placeholder), not the user's personal name or email. They explicitly chose this in the DIF round.
- The `code-review-graph` build hook may have created a `.code-review-graph/` directory at the repo root — it's in `.gitignore`.
- All work happened in DIF→JDI mode following the user's AI Working Rules (see `~/.claude/CLAUDE.md`).
