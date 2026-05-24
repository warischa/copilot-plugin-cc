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

---

## 5. Next-step menu (in rough priority order)

1. **Integration smoke test against the real `copilot` binary.** A test that spawns the companion with a 1-line prompt, asserts the JSONL parse path captures the final answer, and asserts `result.sessionId` lands in the stored job. Skips if `copilot` is not installed or not authenticated.
2. **`/copilot:adversarial-review`** — second prompt template + small companion subcommand. Mirror the codex pattern; the work is mostly prompt design.
3. **Liveness sweep for orphan background jobs.** Add a `lib/job-liveness.mjs` invoked from `status` that flips dead-running jobs to `failed`.
4. **Linux/Windows auth detection.** Today we only probe macOS keychain.
5. **Allow `--model` defaults via plugin-level config.** A `~/.claude/plugins/copilot/config.json` that injects `--model` / `--effort` when not user-specified.
6. **Hook for `/copilot:rescue` post-run** — emit a one-line summary of touched files (parseable from JSONL `file.change` events if Copilot emits them) so users see scope before reading the verbatim output.
7. **Marketplace publish + bump-version script.** Port `scripts/bump-version.mjs` from codex-plugin-cc when ready for a release.

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
└── package.json                        # type=module, node ≥18.18
```

See `CLAUDE.md` for the "what to touch when extending" map.
