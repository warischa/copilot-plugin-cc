# Design notes

Living document for future iterations of `copilot-plugin-cc`. Records what we built, why we chose it, and what's intentionally **not** in v1 so the next pass can pick the right thing to work on.

---

## 1. Origin and concept mapping

This plugin is a **fork of the architecture** of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) — re-pointed at the GitHub Copilot CLI (`copilot` binary) instead of the OpenAI Codex CLI.

### Codex → Copilot mapping

| Codex piece | Copilot CLI equivalent | Notes |
|---|---|---|
| `codex` binary | `copilot` | direct swap |
| Codex **app server** (JSON-RPC over stdio) | **None.** Copilot exposes `--output-format json` (JSONL stream) | Biggest divergence — we dropped the entire broker/app-server abstraction |
| Built-in `/review` command with structured `ReviewOutput` schema | **None.** | We prompt-engineer review and accept prose output |
| `codex resume <session-id>` / `--resume-last` | `copilot --resume=<id\|name\|prefix>` / `copilot --continue` | Close enough |
| Reasoning effort `none/minimal/low/medium/high/xhigh` | `--effort low/medium/high/xhigh` | Dropped `none` and `minimal` |
| `--write` (codex autonomy) | `--allow-all-tools` / `--yolo` / `--autopilot` | We picked `--allow-all-tools` |
| `~/.codex/config.toml` | `~/.copilot/` | Plugin doesn't read either — Copilot picks up its own config |
| Auth (ChatGPT / API key) | `copilot login` (GitHub OAuth) + env vars | Different auth model, same UX |

### What was reused vs rewritten

Roughly **70% of codex-plugin-cc was reused** as runtime-agnostic infrastructure:

- `args.mjs`, `fs.mjs`, `process.mjs`, `prompts.mjs`, `git.mjs` — copied as-is
- `state.mjs`, `workspace.mjs`, `tracked-jobs.mjs`, `render.mjs`, `job-control.mjs` — copied with cosmetic edits (codex→copilot strings, `/codex:` → `/copilot:`, dropped `getSessionRuntimeStatus`)
- `prompts/review.md` — written from scratch (codex used a built-in reviewer)
- Slash commands + subagent — same shape, retargeted
- `tests/*.test.mjs` — minimal new smoke tests (we did not port codex's full test suite)

The genuinely new code is `lib/copilot.mjs` (~330 LOC) plus a slimmer `copilot-companion.mjs` (no broker/app-server plumbing).

---

## 2. Design decisions and tradeoffs

### 2.1 Verbatim prose review (vs structured JSON schema)

**Decision:** `/copilot:review` returns Copilot's natural-language review as-is.

**Why:** Codex's app server emits a typed `ReviewOutput`. Copilot has no equivalent — schema enforcement would have to be done via prompt + brittle JSON parsing. Verbatim passthrough matches the codex plugin's "return stdout as-is" cardinal rule.

**Tradeoff:** Findings aren't machine-parseable. Future tooling that wants to aggregate findings across multiple reviews can't rely on a fixed shape.

**Future:** If schema is wanted, add a `--json` mode that re-prompts Copilot with a strict JSON envelope and parses leniently (fallback to prose on parse failure).

### 2.2 `--allow-all-tools` default

**Decision:** Rescue and review both pass `--allow-all-tools`.

**Why:** Copilot's `-p` non-interactive mode requires it — otherwise the agent blocks on tool confirmation forever. For review we additionally pass `--deny-tool=write,edit,shell` to prevent mutation.

**Tradeoff:** The deny list is best-effort — tool names may change in future Copilot versions. We have no programmatic way to confirm review didn't write.

**Future:**
- Audit the actual Copilot tool registry once and pin a deny list per Copilot version
- Consider `--autopilot --max-autopilot-continues N` for rescue (bounded autonomy)

### 2.3 No JSON-RPC broker / shared runtime

**Decision:** Each `/copilot:*` invocation spawns a fresh `copilot` process.

**Why:** Copilot has no daemon/RPC mode. The codex plugin's broker is solving a problem we don't have.

**Tradeoff:** Slight per-invocation startup cost (Copilot CLI cold-start). MCP server warmup happens every time.

**Future:** If Copilot adds a long-running mode (e.g. ACP server via `--acp`), wrap that here for faster turn cycles.

### 2.4 `threadId` field name retained for Copilot's session id

**Decision:** Storage field is `threadId` (matches codex storage). User-facing strings say "Copilot session ID".

**Why:** Keeps `state.mjs`, `tracked-jobs.mjs`, `job-control.mjs`, `render.mjs` near-identical to the codex versions — porting was mechanical. Renaming would have added churn across ~6 files with no functional benefit.

**Tradeoff:** Future readers may be confused that "thread" refers to a Copilot session.

**Future:** If we diverge further from codex, rename storage field to `sessionId` and update the rendering layer.

### 2.5 Workspace-scoped state in `$CLAUDE_PLUGIN_DATA`

**Decision:** State directory is `$CLAUDE_PLUGIN_DATA/state/<basename>-<sha256-prefix>/`.

**Why:** Same as codex. Job state should be per-repo, plugin-managed, and survive across Claude Code sessions within the same plugin install.

**Tradeoff:** If `$CLAUDE_PLUGIN_DATA` isn't set (running outside Claude Code), state falls back to `os.tmpdir()/copilot-companion/` — non-persistent.

### 2.6 Background workers via detached subprocess

**Decision:** `--background` spawns `node copilot-companion.mjs task-worker --job-id <id>` as a detached child with `stdio: "ignore"`.

**Why:** Same model as codex. Avoids needing a daemon. The worker re-loads the stored job request from disk, so the parent can exit immediately.

**Tradeoff:** No structured IPC. If the worker crashes hard (segfault, OOM kill), the job record stays in `running` state until the user observes it. There's no liveness check yet.

**Future:**
- Periodic liveness sweep (process `kill -0 <pid>`) that flips dead-running jobs to `failed` with reason
- Or: signal-based cleanup hook

### 2.7 Project identity uses `Claude-Copilot` as a placeholder namespace

**Decision:** The marketplace slug (`name: "claude-copilot"` in `.claude-plugin/marketplace.json`), owner/author fields (`Claude-Copilot`), and npm-style scoped package name (`@claude-copilot/copilot-plugin-cc`) are an intentional **impersonal placeholder** — they do **not** correspond to a GitHub organization. The actual source repo lives under the personal account [`warischa/copilot-plugin-cc`](https://github.com/warischa/copilot-plugin-cc).

**Why:** v1 was bootstrapped as a port of `openai/codex-plugin-cc` and the manifests were authored before we knew whether a real `Claude-Copilot` GH org would exist. Keeping the slug impersonal lets the project move to a real org later without renaming the marketplace identity (which would force every existing install to break and re-add).

**Tradeoff:** There's a permanent mismatch between the marketplace identity and the GH repo URL. Users installing via `/plugin marketplace add warischa/copilot-plugin-cc` then `/plugin install copilot@claude-copilot` see two different names and may assume one is wrong.

**Future:**
- If a real `Claude-Copilot` GH org gets created, move the repo (`gh api -X POST /repos/warischa/copilot-plugin-cc/transfer -f new_owner=Claude-Copilot`) and update the git remote. The manifests stay as-is. Existing installs keep working.
- If we decide the project is staying personal, rename in one batch: marketplace slug → `warischa`, owner/author → real name, scoped package → `@warischa/copilot-plugin-cc`, README install command updated. This breaks existing installs.

### 2.8 Auth detection without burning a request

**Decision:** Auth check uses (in order): env var presence (`COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`), macOS keychain probe (`security find-generic-password -s copilot-cli`), then plaintext fallback files.

**Why:** Running `copilot -p "ok"` to test auth costs a premium request. The probe above is free.

**Tradeoff:** macOS-only keychain probe; non-mac users without env vars will see "not authenticated" even if `copilot login` actually worked into the OS credential store on Linux/Windows.

**Future:** Add Linux Secret Service probe + Windows Credential Manager probe, or accept "unknown — try a command" as the result.

---

## 3. Deliberate omissions from v1

These are **not bugs** — they were scoped out. Pick up here if extending.

| Feature | Codex has it? | Why we skipped | When to add |
|---|---|---|---|
| `/copilot:adversarial-review` | yes | Review prompt template already covers steerable review via prose extension; adversarial framing can be a second prompt template | When users repeatedly want "challenge this design" framing distinct from normal review |
| Stop-hook review gate (`hooks/hooks.json`) | yes | Complex, burns premium requests, easy to get into a loop | When you have a clear policy for blocking vs allowing stop |
| `spark` model alias | yes (`gpt-5.3-codex-spark`) | No Copilot equivalent fast model | When Copilot publishes a tier name worth aliasing |
| Structured `ReviewOutput` JSON schema | yes | See 2.1 | When downstream tooling needs aggregation |
| Reasoning summaries surfaced separately | yes (codex captures `reasoning` events) | Copilot emits `assistant.reasoning` events too — we log them but don't render | When reasoning is genuinely useful in the rendered output |
| Subagent-to-subagent collaboration tracking | yes (codex tracks `collabAgentToolCall`) | Copilot's CLI doesn't appear to expose this in JSONL | Once Copilot exposes a comparable event |
| Full test suite ported (broker, runtime, fake-fixture) | yes (~8 test files) | MVP only needs args/state/render smoke tests | Before any major rewrite |
| Bump-version script + release tooling | yes (`scripts/bump-version.mjs`) | No release pipeline yet | When publishing to a public marketplace |

---

## 4. Known gotchas

- **`copilot --output-format json` JSONL is event-only.** There is no final "here's the structured answer" record. The final assistant message comes from the **last** `assistant.message` event with `phase: "final_answer"`. Capture it as you see it.
- **`result` event is the closer.** It carries `sessionId`, `exitCode`, and `usage`. Treat it as authoritative for exit status — the child's exit code is sometimes 0 when `result.exitCode` is non-zero.
- **MCP server warmup floods the JSONL stream.** Many `session.mcp_server_status_changed` events arrive before the prompt even starts. The describer in `lib/copilot.mjs` filters them out of progress output.
- **`copilot -p` does not honor `--no-banner`** (and rejects it). We use `--no-color` and `--no-auto-update` instead.
- **Models change.** Don't hardcode model names anywhere. Pass user-supplied `--model` through verbatim.
- **`--allow-all-tools` is mandatory for non-interactive mode.** Documented in Copilot's own help text but easy to miss.
- **PID reuse blindspot in `lib/job-liveness.mjs`.** The sweep uses `process.kill(pid, 0)` to check liveness. If the OS reuses a dead worker's pid for an unrelated process, the sweep sees "alive" and won't flip the orphan record. The mitigation, when needed, is an age threshold on `startedAt` — a ~5-line addition in `sweepDeadJobs`. Not done in v1.
- **Every `npm test` spends one Copilot API call.** `tests/integration.test.mjs` auto-skips when copilot isn't installed/authed, but on dev machines that *are* authed, the suite runs a real prompt every time (~14s, costs one Copilot turn). If this becomes friction, gate behind `COPILOT_INTEGRATION=1` in the test's `before()` block.
- **Windows cmdkey target format is `copilot-cli/<api-url>:<github-account>`.** Verified on a real Windows host; `parseCmdKeyOutput` is tested against the verbatim line. GitHub Enterprise should work without changes — the regex matches `https://ghe.example.com:user` the same way.

---

## 5. Next-step menu

Items 1–6 shipped in 0.1.1. Item 7 split into 7a (bump-version, shipped) and 7b (publish-release wrapper, shipped in 0.3.0-dev). Every "Optional follow-up" then shipped in 0.2.0.

1. **[x] Integration smoke test against the real `copilot` binary** — `f556d9d`. `tests/integration.test.mjs` spawns the companion with a 1-line prompt, asserts the JSONL parse path captures the final answer, and verifies `result.sessionId` persists to the stored job file. **As of 0.2.0** opt-in via `COPILOT_INTEGRATION=1` instead of auto-running.
2. **[x] `/copilot:adversarial-review`** — `0d3cd6f`. New prompt template + companion subcommand + slash command. Reuses the regular review's deny-tools + renderer, so review and adversarial-review share one pipeline. **As of 0.2.0** the prompt's attack-surface list is rebalanced toward broader buckets (correctness edge cases, perf, DX) instead of front-loading enterprise framing.
3. **[x] Liveness sweep for orphan background jobs** — `6cae525`. `lib/job-liveness.mjs` exports `isProcessAlive(pid)` and `sweepDeadJobs(workspaceRoot)`. **As of 0.2.0** the sweep result is surfaced in `/copilot:status` as a one-line `Swept N orphan job(s) (id, ...)` notice, and `sweepDeadJobs` has a `maxRunningAgeMs` option (default 6h) that flips suspected PID-reuse jobs even when the recorded pid still resolves.
4. **[x] Linux/Windows auth detection** — `2e2d87e` (+ Windows regression `753f163`). Injectable `platform` / `runCommand` / `binaryAvailable` options for cross-platform testability.
5. **[x] Plugin-level model/effort defaults** — `d9ed30a`. `~/.claude/plugins/copilot/config.json`. **As of 0.2.0** the schema also accepts `denyTools`, `addDirs`, and `defaultPromptFile` (the first two are wired through `applyPluginDefaults`; `defaultPromptFile` is validated but not yet consumed). Reviews always keep the baseline `write,shell` deny list (was `write,edit,shell` — `edit` dropped in 0.3.1 because Copilot has no such tool, see post-port-review below) and merge plugin-config additions on top. **As of 0.4.0** the schema also accepts `redactSummary: boolean` for privacy-conscious users.
6. **[x] Touched-files summary on `/copilot:rescue`** — `f95b485`. **As of 0.2.0** the inline cap is a 160-char budget + 12-entry hard ceiling (was a fixed count of 5); a pathologically long path always shows at least one entry.
7. **Marketplace publish + bump-version script.**
   - **[x] `scripts/bump-version.mjs`** — `c786dd0`. Full release flow documented in `docs/RELEASE.md`. Validated end-to-end by cutting `v0.1.1` and `v0.2.0`.
   - **[x] `scripts/publish-release.mjs`** — thin wrapper that chains `bump-version` → `npm test` → `git add` (manifest files only) → `git commit` → `git tag -a` → `git push --follow-tags` → `gh release create`. `--dry-run`, `--skip-tests`, `--skip-push`, `--skip-gh-release`, `--allow-dirty`, `--branch`, `--remote` flags. Pure pieces (`parseArgs`, `buildSteps`, `preflightChecks`, `createRunner`) exported for unit testing — the test suite never spawns real `git` / `npm` / `gh`. Stages exactly the three manifest files (never `git add -A`) and refuses to start on a dirty tree or off-branch HEAD unless explicitly overridden. Closes the §5.7b scope question.

### Post-port review (0.3.1 + 0.4.0)

After running a real end-to-end test against Copilot CLI 1.0.52 and reading the official docs ([getting started](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started), [best practices](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-best-practices)), three codex-era assumptions surfaced as real bugs and three Copilot-native features were missed. Shipped:

- **[x] B1 / 0.3.1** — `getJobKindLabel` no longer collapses every non-review jobClass into `"rescue"`. The default branch was a dead codex artifact. Switch over the full set; fall back to the jobClass string when unknown. (Commit on `main` post-`v0.3.0`.)
- **[x] B2 / 0.3.1** — Dropped `"edit"` from `REVIEW_BASELINE_DENY_TOOLS`. Copilot has no such tool; the token was silently ignored. Baseline is now `["write", "shell"]`.
- **[x] B3 / 0.3.1** — `getCopilotAvailability` now keeps only the first non-empty line of `copilot --version`, dropping the "Run 'copilot update'…" advisory that recent CLI versions append.
- **[x] D1 / 0.4.0** — `effort` accepts the full Copilot set (`none|low|medium|high|xhigh|max`), not just the codex-era `low|medium|high|xhigh`.
- **[x] D3 / 0.4.0** — `detectInstructionsFiles` probes the documented Copilot custom-instructions paths (`~/.copilot/copilot-instructions.md`, `.github/copilot-instructions.md`, `.github/instructions/*.instructions.md`, `AGENTS.md`, `Copilot.md`, `GEMINI.md`, `CODEX.md`) and `/copilot:setup` lists what's auto-loaded. Plugin README documents the precedence rules.
- **[x] U1 / 0.4.0** — Suppress `Phase: done` when status is `completed` (and the analogous redundant pairs for `failed`/`cancelled`). New `isRedundantPhase` helper in `lib/render.mjs`.
- **[x] U2 / 0.4.0** — New `redactSummary` plugin-config flag. When `true`, stored task summaries show `[summary redacted]` instead of the first ~96 chars of the prompt. Default `false` (no behavior change for existing users); documented in README under "Plugin config" with the privacy rationale.

### Agentic upgrade (0.5.0)

After 0.4.0, three Copilot-native features remained on the table. Shipped in 0.5.0:

- **[x] D5** — New `/copilot:plan` slash command and `plan` companion subcommand. Runs Copilot with `--plan` to produce a structured implementation plan with no code edits. Defense-in-depth deny list (`write`, `shell`). Job tracking integrates with `/copilot:status` / `/copilot:result` via a new `jobClass: "plan"` and `kindLabel: "plan"`. Background path supported via worker-side dispatch on `request.jobClass`. Smoke-tested against Copilot CLI 1.0.52 end-to-end (32s round-trip on a short prompt).
- **[x] D6** — `/copilot:task` (and `/copilot:rescue`) gained `--autopilot` and `--max-autopilot-continues <N>`. `parsePositiveInteger` helper validates the count; passing `--max-autopilot-continues` without `--autopilot` errors out explicitly instead of being silently dropped.
- **[x] D8** — `/copilot:adversarial-review` gained `--no-custom-instructions` for fresh-eyes reviews that bypass `AGENTS.md` / repo conventions.

The new flags flow through one place — `buildCopilotArgs` in `lib/copilot.mjs` — which is now exported and has direct unit-test coverage for every combination (plan-vs-autopilot mutual exclusion, autopilot continues guard, no-custom-instructions opt-in).

Also fixed a missed-in-0.4.0 bug: the companion's `VALID_REASONING_EFFORTS` set was out of sync with the plugin-config one (still rejected `none` and `max`). Synced both to the full Copilot set.

Deferred items still on the menu:

- **[ ] D2** — Verify whether `COPILOT_GITHUB_TOKEN` env var is real. Not in docs; harmless to keep as a probe.
- **[ ] D4** — Document the full resume forms (`--resume=<name>`, `--connect=<sessionId>`) in plugin README.
- **[ ] D7** — `--share` option on review for markdown export. Low priority.
- **[ ] D9** — MCP plumbing (`--add-github-mcp-tool`, `--additional-mcp-config`). Tracked for a future release.
- **[ ] U3** — Route `[copilot] ...` progress lines to stderr instead of stdout. Low priority.

### Optional follow-ups — all shipped in 0.2.0

- **[x] Cut a `0.1.1` patch release** — done. Tag `v0.1.1`, commit `028aa6e`. Exercised the new `bump-version` flow end-to-end.
- **[x] CI workflow** — `2074121`. `.github/workflows/ci.yml` runs `version:check` + `npm test` on push/PR across Node 20/22 × Linux/macOS/Windows.
- **[x] `COPILOT_INTEGRATION=1` gate** — `2074121`. Integration test is now opt-in.
- **[x] Tune the adversarial-review prompt voice** — `912c8f1`. Pure prompt rewrite.
- **[x] Extend the plugin-config schema** — `a9be2a5`. See item 5 above.
- **[x] Surface liveness sweep count in `/copilot:status`** — `c5303bc`. See item 3 above.
- **[x] Rebalance touched-files inline cap** — `912c8f1`. See item 6 above.
- **[x] Age threshold for liveness sweep** — `c5303bc`. See item 3 above.
- **[~] Linux real-host auth verification.** Probe list is best-effort and hasn't been confirmed on a real Linux box. Not on the roadmap — maintainer doesn't use Linux. If a user reports it broken, the fix is one string in `COPILOT_SECRET_SERVICES`.
- **[x] Cut `0.2.0`** — `86e1a02`. Tag `v0.2.0`. Carried the breaking Node-floor bump from 18.18 → 20.0.

---

## 6. Layout reference

```
copilot-plugin-cc/
├── .claude-plugin/marketplace.json     # marketplace wrapper (one plugin: "copilot")
├── plugins/copilot/
│   ├── .claude-plugin/plugin.json      # plugin metadata
│   ├── README.md                       # plugin-level user docs
│   ├── commands/                       # slash-command markdown (thin shells)
│   ├── agents/copilot-rescue.md        # rescue subagent
│   ├── skills/                         # internal contracts (cli-runtime, result-handling)
│   ├── prompts/review.md               # review prompt template
│   ├── hooks/                          # (empty in v1 — placeholder for Stop gate)
│   └── scripts/
│       ├── copilot-companion.mjs       # CLI dispatcher
│       └── lib/                        # runtime libs (args, state, copilot, git, render, ...)
├── tests/                              # node:test smoke tests
├── README.md                           # repo-level dev/install docs
├── CLAUDE.md                           # guidance for future Claude Code instances
├── DESIGN.md                           # this file
├── LICENSE                             # MIT
├── NOTICE                              # attribution
└── package.json                        # type=module, node ≥20.0.0
```

See `CLAUDE.md` for the "what to touch when extending" map.
