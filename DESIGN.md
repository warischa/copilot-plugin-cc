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

### 2.7 Auth detection without burning a request

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

Items 1–6 shipped in the 2026-05-24 follow-up session. Item 7 was split — bump-version landed; marketplace publish is the only remaining v1.x extension.

1. **[x] Integration smoke test against the real `copilot` binary** — `f556d9d`. `tests/integration.test.mjs` spawns the companion with a 1-line prompt, asserts the JSONL parse path captures the final answer, and verifies `result.sessionId` persists to the stored job file. Auto-skips when copilot is unavailable or unauthenticated.
2. **[x] `/copilot:adversarial-review`** — `0d3cd6f`. New prompt template + companion subcommand + slash command. Frames Copilot adversarially ("break confidence in the change, not validate it"), accepts positional focus text via `{{USER_FOCUS}}`. Reuses the regular review's deny-tools + renderer, so review and adversarial-review share one pipeline.
3. **[x] Liveness sweep for orphan background jobs** — `6cae525`. `lib/job-liveness.mjs` exports `isProcessAlive(pid)` and `sweepDeadJobs(workspaceRoot)`. Wired into `handleStatus` as a best-effort step before snapshots are built.
4. **[x] Linux/Windows auth detection** — `2e2d87e` (+ Windows regression `753f163`). `detectLinuxSecretAuth` probes `secret-tool` with a list of likely Copilot CLI service names; `detectWindowsCredentialAuth` greps `cmdkey /list` output. All probes accept injectable `platform` / `runCommand` / `binaryAvailable` options so each platform path is unit-testable from any host. macOS keychain probe also now loops over the service list.
5. **[x] Plugin-level model/effort defaults** — `d9ed30a`. `~/.claude/plugins/copilot/config.json` (override via `COPILOT_PLUGIN_CONFIG_PATH`). CLI flags always win. Loader is lenient — malformed JSON, unknown effort values, and wrong types degrade to "no default" with a one-line stderr warning rather than failing the command. `/copilot:setup` surfaces the config path and current defaults.
6. **[x] Touched-files summary on `/copilot:rescue`** — `f95b485`. `runCopilotPrompt` collects `file.change` event paths into an ordered, deduped set; `executeTaskRun` threads them through both the JSON payload (`payload.touchedFiles: string[]`) and the rendered output (header line: `Touched N files: a, b, ..., ...and M more`). Capped at 5 inline names. The capture lives in `lib/copilot.mjs`, so review and adversarial-review get the data for free if/when their rendering wants it.
7. **Marketplace publish + bump-version script.**
   - **[x] `scripts/bump-version.mjs`** — `c786dd0`. Keeps `package.json`, `plugins/copilot/.claude-plugin/plugin.json`, and the two version fields in `.claude-plugin/marketplace.json` in sync. `npm run bump-version -- <version>` and `npm run version:check` aliases. Full release flow documented in `docs/RELEASE.md`. Dropped the codex original's `package-lock.json` target (no runtime deps yet).
   - **[ ] Marketplace publish.** Not started. The hand-off point is documented in `docs/RELEASE.md` ("What the script does NOT do"): when this lands, it should be a separate `npm run publish-release` that calls bump-version first.

### Optional follow-ups surfaced during the build

- **Cut a `0.1.1` patch release** capturing items 1–7. Uses the new `bump-version` flow end-to-end and validates `docs/RELEASE.md`.
- **Add `COPILOT_INTEGRATION=1` gate** to `tests/integration.test.mjs` if the per-`npm-test` Copilot API cost becomes friction.
- **Tune the adversarial-review prompt voice.** The current framing (`plugins/copilot/prompts/adversarial-review.md`) ports codex's enterprise-flavored attack surface (auth, data loss, rollback, races). A solo-dev or hobbyist context may want a different prioritization (perf, dep bloat, build time). Pure prompt edit, no code.
- **Extend the plugin-config schema.** Today: `model`, `effort`. Plausible additions: `denyTools`, `addDirs`, `defaultPromptFile`. Strictly additive — see `loadPluginConfig` for the validation pattern.
- **Surface liveness sweep count in `/copilot:status` output.** Currently the sweep is silent. ~5 lines in `handleStatus` to thread `summary.swept` into the rendered report.
- **Reduce touched-files inline cap.** Current `MAX_INLINE_FILES = 5` (in `lib/render.mjs`) was a UX guess; rebalance once real-usage data exists.
- **Age threshold for liveness sweep.** Mitigates PID reuse (see §4). 5 lines.

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
