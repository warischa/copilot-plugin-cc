# Release / version-bump guide

This plugin's version lives in four places. **Always bump them together** — otherwise marketplace clients can see inconsistent metadata and Claude Code may refuse to install the plugin.

The `scripts/bump-version.mjs` script keeps them in sync. Run it instead of editing manifests by hand.

## Files it touches

| File | Field |
|---|---|
| `package.json` | `version` |
| `plugins/copilot/.claude-plugin/plugin.json` | `version` |
| `.claude-plugin/marketplace.json` | `metadata.version` |
| `.claude-plugin/marketplace.json` | `plugins[name=copilot].version` |

There is intentionally no `package-lock.json` target — this plugin has zero runtime dependencies.

## Picking a version

Semver. Pick the smallest bump that captures the change:

| Bump | When | Example |
|---|---|---|
| **patch** (`x.y.Z`) | Bug fixes, doc-only changes, internal refactors | `0.1.0 → 0.1.1` |
| **minor** (`x.Y.0`) | New commands, new flags, new defaults — backward-compatible | `0.1.1 → 0.2.0` |
| **major** (`X.0.0`) | Breaking changes — command renamed, flag removed, output shape changed | `0.9.0 → 1.0.0` |

Pre-1.0 caveat: while we're at `0.y.z`, the rules above are guidance, not contract. **Until 1.0.0, minor bumps can carry breaking changes** — document them in the commit message.

Pre-releases and build metadata are supported: `1.0.0-rc.1`, `1.0.0+build.42`. The script validates against the semver pattern.

## Workflow

### 1. Check current state

```bash
npm run version:check
```

Equivalent to `node scripts/bump-version.mjs --check`. Reads `package.json`'s version and verifies every other manifest matches. Exits non-zero with a useful diff if anything is out of sync:

```text
Version metadata is out of sync:
plugins/copilot/.claude-plugin/plugin.json version: expected 0.2.0, found 0.1.0
.claude-plugin/marketplace.json metadata.version: expected 0.2.0, found 0.1.0
.claude-plugin/marketplace.json plugins[copilot].version: expected 0.2.0, found 0.1.0
```

If `--check` reports a mismatch from a manual edit, run the next step to repair it.

### 2. Bump

```bash
npm run bump-version -- 0.2.0
```

The `--` after `npm run bump-version` is important — it tells npm to forward the version argument through to the script.

Or call the script directly:

```bash
node scripts/bump-version.mjs 0.2.0
```

Output:

```text
Set version metadata to 0.2.0: package.json, plugins/copilot/.claude-plugin/plugin.json, .claude-plugin/marketplace.json.
```

The script is idempotent — running it twice with the same version is harmless.

### 3. Verify

```bash
npm run version:check
npm test
```

`--check` confirms the bump landed. `npm test` confirms nothing else broke.

### 4. Commit and tag

```bash
git add package.json plugins/copilot/.claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "Release 0.2.0"
git tag -a v0.2.0 -m "Release 0.2.0"
git push origin main --follow-tags
```

Convention: tag names are prefixed with `v` (`v0.2.0`), but the version inside the manifests is not (`"version": "0.2.0"`).

## Common edge cases

- **`--check` fails right after a merge from main.** Someone bumped only `package.json` and pushed. Run `node scripts/bump-version.mjs <package-json-version>` to sync the rest.
- **You want to bump but `npm test` is failing on `main`.** Fix `main` first. Releasing a broken commit doesn't get easier later.
- **You want a pre-release for testing.** `npm run bump-version -- 0.2.0-rc.1` works. Tag it `v0.2.0-rc.1`.
- **You ran the script against the wrong directory.** Pass `--root` to point at the right repo:
  ```bash
  node scripts/bump-version.mjs --root ../sibling-checkout 0.2.0
  ```

## What the script does NOT do

- It does not run `git add` / `git commit` / `git tag`. Those are deliberate so you can inspect the diff first.
- It does not push to a marketplace. That step is intentionally out of scope for v1 — see DESIGN.md §5 item 7. When marketplace publishing lands, it will be a separate `npm run publish-release` script that calls this one first.
- It does not update `CHANGELOG.md`. We don't keep one yet; commit messages are the changelog. Add a changelog if/when contributor cadence justifies it.
