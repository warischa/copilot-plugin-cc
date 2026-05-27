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

### 2.9 Test-coverage delegation, model routing, and export-for-testability

**Decision:** Unit tests are written by delegating one scoped test file per Copilot CLI agent (run through the companion `task` path), with the lead agent (Claude) owning architecture, invariant-critical tests, verification, and commit gating. Internal functions are `export`ed when needed purely to make them unit-testable (e.g. `describeEvent`, `captureFinalAnswer` on 2026-05-27), provided the export is additive and behavior-neutral.

**Model routing:** delegated jobs are routed by complexity — 1× models (`gpt-5.4`, `claude-sonnet-4.6`) for deterministic, verifiable work; premium tiers (`claude-opus-4.6` 3×, `gpt-5.5` 7.5×, `claude-opus-4.7` 15×) reserved for ambiguous reasoning or debugging. `--model <slug>` passes through `buildCopilotArgs` verbatim (see §4 "Models change"); Copilot rejects invalid slugs at startup, so a clean exit means the slug was accepted.

**Why:** the `node --test` gate is the quality backstop, so a cheap model + verify-loop beats an expensive model for codegen. **Evidence:** a controlled 1×-vs-3× A/B on `collectReviewContext` (2026-05-27) showed the 3× model produced no better tests than the 1× — the 1× file was richer. The multiplier did not earn itself for verifiable test-writing.

**Convention carrier:** repo test conventions live in `.github/copilot-instructions.md` (auto-loaded by Copilot in-repo per `detectInstructionsFiles`), not in per-prompt boilerplate — a 3-sentence work order then produces convention-correct tests.

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
- **Test path assertions must mirror the implementation's `path` API, never hardcode separators.** `ensureAbsolutePath` uses `path.resolve`; a delegated test that asserted against `path.join` and a literal `/a/b` passed on macOS but failed on windows-latest/Node 22 (drive-letter prepend + backslashes). Caught by CI 2026-05-27, not by the local run. Rule for fixtures: build expectations with the same `path.resolve`/`path.join` the code uses, and never assert a hardcoded POSIX path. Recurrence of the 0.2.0 Windows path-fragility lesson — **CI (Node 20/22 × 3 OS) is the cross-platform gate, local macOS green is not sufficient.**

---

## 5. Next-step menu

Items 1–6 shipped in 0.1.1. Item 7 split into 7a (bump-version, shipped) and 7b (publish-release wrapper, shipped in 0.3.0). Every "Optional follow-up" then shipped in 0.2.0. The post-port review buckets (B1–B3 in 0.3.1, D1+D3+U1+U2 in 0.4.0, D5+D6+D8 in 0.5.0, D2+D4+D7+D9+U3 in 0.6.0) are documented below.

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

### Menu completion (0.6.0)

Every deferred D-/U- item from the post-port menu is now closed. The five remaining buckets (D2, D4, D7, D9, U3) shipped together in 0.6.0 after a fresh probe of `copilot --help` and `copilot help environment` against Copilot CLI 1.0.52 confirmed the documented forms.

- **[x] D2 / 0.6.0** — `COPILOT_GITHUB_TOKEN` is real. `copilot help environment` explicitly documents `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN` (in that precedence order). Added a citation comment in `lib/copilot.mjs` so the next reader doesn't re-litigate.
- **[x] D4 / 0.6.0** — Resume forms documented in plugin README. Copilot supports `--resume[=value]` (id / id-prefix / task id / case-insensitive name), `--continue`, `--connect[=sessionId]` (remote handoff), and `--session-id <uuid>`. The plugin always emits `--resume=<sessionId>`; the README "Resume forms" table explains the rest so power users know what's available from the bare `copilot` CLI.
- **[x] D7 / 0.6.0** — `--share` / `--share-path <path>` / `--share-gist` pass through to Copilot on `/copilot:review`, `/copilot:adversarial-review`, `/copilot:rescue`, and `/copilot:plan`. `--share-path` implies `--share` and emits `--share=<path>` exactly once (suppressing the bare `--share` to avoid double-emission). All routed through `buildCopilotArgs` so the surface is unit-testable in one place.
- **[x] D9 / 0.6.0** — MCP pass-through on `/copilot:rescue` and `/copilot:plan` only. `--mcp-tool <names>` takes a comma-separated list and emits one `--add-github-mcp-tool` per entry. `--mcp-config <json|@path>` is a single value that becomes `--additional-mcp-config`. Reviews and adversarial-reviews intentionally do **not** accept these — extending the tool surface at run time would break the read-only contract enforced by `REVIEW_BASELINE_DENY_TOOLS`.
- **[x] U3 / 0.6.0** — Both `[copilot] ...` writers (`createProgressReporter` in `tracked-jobs.mjs`, `reportPluginConfigWarnings` in `plugin-config.mjs`) already write to `process.stderr`. Verified during the 0.6.0 sweep; no code change needed, marker flipped to closed.

Future post-port discoveries (when Copilot CLI ships new flags or renames existing ones) should be appended below as a new dated bucket rather than mutating the closed entries above.

### Polish bucket (0.7.0)

A re-probe of `copilot --help` against Copilot CLI 1.0.52 (still the latest at 2026-05-26) found no new upstream flags — but the menu surfaced a list of *unused-but-available* flags that round out the plugin's coverage. Three buckets shipped together in 0.7.0:

- **[x] A / 0.7.0** — Privacy + non-stalling defaults. `buildCopilotArgs` now always emits `--no-remote` and `--no-ask-user` for non-interactive runs. **Rationale:** the plugin is local — nobody opted into a remote handoff, and the agent shouldn't stall on `ask_user` when JSONL stdin is closed. Escape hatches `--allow-remote` and `--allow-ask-user` suppress the corresponding `--no-*` flag for users who deliberately want those behaviors back (e.g., long-running rescue sessions kept reachable from mobile, or workflows that explicitly *want* the agent to surface questions).
- **[x] B / 0.7.0** — Symmetric allow/deny pass-through on **all four** agent commands: `--allow-tool <pats>`, `--allow-url <pats>`, `--deny-url <pats>`. Comma-list form parsed via existing `parseCommaSeparatedList`. Each entry forwards as a separate `--allow-tool=<pat>` / `--allow-url=<pat>` / `--deny-url=<pat>` to Copilot (space-less form matching our existing `--deny-tool=<pat>` style). **Invariant preserved at the Copilot CLI level:** per `copilot help permissions`, denial rules always take precedence over allow rules — including `--allow-all-tools`. So `--allow-tool=shell` on a review is a no-op against the baseline `--deny-tool=write,shell`. This is why B can ship on reviews too without violating the read-only contract from §2.1, contrary to D9's tighter rescue-only scope.
- **[x] C / 0.7.0** — `--attachment <paths>` pass-through on `/copilot:rescue` only. Comma-separated list of file paths (resolved against cwd); each path validated to be an existing file at parse time so users get a clean error before Copilot is invoked. Not exposed on review/adversarial-review/plan — those operate on the diff or a prompt, not arbitrary inputs.

Implementation gate: every flag was re-verified against `copilot --help` on the installed binary before code landed, following the standard from 0.3.1/0.4.0. All flag-emission logic lives in one place (`buildCopilotArgs` in `lib/copilot.mjs`); the companion's job is parsing + validation + threading. Unit tests in `companion-helpers.test.mjs` cover all three buckets (`buildCopilotArgs (A …)`, `buildCopilotArgs (B …)`, `buildCopilotArgs (C …)`, `parseAttachmentPaths`).

### Security trifecta (0.8.0)

A re-probe of `copilot --help` against Copilot CLI 1.0.52 (still the latest at 2026-05-26 — same binary version as the 0.7.0 ship) found **zero upstream drift**. The win came from auditing `buildCopilotArgs` against the help output rather than only the docs: one *missed* flag (`--secret-env-vars`, security-relevant) plus two *latent* gaps where the code accepted an option that the CLI surface never exposed. Three buckets shipped together in 0.8.0:

- **[x] E1 / 0.8.0** — `--secret-env <vars>` on **all four** agent commands. Comma-list parsed via existing `parseCommaSeparatedList`; each entry forwards as `--secret-env-vars=<name>` to Copilot. **What Copilot does with it:** per `copilot help environment`, the *values* of the named env vars are stripped from shell and MCP server environments at the boundary and redacted from output (variable *names* still appear in logs). Defense-in-depth on top of the permissions model — even when a tool is allowed and inherits env, Copilot scrubs the value before the child process can read or echo it. Wired on all four commands intentionally: a review tool reading `$OPENAI_API_KEY` and quoting it in analysis is exactly the leak case this blocks.
- **[x] E2 / 0.8.0** — `--no-auto-update` was already always-emitted but lacked the escape-hatch pattern from 0.7.0. Refactored to be gated by `!options.allowAutoUpdate`; `--allow-auto-update` exposed on all four agent commands suppresses the `--no-*` emission. **Why lock by default:** mid-run binary upgrades change behavior under us. Each plugin release is validated against a specific Copilot CLI version; auto-update would silently swap that out between the `--version` probe and the `-p` execution.
- **[x] E3 / 0.8.0** — `--session-name <name>` exposes the previously-internal `options.sessionName` at the CLI surface on all four agent commands. Tasks and plans already used `buildPersistentTaskSessionName()` to auto-generate `copilot-task <excerpt>`-style names; the user override now takes precedence on fresh runs (resume runs keep the existing session's name, ignoring the override). Reviews — which previously didn't set a `sessionName` at all — now accept it too. Enables `copilot --resume="<name>"` from the bare CLI later.

Implementation gate: same standard as 0.6.0/0.7.0 — every flag verified against `copilot --help` on the installed binary, every flag goes through `buildCopilotArgs`, every flag gets unit coverage. Unit tests in `companion-helpers.test.mjs` cover all three buckets (`buildCopilotArgs (E1 secret-env-vars …)`, `buildCopilotArgs (E2 auto-update lock …)`, `buildCopilotArgs (E3 sessionName …)`).

**Audit-vs-probe lesson:** the 0.8.0 finding loop was *re-probe `copilot --help` → audit `buildCopilotArgs` source against it → find both missed flags and latent gaps*. The audit channel turned up two of three wins this round (`allowAutoUpdate` escape hatch, `sessionName` exposure) even though the upstream-drift channel was dry. Future post-port discoveries should run both passes, not just the probe.

### Test-coverage expansion (2026-05-27)

Not a release — a test-hardening session run as a lead-agent-delegating-to-Copilot exercise. No version tag. 180 → 306 tests (+126), 0 fail, CI green on Node 20/22 × Linux/macOS/Windows.

- **[x] Export event-stream parsers** — `describeEvent` + `captureFinalAnswer` made `export` in `lib/copilot.mjs` (additive, behavior-neutral) so the JSONL parser is directly unit-tested. `tests/event-stream.test.mjs` (16). See §2.9.
- **[x] Cover 7 previously-untested `lib/` modules** — new files for `git` review-target resolution + `collectReviewContext`, `job-control`, `tracked-jobs`, `fs`, `prompts`, `workspace`. All written by delegated Copilot agents and verified against the suite before commit.
- **[x] `.github/copilot-instructions.md`** — repo conventions auto-loaded by Copilot in-repo; carries ESM/node:test/temp-dir rules + invariants. Proven by producing clean tests from a 3-sentence prompt.
- **[x] Coverage workflow** — `node --test --experimental-test-coverage` is the measurement of record (test count ≠ coverage; it surfaced a silently-dropped task).
- **[x] Model-routing A/B** — 1× vs 3× on `collectReviewContext`; the 3× model did not beat 1×. See §2.9.
- **[x] Windows path-fragility fix** — `fs.test.mjs` `ensureAbsolutePath` (see §4).
- **[ ] Integration tier (pending).** Orchestration surfaces remain low-coverage and need subprocess/integration harnesses, not unit tests: `copilot-companion.mjs` `main()` dispatch (~14%), `render.mjs` (~52%), `tracked-jobs.runTrackedJob`, `collectReviewContext` deeper branches, `process.mjs` (~33%).

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
