# Contributing

Open an issue before starting a bug fix or a substantial change, and reference it in the PR
(`Closes #NN` for a completed fix). Branch from `develop`, keep changes small, and preserve unrelated local settings.
Report suspected vulnerabilities through [SECURITY.md](SECURITY.md), not a public issue.

## Sources and generated files

`mods/<name>/mod.json` is the catalog source. Edit `shared/` helpers and inject templates,
then run `scripts/mods generate`. Never hand-edit `mods.json`, the marketplace catalog,
copied `hooks/shared/` helpers, injected blocks, the Codex marketplace (`.agents/plugins/`), or
the built `codex/` and `opencode/` bundles (edit `mods/<name>/host/` instead). Private mods belong
under ignored `local/`.
Mods run unsandboxed with user permissions. Review egress and source changes explicitly.

## Checks and documentation

```sh
python3 -m pytest -q -m "not integration"
bun test mods/*/host
scripts/typecheck --hosts
scripts/mods validate --no-claude
scripts/mods generate --check
python3 .github/stack/stack-check.py
```

With the pinned Claude CLI, also run
`scripts/mods validate` and `python3 -m pytest -q -m integration` using a temporary config root.
After TypeScript changes, run `scripts/typecheck <mod>` and
`claude plugin test mods/<mod>/claude`. Typechecking requires API types from an authenticated
local session; CI validation/testing does not supply those types. Record that exclusion when
it cannot be run. Do not install into live user configuration to obtain a test result.

There is no automated docs-impact engine here. Review [INSTALL.md](INSTALL.md), affected mod
READMEs, manifests, egress, requirements, scopes and recovery steps in the PR. Changes to guards
need a corpus regression case. Surface portability is expected only until a real session verifies
it; do not turn terminal coverage into a claim about Desktop, VS Code or headless sessions.

## Releases

Run `python3 scripts/check-plugin-versions.py` before pushing. The lint job fetches full
history and tags and compares each plugin's shipped `claude/`, `codex/` and `opencode/`
directories against the latest reachable collection tag. Changed plugins must increase their
version in every host manifest, keeping them equal, even when only one host changed. New
plugins need an initial version. Regenerate bundles before checking; source-only, README and
catalog metadata changes do not count as shipped plugin changes. A missing tag/history is an
error; fetch tags and history rather than skipping the check.

Feature and fix PRs target `develop` and are squash-merged. The version bump follows the
conventional-commit titles since the last tag: `feat` is minor, `fix` and `deps` are patch,
`!` or `BREAKING CHANGE:` is major; `docs`, `chore`, `ci`, `test`, and `style` alone do not release.

1. On `develop`, bump the collection version and move the Unreleased changelog entries under
   the new version by PR. Collection tags do not set individual plugin versions.
2. During the v0.x prerelease phase, tag `develop` as `v<version>` and push the tag.
3. Starting with v1.0.0, open a PR from `develop` to `main` and merge it with a merge commit,
   never a squash. Tag the merge on `main` as `v<version>` and push the tag. The release workflow
   checks the tag and publishes notes from the changelog.
