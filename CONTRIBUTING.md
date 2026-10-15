# Contributing

Open an issue before starting a bug fix or a substantial change, and reference it in the PR
(`Closes #NN` for a completed fix). Keep changes small and preserve unrelated local settings.
Report suspected vulnerabilities through [SECURITY.md](SECURITY.md), not a public issue.

## Sources and generated files

`mods/<name>/mod.json` is the catalog source. Edit `shared/` helpers and inject templates,
then run `scripts/mods generate`. Never hand-edit `mods.json`, the marketplace catalog,
copied `hooks/shared/` helpers, injected blocks, the Codex marketplace (`.agents/plugins/`), or
the built `codex/` and `opencode/` bundles (edit `mods/<name>/host/` instead). Private mods belong
under ignored `local/`.
Mods run unsandboxed with user permissions. Review egress and source changes explicitly.

## Checks and documentation

Run `python3 -m pytest -q -m "not integration"`, `bun test mods/*/host`,
`scripts/typecheck --hosts`, `scripts/mods validate --no-claude`, and
`scripts/mods generate --check`. With the pinned Claude CLI, also run
`scripts/mods validate` and `python3 -m pytest -q -m integration` using a temporary config root.
After TypeScript changes, run `scripts/typecheck <mod>` and
`claude plugin test mods/<mod>/claude`. Typechecking requires API types from an authenticated
local session; CI validation/testing does not supply those types. Record that exclusion when
it cannot be run. Do not install into live user configuration to obtain a test result.

There is no automated docs-impact engine here. Review [INSTALL.md](INSTALL.md), affected mod
READMEs, manifests, egress, requirements, scopes and recovery steps in the PR. Changes to guards
need a corpus regression case. Surface portability is expected only until a real session verifies
it; do not turn terminal coverage into a claim about Desktop, VS Code or headless sessions.
