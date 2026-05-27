# Copilot instructions — copilot-plugin-cc

A Claude Code plugin that wraps the GitHub Copilot CLI. Node.js, **ESM**
(`package.json` has `"type": "module"`), Node **20+**. No build step, no
bundler, no linter — the source runs directly.

## Core facts

- Run the suite with `npm test` (= `node --test tests/*.test.mjs`).
- All business logic lives in `plugins/copilot/scripts/` —
  `copilot-companion.mjs` plus `lib/*.mjs`. The slash-command markdown files
  hold prompt rules only, never logic.
- `lib/copilot.mjs` is the only module that talks to the `copilot` binary.

## Invariants — do not break

- The companion script is the only path that invokes `copilot`.
- Slash commands and the rescue subagent return Copilot's stdout **verbatim** —
  no paraphrasing, no summarizing.
- Review is **read-only** — enforced with `--deny-tool=write,shell`.

## When writing tests

- Use the built-in `node:test` runner with `node:assert/strict`. ESM `import`
  only — never `require` / `module.exports`.
- Match the structure of `tests/plugin-config.test.mjs` (describe/it blocks,
  temp-dir setup, `after()` cleanup).
- Test the **exported** pure functions directly — the source exports helpers
  specifically so they can be unit-tested.
- For any filesystem, job-state, or git fixture: create a temp dir via
  `node:os` `tmpdir()` + `node:fs` `mkdtempSync()`, and remove it in an
  `after()` hook. **Never** mutate the real working directory, the real git
  repository, or real user state under `$CLAUDE_PLUGIN_DATA`.
- Import the module under test by relative path, e.g.
  `../plugins/copilot/scripts/lib/<module>.mjs`.
- Inject collaborators where the function supports it (several helpers accept a
  `runCommand` / `platform` / `homedir` override in their options object) so a
  path can be exercised deterministically without real I/O — see
  `tests/auth-detect.test.mjs`.
- Before finishing, run `node --test <your file>` and iterate until it is green.
- Scope discipline: create only the test file(s) requested; do not modify
  production source unless explicitly told to.

## Style

- 2-space indentation, double-quoted strings, semicolons. Match the surrounding
  file rather than imposing a different style.
