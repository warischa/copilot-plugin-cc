# Session handoff — 2026-05-27 (test-coverage expansion + Copilot delegation workflow)

## Current task and status

**Status:** Done. **No version release** this session — it was a test-hardening + workflow session run as a "lead agent (Claude) delegating to a team of Copilot CLI agents."

Working tree was clean on `main` at v0.8.0 (commit `10be60e`) before the session. **180 → 306 tests pass** (+126), 1 skipped (integration still opt-in), 0 fail. **8 commits pushed to `main`; CI green** on Node 20/22 × Linux/macOS/Windows (run `26490861099`). No tag cut.

Last actions (in order):
1. Installed the plugin locally (`/plugin marketplace add <local path>` + `/plugin install copilot@claude-copilot`) and smoke-tested a real Copilot `task` run end-to-end (delegated dev task → files written into a scratch folder → verified). Observed Copilot self-correct an ESM/CommonJS mismatch across turns.
2. Audited coverage: 7 `lib/` modules had **zero direct unit tests** (`git`, `job-control`, `tracked-jobs`, `process`, `fs`, `prompts`, `workspace`).
3. Exported two internal event-stream parsers from `lib/copilot.mjs` (`describeEvent`, `captureFinalAnswer`) so they can be unit-tested. Additive, behavior-neutral; suite stayed green before/after.
4. Delegated test-writing to parallel Copilot agents via the companion `task` path (one scoped file each, `--background`); verified every returned file against the real suite before committing. Lead authored the invariant-critical event-parser test directly.
5. Added `.github/copilot-instructions.md` (auto-loaded by Copilot in-repo) carrying ESM/node:test/temp-dir conventions + the do-not-break invariants — proven by producing clean tests from a 3-sentence prompt.
6. Established a coverage-measurement workflow (`node --test --experimental-test-coverage`); it surfaced a silently-dropped task and the real remaining gaps.
7. Ran a controlled A/B (Sonnet 4.6 1× vs Opus 4.6 3×) on the same hard target (`collectReviewContext`); kept the better (Sonnet) file, deleted the other.
8. Pushed; CI surfaced a Windows-only failure in the delegated `fs.test.mjs`; fixed it (`path.resolve` vs `path.join`) and re-pushed; CI green.

## What this session shipped (8 commits, no release)

### New test files (+126 tests)

- `tests/event-stream.test.mjs` (16) — `describeEvent` + `captureFinalAnswer`; guards the two invariants (final answer = `assistant.message` `phase:final_answer`; session id from `result`). **Lead-authored.**
- `tests/git-target.test.mjs` (11) — `resolveReviewTarget` precedence, `detectDefaultBranch`, `getWorkingTreeState` over temp git fixtures. (Copilot, `gpt-5.4`)
- `tests/job-control.test.mjs` (38) — sort, progress-preview tail, reference resolution (exact/prefix/newest/ambiguous/not-found), enrich, snapshot. (Copilot, `gpt-5.4`)
- `tests/fs.test.mjs` (12), `tests/prompts.test.mjs` (8), `tests/workspace.test.mjs` (4) — pure helpers. (Copilot, `claude-sonnet-4.6`)
- `tests/tracked-jobs.test.mjs` (31) — `createProgressReporter` (incl. the `[copilot]`→stderr invariant), `createJobRecord`, log append, `nowIso`, `createJobProgressUpdater`. (Copilot, `gpt-5.4`, from a 3-sentence prompt using the new instructions file.)
- `tests/review-context.test.mjs` (6) — `collectReviewContext`: working-tree inline-diff, both self-collect threshold paths, branch mode (single + multi-file), object shape. (Copilot, `claude-sonnet-4.6`; A/B winner.)

### Source + config changes

- `lib/copilot.mjs`: `describeEvent` / `captureFinalAnswer` flipped internal → `export` (behavior-neutral). Unblocks direct testing of the JSONL parser — the Copilot-upgrade drift-catch surface.
- `.github/copilot-instructions.md` (new): auto-loaded by the Copilot CLI in-repo (see `detectInstructionsFiles`). Carries test conventions + invariants so delegated agents inherit them without per-prompt boilerplate.
- `tests/fs.test.mjs` (CI fix): `ensureAbsolutePath` tests asserted against `path.join` + a hardcoded POSIX literal → failed only on windows-latest/Node 22. Fixed to mirror the implementation's `path.resolve`.

## Coverage baseline (post-session)

Via `node --test --experimental-test-coverage`. Now covered: `workspace` 100%, `plugin-config` 99%, `job-liveness` 96%, `args` 92%, `job-control` 84%, `fs` 82%, `copilot` 73%, `prompts` 77%, `tracked-jobs` 62% (was 0% funcs).

**Remaining gaps — new pending (integration tier; need subprocess/integration harnesses, not unit tests):** `copilot-companion.mjs` ~14% (1,668-line `main()` dispatcher), `render.mjs` ~52%, `git.collectReviewContext` deeper branches, `tracked-jobs.runTrackedJob` (async orchestrator), `process.mjs` ~33% (spawn/kill internals). See DESIGN.md §5 "Test-coverage expansion".

## Decisions locked this session

- **Export internal event parsers for testability** — additive, behavior-neutral. (DESIGN.md §2.9, §4.)
- **Cost-aware model routing** — 1× (`gpt-5.4`/`claude-sonnet-4.6`) for deterministic verifiable work; reserve 3×+ (`claude-opus-4.6` 3×, `gpt-5.5` 7.5×, `claude-opus-4.7` 15×) for ambiguous reasoning/debugging. **Evidence:** the 1×-vs-3× A/B on `collectReviewContext` showed 3× produced no better tests than 1×. (DESIGN.md §2.9.)
- **Conventions live in `.github/copilot-instructions.md`, not prompts** — auto-loaded; proven by the 3-sentence tracked-jobs work order. (DESIGN.md §2.9.)
- **Verification discipline** — verify each delegated file as its agent reports done; run the full suite only after all agents complete (a mid-iteration full run reads half-written files); **CI is the cross-platform gate** (local macOS green ≠ Windows green). (DESIGN.md §4.)

## Reusable workflow (lead-agent delegation)

1. Codify conventions once in `.github/copilot-instructions.md` (Copilot auto-loads it in-repo).
2. Delegate one scoped file per Copilot agent via `node plugins/copilot/scripts/copilot-companion.mjs task --model <slug> "<short prompt>"` (parallel `--background`); keep invariant-critical / contract-heavy work for the lead.
3. Route by job: 1× for deterministic/verifiable; premium only when a cheaper model demonstrably fails.
4. Verify each returned file with `node --test <file>`; run the full suite only after all agents finish.
5. Push; treat CI (Node 20/22 × 3 OS) as the real gate; diagnose + fix cross-platform breaks.

Model slugs confirmed accepted via `--model`: `claude-sonnet-4.6`, `claude-opus-4.6` (Copilot rejects invalid slugs at startup, so a clean exit 0 = the slug was accepted).

## Blockers

None.

## Recent commits (newest first)

`89960f1` (collectReviewContext tests), `c6633a6` (fix Windows path assertions in fs tests), `93cde19` (tracked-jobs tests), `cc89175` (copilot-instructions.md), `aea397b` (fs/prompts/workspace tests), `d46edb3` (job-control tests), `ea193dc` (git review-target tests), `758f55a` (export event parsers + event-stream tests).

---

# Session handoff — 2026-05-26 (through `v0.8.0`)

## Current task and status

**Status:** Done. The 0.8.0 session shipped a security trifecta on top of the 0.7.0 polish bucket:

- `v0.8.0` — security trifecta (E1+E2+E3): `--secret-env <vars>` pass-through on all four agent commands (forwards as `--secret-env-vars=<name>`), `--allow-auto-update` escape hatch for the always-on `--no-auto-update` default, and `--session-name <name>` user override on all four agent commands.

Working tree was clean on `main` at v0.7.0 (commit `7690d58`) before the session started. **180 tests pass + 1 skipped** (was 172 → +8 new tests across E1/E2/E3). Integration test is still opt-in via `COPILOT_INTEGRATION=1`.

Last actions (in order):
1. Re-probed `copilot --help` against Copilot CLI 1.0.52 — **same version** as the 0.7.0 ship. **Zero upstream drift.** But the probe found one missed flag: `--secret-env-vars` (security: strips env-var values from shell + MCP envs and redacts from output). Two adjacent audit findings: `--no-auto-update` was already unconditionally emitted but had no escape hatch (asymmetric with `--no-remote` / `--no-ask-user`); `--name` was already wired in `buildCopilotArgs` and used internally by `executeTaskRun` / `executePlanRun` but never exposed at the CLI surface.
2. Confirmed via `gh issue list` that there are zero open user-reported issues.
3. Decision gate via `AskUserQuestion`: user picked "Security trifecta" — ship all three (E1+E2+E3) in one bucket.
4. Implemented E1+E2+E3 with 8 new unit tests; landed as commit `7766693` "Security trifecta — secret-env scrub + auto-update lock + session-name (E1+E2+E3)".
5. Real end-to-end smoke test against the live binary: `task --secret-env DUMMY_KEY,ANOTHER_KEY --session-name "0.8.0 smoke test" "Reply with exactly the single word OK..."` returned `OK` exit 0 — proving all three flags wire cleanly through `buildCopilotArgs` → `runCopilotPrompt` → Copilot's arg parser.
6. Cut `v0.8.0` via `npm run publish-release -- 0.8.0`: manifest-only commit `9ba4c7f` "Release 0.8.0", tag `v0.8.0`, pushed, GitHub Release created at https://github.com/warischa/copilot-plugin-cc/releases/tag/v0.8.0.
7. CI run pending verification at handoff write time — see "Important context" footer for the final status once observed.

## What this 0.8.0 session shipped

One bucket, one release. Same drift-vs-coverage probe standard as 0.7.0: re-probe `copilot --help`, *then* audit our `buildCopilotArgs` against it (not just the documented flags we'd planned to wire). The audit turned up the most value this round — Copilot CLI is still 1.0.52, so the upstream-drift channel was dry, but the audit channel surfaced one genuine gap (`--secret-env-vars`) and two latent ones (no `--allow-auto-update`, no `--session-name` exposure).

### E1 — `--secret-env <vars>` on all four agent commands

`buildCopilotArgs` now accepts `secretEnvVars: string[]` and emits one `--secret-env-vars=<name>` per entry. The companion CLI parses `--secret-env <comma-list>` via the existing `parseCommaSeparatedList` helper. Available on `/copilot:review`, `/copilot:adversarial-review`, `/copilot:rescue`, and `/copilot:plan`.

**What Copilot does with it** (per `copilot help environment` on 1.0.52): the *values* of the named vars are stripped from shell and MCP server environments at the boundary, and redacted from output. Variable *names* still appear in logs — only values are scrubbed. Defense-in-depth on top of the permissions model: even if a tool is allowed and inherits env, Copilot scrubs the value before the child process sees it.

Wired on **all four** commands intentionally — secret leakage isn't a write-only risk. A review tool reading `$OPENAI_API_KEY` and echoing it in its analysis is exactly the case `--secret-env-vars` is meant to block.

### E2 — `--no-auto-update` always-on + `--allow-auto-update` escape hatch

The plugin was already emitting `--no-auto-update` unconditionally — found at `lib/copilot.mjs:483` from before this session. But the always-on emission was asymmetric with the 0.7.0 `--no-remote` / `--no-ask-user` pattern (those have `--allow-remote` / `--allow-ask-user` escape hatches). Fixed: refactored the emission to be gated by `!options.allowAutoUpdate`, with `--allow-auto-update` exposed at the companion CLI on all four agent commands.

**Why the lock is the right default:** mid-run binary upgrades change behavior under us. We test each plugin release against a known Copilot CLI version (1.0.52 currently). If `copilot` auto-updates between the `--version` probe and the `-p` execution, the user gets behavior the plugin maintainer hasn't validated. The escape hatch is for users who actively want the CLI to upgrade itself (rare, but documented).

### E3 — `--session-name <name>` user override on all four agent commands

`buildCopilotArgs` already accepted `options.sessionName` and emitted `--name <value>` — it was used internally by `executeTaskRun` (auto-named `copilot-task <excerpt>`) and `executePlanRun` (auto-named `copilot-task plan: <excerpt>`), but the companion CLI never exposed a way for users to override the auto-generated value.

Now exposed as `--session-name <name>` on all four agent commands. When set, it overrides the auto-generated name. When unset (the default), the existing auto-naming behavior is preserved. Reviews — which previously didn't pass a `sessionName` at all — now accept it too so power users can `copilot --resume="review for PR-123"` from the bare CLI after the plugin prints the session id.

The override path resolves precedence cleanly: resume runs (`--resume-last` / `--resume`) keep the existing session's name (null tells Copilot to preserve it) and ignore `--session-name`. Only fresh sessions honor the override.

### End-to-end smoke test against Copilot CLI 1.0.52

One live call exercised all three new buckets at once:

```bash
node plugins/copilot/scripts/copilot-companion.mjs task \
  --secret-env DUMMY_KEY,ANOTHER_KEY \
  --session-name "0.8.0 smoke test" \
  "Reply with exactly the single word OK and nothing else."
```

Result: `OK`, exit 0. Copilot accepted both flags (it errors on unknown arg combos). Combined with the existing `--no-auto-update` baseline test (still passes after the refactor), all three E flags are verified live before tagging.

The `--allow-auto-update` escape hatch was verified by direct args-array inspection rather than a second API call (defaults emit `--no-auto-update`; setting `allowAutoUpdate: true` suppresses it). Same approach as 0.7.0's allowRemote/allowAskUser tests — cheap, deterministic, no extra API spend.

### Test count delta

172 (pre-session) → **180** (post-session). 8 new tests in `companion-helpers.test.mjs`:

- **3 for E1** — `secretEnvVars` per-entry emission, blank/null entry skipping, default-empty.
- **2 for E2** — `--no-auto-update` default emit, `allowAutoUpdate` escape hatch suppression.
- **3 for E3** — `sessionName` emits `--name <value>`, default omits `--name`, falsy values (null/undefined/empty string) all ignored.

Plus the existing baseline `buildCopilotArgs` deepEqual already included `--no-auto-update` in the expected output — no test update needed since we kept it as the default. All green locally on Node 22 / macOS.

## Previous session handoff — 2026-05-26 (through `v0.7.0`)

**Status:** Done. The 0.7.0 session shipped a polish bucket on top of the 0.6.0 menu completion:

- `v0.7.0` — polish bucket (A+B+C): privacy defaults (`--no-remote` + `--no-ask-user`) with escape hatches, symmetric `--allow-tool` / `--allow-url` / `--deny-url` pass-through on all four agent commands, `--attachment <paths>` on rescue.

Working tree was clean on `main` at v0.6.0 (commit `cc90379`) before the session started. **172 tests pass + 1 skipped** (was 156 → +17 new tests for A privacy defaults, B allow/deny tool/url, C attachments + `parseAttachmentPaths` helper). Integration test is still opt-in via `COPILOT_INTEGRATION=1`.

Last actions (in order):
1. Re-probed `copilot --help` against Copilot CLI 1.0.52 — same version as 0.6.0 ship, no upstream drift. Found 20-ish documented flags the plugin never wired, triaged them into Tier 1 (clearly useful), Tier 2 (review-tightening), Tier 3 (niche), Tier 4 (N/A).
2. Confirmed via `gh issue list` that there are zero user-reported issues to triage.
3. Decision gate via `AskUserQuestion`: user picked privacy defaults default-on (with escape hatches), allow/deny tool/url on all four agent commands, attachment on rescue only.
4. Implemented A+B+C with 17 new unit tests; landed as commit `27ccf4d` "Polish bucket — privacy defaults, allow/deny tool/url, attachment (A+B+C)".
5. Real end-to-end smoke tests against the live binary: bare `task` with new privacy defaults returned `OK` exit 0; `--allow-url github.com --deny-url malicious.test` accepted by Copilot; `--attachment` flag verified to wire through (Copilot rejected a `.txt` with its own "must be an image or native document" error, proving the arg parsed and forwarded).
6. Cut `v0.7.0` via `npm run publish-release -- 0.7.0`: manifest-only commit `db15f28` "Release 0.7.0", tag `v0.7.0`, pushed, GitHub Release created at https://github.com/warischa/copilot-plugin-cc/releases/tag/v0.7.0.
7. CI run `26428105896` completed `success` across all 4 matrix jobs (Node 20 ubuntu, Node 22 ubuntu/macos/windows).

## Previous session handoff — 2026-05-25 (through `v0.6.0`)

**Status:** Done. The 0.6.0 session closed every remaining item on the post-port menu (DESIGN.md §5) in one batch:

- `v0.6.0` — menu completion (D2+D4+D7+D9+U3): `COPILOT_GITHUB_TOKEN` citation, full resume-forms doc, `--share` / `--share-path` / `--share-gist` pass-through on all four agent commands, `--mcp-tool` / `--mcp-config` pass-through on rescue+plan, U3 confirmed already-done.

Working tree was clean on `main` at v0.5.0 (commit `3642c9f`) before the session started. **156 tests pass + 1 skipped** (was 141 → +15 new tests for D7, D9, and the `parseCommaSeparatedList` helper). Integration test is still opt-in via `COPILOT_INTEGRATION=1`.

Last actions (in order):
1. Verified every newly-claimed Copilot flag against `copilot --help` and `copilot help environment` on Copilot CLI 1.0.52 — found `COPILOT_GITHUB_TOKEN`, `--resume[=value]`, `--connect[=sessionId]`, `--continue`, `--session-id`, `--share[=path]`, `--share-gist`, `--add-github-mcp-tool`, `--additional-mcp-config` all documented exactly as we use them.
2. Implemented D2+D4+D7+D9+U3 with 15 new unit tests; landed as commit `b84371d` "Close post-port menu (D2+D4+D7+D9+U3)".
3. Real end-to-end smoke test against the live binary: `node ...companion.mjs task --share-path /tmp/copilot-smoke-0.6.0.md --mcp-tool issues "Reply with the single word OK"` returned `OK`, exit 0, and the markdown transcript landed at the requested path (437B, valid content). Both new feature buckets verified end-to-end before tagging.
4. Cut `v0.6.0` end-to-end via `npm run publish-release -- 0.6.0`: manifest-only commit `73456d3` "Release 0.6.0", tag `v0.6.0`, push to `origin/main`, GitHub Release created at https://github.com/warischa/copilot-plugin-cc/releases/tag/v0.6.0.
5. CI run `26380250309` completed `success` across all 4 matrix jobs (Node 20 ubuntu, Node 22 ubuntu/macos/windows).

## What this 0.7.0 session shipped

One bucket, one release. Same flag-verification standard as 0.6.0: every new flag was matched against `copilot --help` on the installed binary (1.0.52) before code landed. The post-port menu was already empty at 0.6.0 — 0.7.0 came from a deliberate *coverage* probe (what *does* Copilot expose that we haven't wired?), not from a bug or new upstream feature.

### A — privacy + non-stalling defaults

`buildCopilotArgs` now always emits `--no-remote` and `--no-ask-user` for non-interactive runs:

- `--no-remote` — disables remote control of the session from GitHub web/mobile. The plugin is local; nobody opted into a remote handoff.
- `--no-ask-user` — disables the `ask_user` tool so the agent doesn't stall waiting for human input while we're parsing JSONL with no stdin.

Both have escape hatches at the companion CLI: `--allow-remote` / `--allow-ask-user` suppress the corresponding `--no-*` flag. The plugin never emits a positive `--remote` / `--ask-user` — Copilot's CLI default *is* remote-on / ask-user-on, so just not emitting our override is enough.

### B — symmetric allow/deny tool/url pass-through

Three new flags on **all four** agent commands (`/copilot:review`, `/copilot:adversarial-review`, `/copilot:rescue`, `/copilot:plan`):

- `--allow-tool <pats>` — comma list; each entry → one `--allow-tool=<pat>`. Patterns are Copilot's standard `shell(git push)`, `write`, `MyMCP(tool_name)` forms.
- `--allow-url <urls>` — comma list; each entry → one `--allow-url=<pat>`.
- `--deny-url <urls>` — comma list; each entry → one `--deny-url=<pat>`.

**Why all four (vs D9's rescue+plan-only scope):** per `copilot help permissions`, denial rules always take precedence over allow rules — including over `--allow-all-tools`. So even on a review where the plugin enforces `--deny-tool=write,shell`, a user-supplied `--allow-tool=shell` is a no-op against the baseline. The read-only invariant survives at the Copilot CLI level. D9's tighter scope was justified for MCP because MCP servers can expose write/shell tools that aren't in the baseline deny list; allow-tool/url/deny-url operate on patterns that bottom out at the same deny-precedence guarantee. Documented in `buildCopilotArgs` inline so future readers don't re-litigate.

### C — `--attachment <paths>` on rescue only

Comma-separated list of file paths attached to the initial prompt (Copilot's native image / native-document support). Validated at parse time via the new `parseAttachmentPaths` helper:

- Resolves each entry against `cwd` to an absolute path.
- Throws on missing files (`--attachment path not found: <name>`).
- Throws on directories (`--attachment must be a file, got a directory: <name>`).
- Does **not** validate content type — that's Copilot's job (it rejects unsupported types like `.txt` with its own error message during run, which is also what proved the wiring in smoke testing).

Exposed via `/copilot:rescue`'s argument-hint; the underlying `task` companion subcommand accepts it for the rescue subagent's forwarding path. Reviews and plans don't expose it.

### End-to-end smoke tests against Copilot CLI 1.0.52

Three live calls:

1. **A:** `node ...companion.mjs task "Reply with exactly the single word OK and nothing else."` → `OK`, exit 0. Confirms the new privacy defaults don't break a baseline run.
2. **B:** `node ...companion.mjs task --allow-url github.com --deny-url malicious.test "Reply with exactly the single word OK..."` → `OK`, exit 0. Confirms allow/deny URL flags accepted.
3. **C (wiring proof):** `node ...companion.mjs task --attachment /tmp/copilot-smoke-0.7.0-attachment.txt "..."` → Copilot returned `--attachment file type not supported (must be an image or native document)`. That's Copilot's *own* error string, which proves: (a) our `parseAttachmentPaths` accepted the path, (b) `buildCopilotArgs` emitted the flag, (c) Copilot received it. A 1×1 PNG was also tried; Copilot started the session and got past flag parsing (turn started/turn ended cleanly) but couldn't produce a final message for that pixel-sized image — a Copilot-side image-pipeline limit, not a plugin bug.

### Test count delta

156 (pre-session) → **172** (post-session). 17 new tests in `companion-helpers.test.mjs`:

- **4 for A** — defaults emit `--no-remote` + `--no-ask-user`; `allowRemote` suppresses only `--no-remote`; `allowAskUser` suppresses only `--no-ask-user`; both escape hatches together suppress both.
- **5 for B** — `--allow-tool` per entry; `--allow-url` per entry; `--deny-url` per entry; blank/null entries skipped; defaults emit no flags.
- **3 for C buildCopilotArgs** — per-entry `--attachment` emission; blank skip; default-empty.
- **5 for `parseAttachmentPaths`** — null/empty; comma-list resolution to absolute paths; absolute-input passthrough; missing-path error; directory-rejection error.

Plus the baseline `buildCopilotArgs` deepEqual test updated to include the new `--no-remote` / `--no-ask-user` flags. All green locally on Node 22 / macOS.

## Previous session handoff — 2026-05-24 (through `v0.5.0`)

The 0.5.0 session shipped **four** releases on top of the original v0.2.0 line:

- `v0.3.0` — publish-release wrapper (DESIGN §5.7b closed).
- `v0.3.1` — bugs surfaced by a real end-to-end test (B1+B2+B3): label collapse, `edit` deny-tool, version-line trim.
- `v0.4.0` — divergences from documented Copilot behavior (D1+D3+U1+U2): effort set expanded, custom-instructions detected, redundant phase line, `redactSummary` privacy flag.
- `v0.5.0` — agentic upgrade (D5+D6+D8): new `/copilot:plan` command, `--autopilot` on tasks, `--no-custom-instructions` on adversarial review.

The repo is public at https://github.com/warischa/copilot-plugin-cc with branch protection on `main`. After 0.5.0 the working tree was clean with **140 tests pass + 1 skipped** at version `0.5.0` (commit `060a5de`, tag `v0.5.0`).

## What this 0.6.0 session shipped

Five buckets, one release. Worth noting up front: every Copilot flag we added in this session was **verified against `copilot help`** before any code landed — the post-port-review lesson from 0.3.1/0.4.0 (codex-era assumptions can hide real bugs) is now standard practice.

### D2 — `COPILOT_GITHUB_TOKEN` citation

`copilot help environment` documents `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN` in that precedence order. Added a comment on `AUTH_ENV_VARS` in `lib/copilot.mjs` so the next reader doesn't re-litigate whether the first var is real. No behavior change.

### D4 — Resume forms documented in README

Copilot supports four resume mechanisms; only one is used by the plugin (`--resume=<sessionId>`). The README now has a "Resume forms" table covering `--resume[=value]` (id / id-prefix / task id / case-insensitive name), `--continue`, `--connect[=sessionId]` (remote handoff), and `--session-id <uuid>`. Power users now know what they can do directly from the bare `copilot` CLI after the plugin prints a session id.

### D7 — `--share` / `--share-path` / `--share-gist` pass-through

Surfaced on **all four** agent-facing commands: `/copilot:review`, `/copilot:adversarial-review`, `/copilot:rescue`, and `/copilot:plan`. The bare `--share` uses Copilot's default `./copilot-session-<id>.md`. `--share-path <path>` overrides and implies `--share` — `buildCopilotArgs` suppresses the bare `--share` when a path is set to avoid double-emission. `--share-gist` uploads to a secret GitHub gist, independent of the other two flags. The file write happens *after* the run, so reviews keep their read-only contract while Copilot is working — the markdown file is the only side effect, and only on opt-in.

### D9 — MCP pass-through (rescue + plan only)

Two new flags on `/copilot:rescue` and `/copilot:plan` only:

- `--mcp-tool <names>` accepts a comma-separated list; each entry becomes one `--add-github-mcp-tool <name>` to Copilot. Dedupes preserving first-seen order.
- `--mcp-config <json|@path>` accepts a single JSON string or `@file` path; emitted as `--additional-mcp-config`.

**Reviews and adversarial-reviews intentionally do not accept these.** MCP servers can expose tools that write or shell out — that would break the read-only invariant enforced by `REVIEW_BASELINE_DENY_TOOLS`. If a user wants extra MCP context for a review, they need a different code path (not in scope).

A new `parseCommaSeparatedList` helper in `copilot-companion.mjs` does the comma split; it's exported and unit-tested. It deliberately does NOT split on whitespace or accept JSON arrays — comma is the documented form, and JSON config strings themselves contain commas (use `--mcp-config` for those).

### U3 — `[copilot] ...` lines to stderr

Verified during the sweep: both `[copilot] ...` writers (`createProgressReporter` in `tracked-jobs.mjs:126`, `reportPluginConfigWarnings` in `plugin-config.mjs:210`) already write to `process.stderr`. No code change needed; DESIGN.md §5 marker flipped from `[ ]` to `[x] / 0.6.0` with a note.

### End-to-end smoke test against Copilot CLI 1.0.52

Burned one real Copilot API call to verify the two non-trivial buckets end-to-end:

```bash
node plugins/copilot/scripts/copilot-companion.mjs task \
  --share-path /tmp/copilot-smoke-0.6.0.md \
  --mcp-tool issues \
  "Reply with the single word OK and nothing else."
```

Result: `OK`, exit 0, and `/tmp/copilot-smoke-0.6.0.md` (437B) contained the expected markdown transcript with session id + prompt + reply. `--mcp-tool issues` was accepted (Copilot errors on invalid MCP tool names). Both new feature paths confirmed live before tagging.

### Test count delta

141 (pre-session) → **156** (post-session). 15 new tests in `companion-helpers.test.mjs`:

- **6 for D7** — bare `--share`, `--share-path` implies share and suppresses bare, path-alone form, `--share-gist` independent, blank-path ignored, default emits nothing.
- **4 for D9** — `--add-github-mcp-tool` repeats per entry, `--additional-mcp-config` repeats per entry, blank/null entries skipped, default emits nothing.
- **5 for `parseCommaSeparatedList`** — null/empty handling, trim+split, dedupe preserving order, doubled/trailing commas, array flattening.

All green locally on Node 22 / macOS. CI will validate Node 20/22 × Linux/macOS/Windows on push.

## Goal

Build and harden a Claude Code plugin (`copilot-plugin-cc`) that wraps the **GitHub Copilot CLI** (`copilot` binary) using the same architectural pattern as [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc). Users get `/copilot:setup`, `/copilot:review`, `/copilot:adversarial-review`, `/copilot:rescue`, `/copilot:status`, `/copilot:result`, `/copilot:cancel` inside Claude Code.

## What this session added on top of the v1 MVP

The previous handoff left the v1 MVP staged-but-uncommitted. This session:

1. **Created the initial commit** `d7e73bb` and reframed the working tree:
   - Renamed `master` → `main`.
   - Verified the folder had been moved to `/Users/waris.c/claude/copilot-plugin-cc/` (the older `/Users/waris.c/claudecode/Claude-Copilot/copilot-plugin-cc/` path is gone).
2. **Published to GitHub** — created `warischa/copilot-plugin-cc` (private at first, flipped to public). Pushed `main` and set up tracking.
3. **Added community files** — `.github/ISSUE_TEMPLATE/{bug,feature,config}.yml` (commit `f556d9d`).
4. **Applied branch protection** via the Rulesets API on `main`: blocks deletion, non-fast-forward, non-linear-history. Ruleset id `16794344`.
5. **Worked through DESIGN.md §5 items 1–7**:
   - §5.1 integration smoke test → `f556d9d`
   - §5.2 `/copilot:adversarial-review` → `0d3cd6f`
   - §5.3 job-liveness sweep → `6cae525`
   - §5.4 Linux/Windows auth detection → `2e2d87e`
   - Windows real-data regression test → `753f163`
   - §5.5 plugin-level model/effort defaults → `d9ed30a`
   - §5.6 touched-files summary → `f95b485`
   - §5.7 (partial) bump-version script + `docs/RELEASE.md` → `c786dd0` (marketplace publish intentionally deferred)
6. **Test count:** 21 → 77 (all passing). Suite runtime ~14s, dominated by the integration test's real Copilot call.

## What was added on top of 0.1.1 (this session, → 0.2.0)

After cutting the `0.1.1` patch release that captured §5 items 1–6 + bump-version, this session worked through every remaining "Optional follow-up" from DESIGN.md §5 and then some:

1. **Cut `0.1.1` release** end-to-end — exercised the new `bump-version` flow + `docs/RELEASE.md`. Tag `v0.1.1`, commit `028aa6e`, GH Release `https://github.com/warischa/copilot-plugin-cc/releases/tag/v0.1.1`.
2. **CI workflow + `COPILOT_INTEGRATION` gate** — `.github/workflows/ci.yml` runs `version:check` + `npm test` on push/PR across Node 20/22 × Linux/macOS/Windows. Integration test is now opt-in (off by default), so `npm test` runtime dropped from ~14s → ~3s and stopped burning a Copilot API call per run (`2074121`).
3. **Surface liveness sweep count + PID-reuse age threshold** — `/copilot:status` now prints `Swept N orphan job(s) (id, ...)` when zombies are flipped. `sweepDeadJobs` gained `maxRunningAgeMs` (default 6h) to flip suspected PID-reuse jobs even when the recorded pid still resolves (`c5303bc`).
4. **Plugin-config schema extended** — `denyTools`, `addDirs`, `defaultPromptFile` validated by `loadPluginConfig`. `denyTools` + `addDirs` flow through `applyPluginDefaults`; reviews always keep the baseline `write,edit,shell` deny list and merge plugin-config additions on top (`a9be2a5`).
5. **Adversarial-review prompt rebalanced** — broader buckets (correctness edge cases, perf, DX) instead of always front-loading enterprise concerns; framed as "calibrate to the code, not a default tier list" (`912c8f1`).
6. **Touched-files cap** — replaced the count-of-5 with a 160-char budget + 12-entry hard ceiling; always shows at least one entry even if it exceeds the budget (`912c8f1`).
7. **First CI run uncovered Node 18 hook-ordering bug + Windows path test fragility** — bumped `engines.node` to `>=20.0.0`, dropped 18.18 from CI matrix, rebuilt the path assertion with `path.join` so it's platform-neutral, updated docs (`fb9f5fb`).
8. **Cut `0.2.0` release** — minor bump because Node-floor raise is breaking pre-1.0. Tag `v0.2.0`, commit `86e1a02`, GH Release `https://github.com/warischa/copilot-plugin-cc/releases/tag/v0.2.0`. CI green on Node 20/22 × Linux/macOS/Windows.
9. **Documented `Claude-Copilot` placeholder identity** — explicit DESIGN.md §2.7 decision that the marketplace slug is an intentional impersonal namespace, not a missing org. Repo can transfer to a real `Claude-Copilot` org later without breaking existing installs.

**Test count:** 77 → 97 (96 pass + 1 skipped — integration is opt-in via `COPILOT_INTEGRATION=1`). Suite runtime ~3s locally without the integration gate, ~14s with it set.

## Locked design decisions added this session

- **Branch name:** `main` (renamed from `master`).
- **GitHub owner:** personal account `warischa` (not the `Claude-Copilot` org placeholder).
- **Visibility:** public.
- **Branch protection:** Rulesets API (not classic branch protection), blocks deletion + force-push + non-linear history. No required reviewers (solo repo for now).
- **Plugin config (§5.5):** user-scoped at `~/.claude/plugins/copilot/config.json`, not workspace-scoped. Lenient loader (warn-and-skip on bad values). Schema starts at `model` + `effort` only; future fields are strictly additive.
- **Adversarial review (§5.2):** prose passthrough, **no JSON schema** — diverges from codex's structured `<structured_output_contract>` block to stay consistent with our v1 "verbatim prose" decision (DESIGN.md §2).
- **Liveness sweep (§5.3):** ~~silent~~ — **as of 0.2.0**, `/copilot:status` now prints a `Swept N orphan job(s) (id, ...)` line when zombies are flipped.
- **Touched-files cap (§5.6):** ~~5 inline names~~ — **as of 0.2.0**, char budget (160) + hard ceiling (12 entries); always shows ≥1 entry even if it exceeds the budget.
- **Bump-version (§5.7):** dropped the codex original's `package-lock.json` target — this plugin has no runtime deps.
- **Integration test cost:** ~~every `npm test` spends one real Copilot API call~~ — **as of 0.2.0**, opt-in via `COPILOT_INTEGRATION=1`. Default `npm test` no longer hits the network.
- **Node floor (added 0.2.0):** `>=20.0.0`. Bumped from 18.18 after CI surfaced `node:test` hook-ordering bugs on Node 18.
- **CI (added 0.2.0):** GitHub Actions matrix on Node 20/22 × Linux/macOS/Windows runs `version:check` + `npm test` on push/PR.
- **Identity placeholder (added 0.2.0):** `Claude-Copilot` is an **intentional** marketplace namespace, not a missing GH org. See DESIGN.md §2.7. Repo can transfer to a real `Claude-Copilot` org later without breaking installs.

The original v1 MVP decisions (verbatim prose review, `--allow-all-tools`, MIT, `Claude-Copilot` author placeholder, `threadId` storage field, minimal smoke tests) all still stand. See `DESIGN.md` §2.

## Files touched this session

Repo root (`/Users/waris.c/claude/copilot-plugin-cc/`):

- **New:**
  - `.github/ISSUE_TEMPLATE/{bug,feature,config}.yml`
  - `docs/RELEASE.md`
  - `scripts/bump-version.mjs`
  - `plugins/copilot/commands/adversarial-review.md`
  - `plugins/copilot/prompts/adversarial-review.md`
  - `plugins/copilot/scripts/lib/job-liveness.mjs`
  - `plugins/copilot/scripts/lib/plugin-config.mjs`
  - `tests/integration.test.mjs`
  - `tests/job-liveness.test.mjs`
  - `tests/auth-detect.test.mjs`
  - `tests/plugin-config.test.mjs`
  - `tests/touched-files.test.mjs`
  - `tests/bump-version.test.mjs`
- **Modified:**
  - `README.md` (added Releasing section; corrected stale "adversarial-review not in v1" row)
  - `DESIGN.md` (§4 new gotchas; §5 status markers)
  - `SESSION-HANDOFF.md` (this file)
  - `package.json` (added `bump-version` + `version:check` scripts)
  - `plugins/copilot/scripts/copilot-companion.mjs` (adversarial-review wiring; plugin-config defaults; liveness sweep; setup report extension; touchedFiles in task payload)
  - `plugins/copilot/scripts/lib/copilot.mjs` (cross-platform auth detection; `extractTouchedFilePath` + `touchedFiles` capture in run state)
  - `plugins/copilot/scripts/lib/render.mjs` (setup-report plugin-config block; `renderTouchedFilesSummary` + task-result header)

## Assumptions

- All the v1 MVP assumptions still hold (**Node 20+ as of 0.2.0**, copilot CLI installed and authed, `$CLAUDE_PLUGIN_DATA` set inside Claude Code).
- The `tests/integration.test.mjs` assertion that an empty `hello` prompt produces `touchedFiles: []` could become flaky if a future Copilot version starts emitting `file.change` events for read-only inspections. Watch for that.
- Linux/Windows auth detection is best-effort: probes a hardcoded list of likely keytar service names (`copilot-cli`, `github-copilot-cli`, `com.github.copilot.cli`, `GitHub Copilot CLI`, `Copilot CLI`). Verified for **Windows** via real `cmdkey /list` output. Not yet verified on a real Linux host — if a user reports "authed but plugin says not authed" on Linux, the fix is almost certainly adding one string to `COPILOT_SECRET_SERVICES` in `lib/copilot.mjs`.

## Blockers

None.

## Commands run (this session, on top of 0.1.0/0.1.1 history)

- `npm run bump-version -- 0.1.1` → `0.2.0` (two release cuts)
- `git tag -a v0.1.1 -m "Release 0.1.1"` + `git tag -a v0.2.0 -m "Release 0.2.0"`
- `git push origin main --follow-tags` × multiple
- `gh release create v0.1.1 …` + `gh release create v0.2.0 …`
- `gh run watch <id>` to monitor CI on the first push that surfaced Node 18 + Windows failures
- `npm test` × many (final: **96 pass / 0 fail / 1 skipped** locally; same on CI across Node 20/22 × Linux/macOS/Windows)

## Tests done vs not done

**Done:**

- Unit smoke (carried over from v1 + 0.1.1): args, state, render, plugin-config, job-liveness, touched-files, auth-detect, bump-version
- Integration smoke: real `copilot` task via the companion (now opt-in via `COPILOT_INTEGRATION=1`)
- **CI** (added 0.2.0): node:test full suite on Node 20/22 × Linux/macOS/Windows
- New render coverage: `renderStatusReport` sweep-line cases (4 tests)
- Extended job-liveness coverage: age-threshold + PID-reuse mitigation (4 tests)

**Not done (deliberate / future) — as of v0.2.0:**

- No Linux real-host auth verification (probe list is best-effort; see Assumptions). **Still deferred.**
- No end-to-end test of `/copilot:adversarial-review` against the real binary — it shares `runCopilotPrompt` with `review`, so the integration test covers the underlying path. **Still true.**
- No `CHANGELOG.md` — commit messages and the GitHub Releases page are the changelog. **Still true.**
- No `npm run publish-release` wrapper. **Shipped in v0.3.0** — see commit `755998b`.

**Added in v0.5.0:**

- Smoke-tested `/copilot:plan` end-to-end against the real binary (32s round-trip on a short prompt).
- Unit-test coverage extended to `buildCopilotArgs` (plan / autopilot / no-custom-instructions combinations).

## Post-`v0.3.0` work shipped in this session

After cutting `v0.3.0` (publish-release wrapper), this session did a real end-to-end test against Copilot CLI 1.0.52, read the official Copilot docs, and shipped two more releases worth of fixes/divergence-corrections:

### `v0.3.1` (B1+B2+B3 — bugs surfaced by the real test)

- **B1:** `getJobKindLabel` used to collapse every non-review jobClass into `"rescue"`. A plain `task` showed up as `| rescue |` in `/copilot:status`. Switch over the full jobClass set; fall back to the class string when unknown. Exported so tests can cover it directly.
- **B2:** Dropped `"edit"` from `REVIEW_BASELINE_DENY_TOOLS`. Copilot CLI has no such tool — file edits are gated by `write`. The bogus token was silently ignored. Baseline is now `["write", "shell"]`.
- **B3:** `getCopilotAvailability` returned the raw `copilot --version` output, which on Copilot 1.0.52 trails an "Run 'copilot update'…" advisory line. New `extractVersionLine` helper keeps only the first non-empty line.

Also threaded an `isDirectInvocation` guard around `main()` in `copilot-companion.mjs` so tests can import the pure helpers without firing the CLI dispatcher.

### `v0.4.0` (D1+D3+U1+U2 — divergences from documented Copilot behavior)

- **D1:** Expanded `effort` validation from the codex-era `low|medium|high|xhigh` to the full Copilot set `none|low|medium|high|xhigh|max`. Updated the warning message to list the full set.
- **D3:** New `detectInstructionsFiles` helper probes the documented Copilot custom-instructions paths (global, `.github/copilot-instructions.md`, `.github/instructions/*.instructions.md`, `AGENTS.md`, `Copilot.md`, `GEMINI.md`, `CODEX.md`). `/copilot:setup` now lists what's auto-loaded. README documents the precedence rules and links to the Copilot best-practices docs.
- **U1:** Suppress redundant `Phase: done` line when status is `completed` (and the analogous pairs for `failed`/`cancelled`). New `isRedundantPhase` helper in `lib/render.mjs`.
- **U2:** New `redactSummary: boolean` plugin-config option. When `true`, stored task summaries show `[summary redacted]` instead of the first ~96 chars of the prompt. Default `false` (no behavior change). Documented in README under "Plugin config" with the privacy rationale.

### `v0.5.0` (D5+D6+D8 — agentic upgrade)

The largest functional release since `v0.1.0`. Three Copilot-native features that were missed in the original port now ship as first-class plugin features:

- **D5 — `/copilot:plan`:** New slash command + companion subcommand that runs Copilot with `--plan`. Returns a structured implementation plan; no code edits. Defense-in-depth deny list (`write`, `shell`). New `jobClass: "plan"` + `kindLabel: "plan"`. Background path supported by adding a `jobClass`-aware dispatch inside the task worker. Smoke-tested end-to-end against Copilot CLI 1.0.52 (32s round-trip on a short prompt; output looked good).
- **D6 — `--autopilot` on tasks:** `/copilot:task` and `/copilot:rescue` accept `--autopilot` and `--max-autopilot-continues <N>`. New `parsePositiveInteger` helper validates the count. Passing `--max-autopilot-continues` without `--autopilot` errors out explicitly instead of being silently dropped.
- **D8 — `--no-custom-instructions` on adversarial review:** Opt-in flag that bypasses `AGENTS.md` / repo `copilot-instructions` for fresh-eyes adversarial reviews.

All flags flow through one place — `buildCopilotArgs` in `lib/copilot.mjs` — which is now `export`ed and has direct unit-test coverage. Also fixed a missed sync from 0.4.0: the companion's `VALID_REASONING_EFFORTS` was still on the codex-era set (rejected `none`, `max`); now matches plugin-config.

### Test count

97 (post-`v0.3.0`) → 134 (post-`v0.4.0`) → 141 (post-`v0.5.0`). All green on Node 22 / macOS. CI will validate Node 20/22 × Linux/macOS/Windows on push.

## Deferred / not in scope this session

The post-port menu (D-/U- items) is **fully closed as of 0.6.0**. The 0.7.0 polish bucket and 0.8.0 security trifecta are also done. What's still on the table:

- **[~] Linux real-host auth verification** — probe list is best-effort; not on the roadmap (maintainer doesn't use Linux). One-string fix in `COPILOT_SECRET_SERVICES` if a user reports breakage.
- **[ ] Move repo to real `Claude-Copilot` GH org** — identity placeholder is documented in DESIGN.md §2.7 so the transfer is one `gh api -X POST .../transfer` away.
- **[ ] New Copilot CLI flags** — Copilot ships flags faster than we port them. The companion's `buildCopilotArgs` is the single place to extend; re-probe `copilot --help` whenever the binary updates.

## Next steps

For the next Claude Code session, in order:

1. Skim `DESIGN.md` (§2 decisions, §4 gotchas, §5 status — including **Post-port review**, **Agentic upgrade**, **Menu completion (0.6.0)**, **Polish bucket (0.7.0)**, and **Security trifecta (0.8.0)** subsections). It's the authoritative state-of-the-plugin doc — this SESSION-HANDOFF.md is the timeline, DESIGN.md is the contract.
2. If the user asks to cut a release: run `npm run publish-release -- <new>` (one command — see `docs/RELEASE.md`). The wrapper handles bump-version + tests + commit + tag + push + GH release.
3. If the user asks to extend further: the post-port menu, polish bucket, AND security trifecta are all empty. Likely sources of new work are (a) Copilot CLI shipped a new flag we haven't ported (re-probe `copilot --help`), (b) a real user reported a bug, (c) the user wants a new feature bucket invented from scratch. **Tier 2 review-tightening flags** still on the shelf: `--disable-builtin-mcps`, `--disable-mcp-server`, `--disallow-temp-dir`, `--available-tools`/`--excluded-tools`, `--enable-reasoning-summaries`. **Tier 3 niche flags** still on the shelf: `--add-github-mcp-toolset`, `--agent`, `--log-dir`/`--log-level`, `--mode`, `--session-id`, `--connect`, `--plugin-dir`, `--bash-env`/`--no-bash-env`, `--experimental`/`--no-experimental`. (Documented in the 0.7.0 probe analysis — deliberately deferred, shelfable on request.)
4. If `copilot` CLI changes: re-probe with `copilot -p "ping" --output-format json --allow-all-tools --no-color` and diff against `describeEvent()` in `lib/copilot.mjs`. The pure extractors (`extractTouchedFilePath`, `extractVersionLine`, `parseCmdKeyOutput`, `parseSecretToolOutput`, `detectInstructionsFiles`, `buildCopilotArgs`, `parseCommaSeparatedList`, `parseAttachmentPaths`) are exported specifically to make this kind of drift catch-able with one test.
5. **Cross-reference both** the codex-plugin-cc reference at `https://github.com/openai/codex-plugin-cc` AND the live Copilot CLI docs ([best practices](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-best-practices)) before designing a new feature. The codex pattern is the shape; Copilot's actual flags are the ground truth — and they don't always agree (see §5 Post-port review).
6. **Audit, don't just probe.** The 0.8.0 finding loop was: re-probe `copilot --help` → audit our `buildCopilotArgs` source against it → find both *missed* flags (genuinely new wiring needed) AND *latent* flags (already in our code but not exposed at the CLI surface). The audit channel turned up two of three 0.8.0 wins. Don't stop at the diff between `copilot --help` and our docs — check the diff between `copilot --help` and our actual source too.

## Important context

- This project still treats `openai/codex-plugin-cc` as its **conceptual source of truth** for architectural patterns, **but** the post-port review in 0.3.1/0.4.0/0.5.0/0.6.0 demonstrated that codex-era assumptions can mask real bugs. Always cross-check against the live Copilot CLI docs ([best practices](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-best-practices), [getting started](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started)) when porting a new feature. `copilot help <topic>` (especially `environment` and `permissions`) is the actual ground truth — the web docs lag.
- The package.json name is `@claude-copilot/copilot-plugin-cc` and the marketplace owner is `Claude-Copilot` — these are org-style placeholders chosen during v1, deliberately not tied to a personal identity. The GitHub repo *is* under `warischa` (a personal account). See [DESIGN.md §2.7 "Project identity"](DESIGN.md).
- **Tags shipped:** `v0.1.1`, `v0.2.0`, `v0.3.0`, `v0.3.1`, `v0.4.0`, `v0.5.0`, `v0.6.0`, `v0.7.0`, `v0.8.0`. Latest tag = latest release.
- **Recent commits (newest first):** `9ba4c7f` (Release 0.8.0), `7766693` (Security trifecta — secret-env scrub + auto-update lock + session-name E1+E2+E3), `7690d58` (Sync plugin README with shipped flags through v0.7.0), `c4fc012` (Refresh SESSION-HANDOFF after v0.7.0 ship), `db15f28` (Release 0.7.0), `27ccf4d` (Polish bucket — privacy defaults, allow/deny tool/url, attachment A+B+C), `cc90379` (Refresh SESSION-HANDOFF after v0.6.0 ship), `73456d3` (Release 0.6.0), `b84371d` (Close post-port menu D2+D4+D7+D9+U3), `3642c9f` (Refresh SESSION-HANDOFF and DESIGN through v0.5.0).
- **CI matrix (verified 2026-05-26):** 4 jobs — Node 20 on `ubuntu-latest`, Node 22 on `ubuntu-latest` / `macos-latest` / `windows-latest`. Node 20 is only checked on Linux; Node 22 catches OS-specific issues. If you ever edit `.github/workflows/ci.yml`, this is the shape to preserve unless deliberately widening it.
- Branch `main` is protected — no force-push, no deletion, linear history only. Routine commits and pushes are fine.
- **Release workflow:** Single command — `npm run publish-release -- <version>`. Refuses on dirty tree or off-branch HEAD unless `--allow-dirty` / `--branch` is passed. See `docs/RELEASE.md`.
- The `code-review-graph` build hook may regenerate `.code-review-graph/` at the repo root — it's in `.gitignore`.
