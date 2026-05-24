# Session handoff — 2026-05-24 (post-v1 extensions)

## Current task and status

**Status:** Done. Initial v1 MVP is committed, pushed, and extended with all of DESIGN.md §5 items 1–6 plus the bump-version half of item 7. The repo is **public** at https://github.com/warischa/copilot-plugin-cc with branch protection on `main`. Working tree is clean, all 77 tests pass, and version metadata is in sync at `0.1.0`.

Last action: ported `scripts/bump-version.mjs` from `openai/codex-plugin-cc` and wrote `docs/RELEASE.md` (commit `c786dd0`).

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

## Locked design decisions added this session

- **Branch name:** `main` (renamed from `master`).
- **GitHub owner:** personal account `warischa` (not the `Claude-Copilot` org placeholder).
- **Visibility:** public.
- **Branch protection:** Rulesets API (not classic branch protection), blocks deletion + force-push + non-linear history. No required reviewers (solo repo for now).
- **Plugin config (§5.5):** user-scoped at `~/.claude/plugins/copilot/config.json`, not workspace-scoped. Lenient loader (warn-and-skip on bad values). Schema starts at `model` + `effort` only; future fields are strictly additive.
- **Adversarial review (§5.2):** prose passthrough, **no JSON schema** — diverges from codex's structured `<structured_output_contract>` block to stay consistent with our v1 "verbatim prose" decision (DESIGN.md §2).
- **Liveness sweep (§5.3):** silent — flips zombie jobs but doesn't surface a `"Swept N jobs"` line in `/copilot:status` output. Easy to make noisy later (~5 lines).
- **Touched-files cap (§5.6):** 5 inline names, then `...and N more`. UX guess.
- **Bump-version (§5.7):** dropped the codex original's `package-lock.json` target — this plugin has no runtime deps.
- **Integration test cost:** every `npm test` spends one real Copilot API call (~14s). Auto-skips if copilot is missing/unauthed, but no env-var opt-out gate yet.

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

- All the v1 MVP assumptions still hold (Node 18.18+, copilot CLI installed and authed, `$CLAUDE_PLUGIN_DATA` set inside Claude Code).
- The `tests/integration.test.mjs` assertion that an empty `hello` prompt produces `touchedFiles: []` could become flaky if a future Copilot version starts emitting `file.change` events for read-only inspections. Watch for that.
- Linux/Windows auth detection is best-effort: probes a hardcoded list of likely keytar service names (`copilot-cli`, `github-copilot-cli`, `com.github.copilot.cli`, `GitHub Copilot CLI`, `Copilot CLI`). Verified for **Windows** via real `cmdkey /list` output. Not yet verified on a real Linux host — if a user reports "authed but plugin says not authed" on Linux, the fix is almost certainly adding one string to `COPILOT_SECRET_SERVICES` in `lib/copilot.mjs`.

## Blockers

None.

## Commands run

- `git commit` + `git push origin main` × 9 (all on `main`, linear history)
- `npm test` × many (final: 77 pass / 0 fail / ~14s)
- `npm run version:check` → `All version metadata matches 0.1.0.`
- `gh repo create warischa/copilot-plugin-cc --private --source=. --remote=origin --push`
- `gh repo edit warischa/copilot-plugin-cc --visibility public --accept-visibility-change-consequences`
- `gh api -X POST repos/warischa/copilot-plugin-cc/rulesets ...` (created ruleset id `16794344`)
- `git branch -m master main`
- `node scripts/bump-version.mjs --check` (one-off)

## Tests done vs not done

**Done:**

- Unit smoke (carried over from v1): args, state, render
- Integration smoke: real `copilot` task via the companion (auto-skips if unauthed)
- New unit suites:
  - `tests/job-liveness.test.mjs` — 8 tests
  - `tests/auth-detect.test.mjs` — 12 tests (incl. real-Windows regression line)
  - `tests/plugin-config.test.mjs` — 17 tests
  - `tests/touched-files.test.mjs` — 12 tests
  - `tests/bump-version.test.mjs` — 6 tests

**Not done (deliberate / future):**

- No Linux real-host auth verification (probe list is best-effort; see Assumptions).
- No end-to-end test of `/copilot:adversarial-review` against the real binary — it shares `runCopilotPrompt` with `review`, so the integration test covers the underlying path.
- No CI workflow (no `.github/workflows/`). Adding `npm test` + `npm run version:check` to CI is a clean next step.
- No `CHANGELOG.md` — commit messages are the changelog.
- No marketplace-publish script.

## Remaining work

Per DESIGN.md §5:

- **[ ] §5.7 marketplace publish.** Deliberately deferred. Hand-off note for the next contributor lives in `docs/RELEASE.md` under "What the script does NOT do".

Optional follow-ups surfaced during the build (also captured in DESIGN.md §5 "Optional follow-ups"):

- **[ ] Cut a `0.1.1` patch release** capturing everything since v1 MVP. Exercises the new bump-version flow end-to-end.
- **[ ] Add CI workflow** running `npm test` + `npm run version:check`.
- **[ ] Linux real-host probe verification.**
- **[ ] `COPILOT_INTEGRATION=1` env gate** for the integration test if API-cost-per-`npm-test` becomes friction.
- **[ ] Tune the adversarial-review prompt voice** — currently ports codex's enterprise-flavored attack surface.
- **[ ] Extend plugin-config schema** with `denyTools` / `addDirs` / `defaultPromptFile`.
- **[ ] Surface liveness sweep count** in `/copilot:status` output.
- **[ ] Age threshold in liveness sweep** to mitigate PID reuse (see DESIGN.md §4).

## Next steps

For the next Claude Code session, in order:

1. Skim `DESIGN.md` (§2 decisions, §4 gotchas, §5 status). It's the authoritative state-of-the-plugin doc — the SESSION-HANDOFF.md you're reading is the timeline, DESIGN.md is the contract.
2. If the user asks to cut a release: follow `docs/RELEASE.md`. Run `npm run version:check`, then `npm run bump-version -- <new>`, then commit + tag + push.
3. If the user asks to extend further: pick from DESIGN.md §5 "Optional follow-ups". Each item names the files to touch.
4. If `copilot` CLI changes: re-probe with `copilot -p "ping" --output-format json --allow-all-tools --no-color` and diff against `describeEvent()` in `lib/copilot.mjs`. The pure extractors (`extractTouchedFilePath`, `parseCmdKeyOutput`, `parseSecretToolOutput`) are exported specifically to make this kind of drift catch-able with one test.
5. **Always cross-reference** the codex-plugin-cc reference at `https://github.com/openai/codex-plugin-cc` before designing a new feature. Most patterns already exist there. A shallow clone is in `/tmp/codex-plugin-cc-ref/` during this session — that's ephemeral; re-clone if you need it.

## Important context

- This project still treats `openai/codex-plugin-cc` as its **conceptual source of truth** for architectural patterns. CLAUDE.md's "Conceptual source" section spells this out.
- The package.json name is `@claude-copilot/copilot-plugin-cc` and the marketplace owner is `Claude-Copilot` — these are org-style placeholders chosen during v1, deliberately not tied to a personal identity. The GitHub repo *is* under `warischa` (a personal account). This is **a resolved decision**, not a TODO — see [DESIGN.md §2.7 "Project identity"](DESIGN.md) for the rationale. The plan is: if a real `Claude-Copilot` GH org appears later, transfer the repo and the manifest identity keeps working untouched.
- Commits on `main` so far (newest first): `c786dd0`, `f95b485`, `d9ed30a`, `753f163`, `2e2d87e`, `6cae525`, `0d3cd6f`, `f556d9d`, `d7e73bb`.
- Branch `main` is protected — no force-push, no deletion, linear history only. Routine commits and pushes are fine.
- The `code-review-graph` build hook may regenerate `.code-review-graph/` at the repo root — it's in `.gitignore`.
