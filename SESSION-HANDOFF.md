# Session handoff — 2026-05-24 (through `v0.5.0`)

## Current task and status

**Status:** Done. The session shipped **four** releases on top of the original v0.2.0 line:

- `v0.3.0` — publish-release wrapper (DESIGN §5.7b closed).
- `v0.3.1` — bugs surfaced by a real end-to-end test (B1+B2+B3): label collapse, `edit` deny-tool, version-line trim.
- `v0.4.0` — divergences from documented Copilot behavior (D1+D3+U1+U2): effort set expanded, custom-instructions detected, redundant phase line, `redactSummary` privacy flag.
- `v0.5.0` — agentic upgrade (D5+D6+D8): new `/copilot:plan` command, `--autopilot` on tasks, `--no-custom-instructions` on adversarial review.

The repo is public at https://github.com/warischa/copilot-plugin-cc with branch protection on `main`. Working tree is clean, **140 tests pass + 1 skipped** (integration is opt-in via `COPILOT_INTEGRATION=1`), and version metadata is in sync at **`0.5.0`**.

Last action: shipped `v0.5.0` end-to-end via the `publish-release` wrapper (commit `060a5de`, tag `v0.5.0`, GitHub Release created).

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

- **[ ] D2** Verify `COPILOT_GITHUB_TOKEN` env var actually exists in Copilot CLI. Not in current docs; harmless to keep as an auth probe.
- **[ ] D4** Document full resume forms (`--resume=<name>`, `--connect=<sessionId>`) in README.
- **[ ] D7** `--share` for review markdown export.
- **[ ] D9** MCP plumbing (`--add-github-mcp-tool`, `--additional-mcp-config`).
- **[ ] U3** Route `[copilot] ...` progress lines to stderr.
- **[~] Linux real-host auth verification** — not on the roadmap (maintainer doesn't use Linux).
- **[ ] Move repo to real `Claude-Copilot` GH org** — identity placeholder is documented in DESIGN.md §2.7 so the transfer is one `gh api -X POST .../transfer` away.

## Next steps

For the next Claude Code session, in order:

1. Skim `DESIGN.md` (§2 decisions, §4 gotchas, §5 status — including the **Post-port review** and **Agentic upgrade** subsections). It's the authoritative state-of-the-plugin doc — the SESSION-HANDOFF.md you're reading is the timeline, DESIGN.md is the contract.
2. If the user asks to cut a release: run `npm run publish-release -- <new>` (one command — see `docs/RELEASE.md`). The wrapper handles bump-version + tests + commit + tag + push + GH release.
3. If the user asks to extend further: pick from the **Deferred items** in DESIGN.md §5 (D7 `--share`, D9 MCP plumbing, U3 progress→stderr, D2/D4 docs/cleanup) or invent a new bucket.
4. If `copilot` CLI changes: re-probe with `copilot -p "ping" --output-format json --allow-all-tools --no-color` and diff against `describeEvent()` in `lib/copilot.mjs`. The pure extractors (`extractTouchedFilePath`, `extractVersionLine`, `parseCmdKeyOutput`, `parseSecretToolOutput`, `detectInstructionsFiles`, `buildCopilotArgs`) are exported specifically to make this kind of drift catch-able with one test.
5. **Cross-reference both** the codex-plugin-cc reference at `https://github.com/openai/codex-plugin-cc` AND the live Copilot CLI docs ([best practices](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-best-practices)) before designing a new feature. The codex pattern is the shape; Copilot's actual flags are the ground truth — and they don't always agree (see §5 Post-port review).

## Important context

- This project still treats `openai/codex-plugin-cc` as its **conceptual source of truth** for architectural patterns, **but** the post-port review in 0.3.1/0.4.0/0.5.0 demonstrated that codex-era assumptions can mask real bugs. Always cross-check against the live Copilot CLI docs ([best practices](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-best-practices), [getting started](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started)) when porting a new feature.
- The package.json name is `@claude-copilot/copilot-plugin-cc` and the marketplace owner is `Claude-Copilot` — these are org-style placeholders chosen during v1, deliberately not tied to a personal identity. The GitHub repo *is* under `warischa` (a personal account). See [DESIGN.md §2.7 "Project identity"](DESIGN.md).
- **Tags shipped:** `v0.1.1`, `v0.2.0`, `v0.3.0`, `v0.3.1`, `v0.4.0`, `v0.5.0`. Latest tag = latest release.
- **Recent commits (newest first):** `060a5de` (Release 0.5.0), `d86a304` (D5+D6+D8), `e7e5bab` (Release 0.4.0), `aa1a7ad` (D1+D3+U1+U2), `2a9b85b` (Release 0.3.1), `ba39cd5` (B1+B2+B3), `1b7b64a` (Release 0.3.0), `755998b` (publish-release wrapper).
- Branch `main` is protected — no force-push, no deletion, linear history only. Routine commits and pushes are fine.
- **Release workflow:** Single command — `npm run publish-release -- <version>`. Refuses on dirty tree or off-branch HEAD unless `--allow-dirty` / `--branch` is passed. See `docs/RELEASE.md`.
- The `code-review-graph` build hook may regenerate `.code-review-graph/` at the repo root — it's in `.gitignore`.
