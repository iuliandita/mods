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

## Layout details

- `mods/<name>/claude/` is the plugin itself. `scripts/modslib/` is the CLI package, `tests/` is
  its pytest suite, and `.github/` holds CI.
- `shared/` holds TypeScript helpers several mods use. A mod lists the ones it needs in
  `"shared"` in its mod.json; `scripts/mods generate` copies them to
  `mods/<name>/claude/hooks/shared/` (committed, so each mod installs on its own). Edit
  `shared/`, never the copies. Only helpers that never touch `$` live there: the engine does not
  follow `$` across an import, and `claude plugin validate` lists a mod's `$` calls (env, http,
  store) from the mod's own files, so code that uses `$` stays in each mod on purpose.
- `shared/<name>.inject.ts` is code that uses `$` and several mods need (for example a client or log
  write chain). A mod lists it in `"inject"` in its mod.json and holds the marker pair
  `// @inject <name> begin (...)` / `// @inject <name> end` in `claude/hooks/register.ts`;
  `scripts/mods generate` rewrites the text between them, and `generate --check` and `validate`
  flag a block that differs. Edit the template, never the block. Mod-specific parts stay outside it.
- A mod that also runs on Codex or OpenCode lists them in `"hosts"` in its mod.json. The
  engine-neutral logic stays in `claude/hooks/` (it must not import `claude-code`); only
  `claude/hooks/register.ts` is Claude-specific. `mods/<name>/host/` holds the Node adapters
  (`bin.ts` for Codex, `opencode.ts` for OpenCode, tested with `bun test`), and `scripts/mods
  generate` bundles them with the Bun in `.bun-version` into `codex/bin/<name>.mjs` and
  `opencode/server.js` (committed, never hand-edited) and writes `.agents/plugins/marketplace.json`.
  The `codex/` and `opencode/` manifests carry the same version as the Claude plugin. What each
  host can and cannot do is in [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md); update it when a
  mod gains or loses a host. A host adapter reads its options only from the user's config dir,
  never a repository file. A terminal UI plugin for OpenCode is `host/tui.ts`, built into
  `opencode/tui.js` with `@opentui/core` left external (see `scripts/host-shims`).
  `host_files` in mod.json copies a plugin file (a helper script) into each host package.
- `local/` is gitignored: private mods (`local/mods/<name>/`) installed with `--local`.
- `private-patterns.txt` (gitignored, one regex per line; see `private-patterns.example.txt`)
  adds patterns to the `scripts/mods validate` private scan. The built-in patterns cover
  absolute home paths, private IPv4 ranges, and any email address except `iulian.dita@gmail.com`,
  `noreply@users.noreply.github.com`, and placeholders (`example.com`, `example.org`,
  `example.net`, `*.example`). Files with NUL bytes are scanned too (UTF-16/32 decoded, else
  as latin-1).

## Checks and documentation

```sh
python3 -m pytest -q -m "not integration"
bun test mods/*/host
scripts/typecheck --hosts
scripts/mods validate --no-claude
scripts/mods generate --check
python3 .github/stack/stack-check.py
npm ci --ignore-scripts --prefix .github/tools/markdownlint
.github/tools/markdownlint/node_modules/.bin/markdownlint-cli2
```

CI also runs lychee, actionlint, zizmor, and gitleaks.

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

## Development notes

- Security mods fail closed: a guard mod must report at least one gating hook, and every
  gating hook needs `.catch`.
- `guard-rules` marks every shell shape outside its modeled grammar unparsed. A bypass fix comes
  with a corpus row or a `PUSH_FORMS` entry in `corpus.test.ts`, not only a code change.
- The secret-box hook rewrites any Bash command that contains a secret placeholder: write such
  text with the file tools, not in a shell command.
- Claude Desktop does not place panes. A mod that must show something there draws in the band
  above the prompt (`ui.render` with `{ component: 'AbovePrompt' }`, skipped on the terminal when
  the terminal has its own surface) and stacks on `await next(e)` instead of replacing it, so
  several mods can share the band.
- The type check needs the API types the engine lays beside a mod it has loaded
  (`mods/*/claude/.claude-plugin/types`; the engine writes a `.gitignore` containing `*`
  there, so it stays untracked), so load a mod from this clone once. CI does not run it:
  `claude plugin validate` and `claude plugin test` do not lay those types (checked on 2.1.296),
  only a real session does, and that needs a logged-in claude.
- A session loads installed mods from the clone's checked-out branch, so a half-edit can break
  the guard running in that very session. Edit in a `git worktree` and copy the untracked
  `mods/*/claude/.claude-plugin/types` into it so `scripts/typecheck` finds the engine types.
- Security findings get an issue labeled `security` and `p0` to `p3` before the fix; a `p0` (a
  working bypass or leak with a concrete input) is fixed at once, the rest are scheduled.

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
