# Contributing

Open an issue before starting a bug fix or a substantial change, and reference it in the PR
(`Closes #NN` for a completed fix). Branch from `develop`, keep changes small, and preserve unrelated local settings.
Report suspected vulnerabilities through [SECURITY.md](SECURITY.md), not a public issue.

## Sources and generated files

`mods/<name>/mod.json` is the catalog source. After changing it or a mod's `host/` code, run
`scripts/mods generate`. Never hand-edit `mods.json`, the marketplace catalog, the Codex
marketplace (`.agents/plugins/`), or the built `codex/` and `opencode/` bundles (edit
`mods/<name>/host/` instead). Private mods belong under ignored `local/`.
Mods run unsandboxed with user permissions. Review egress and source changes explicitly.

## Layout details

- `mods/<name>/claude/` is the plugin itself. `scripts/modslib/` is the CLI package, `tests/` is
  its pytest suite, and `.github/` holds CI.
- A mod that also runs on Codex or OpenCode lists them in `"hosts"` in its mod.json. The
  engine-neutral logic stays in `claude/hooks/` (it must not import `claude-code`); only the
  entry file, `claude/hooks/register.ts` (`register.tsx` in `delegation-board` and `statusline`),
  is Claude-specific. `mods/<name>/host/` holds the Node adapters
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
MODS_REQUIRE_BUN=1 scripts/mods validate --no-claude
MODS_REQUIRE_BUN=1 scripts/mods generate --check
python3 .github/stack/stack-check.py
python3 scripts/check-plugin-versions.py
npm ci --ignore-scripts --prefix .github/tools/markdownlint
.github/tools/markdownlint/node_modules/.bin/markdownlint-cli2
```

This is the pre-push check list. [AGENTS.md](AGENTS.md) repeats the commands and
[INSTALL.md](INSTALL.md) points here; all three match `.github/workflows/ci.yml`.

- Install the dev tools first with `pip install --require-hashes -r requirements-dev.txt`.
  The file is a hashed lock and CI installs it the same way; the command that regenerates it is
  in the file's header.
- `MODS_REQUIRE_BUN=1` is what CI sets. Without it, `validate` and `generate --check` skip the
  host bundle check when the Bun in `.bun-version` is missing or another version is installed.
- The CLI and the tests support Python 3.10; CI runs the tests on 3.10 and 3.12.
  `.github/stack/stack-check.py` needs Python 3.11 or newer.
- `scripts/typecheck --hosts` needs bun and the network: it installs the TypeScript compiler and
  the type packages pinned in `.github/tools/typecheck/` into a temporary directory.
- `scripts/typecheck` exits 0 when the check passes, 1 when it fails, 2 for a usage or setup error
  (including missing engine types), and 3 when a required tool is missing.
- `ci.yml` also runs actionlint, lychee and the integration job. `.github/workflows/security.yml`
  runs zizmor and gitleaks.

With the pinned Claude CLI, also run
`scripts/mods validate` and `python3 -m pytest -q -m integration` using a temporary config root.
After TypeScript changes, run `scripts/typecheck <mod>` and
`claude plugin test mods/<mod>/claude`; `scripts/typecheck <mod>` also checks a private mod under
`local/mods/`. Typechecking requires API types from an authenticated
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
  there, so it stays untracked), so load a mod from this clone once. CI does not run it: the
  pinned `@anthropic-ai/claude-code` package ships no engine type definitions, and
  `claude plugin validate` and `claude plugin test` lay none without a login (checked on 2.1.296
  and 2.1.319). Only a real session lays them, and that needs a logged-in claude.
- A session loads installed mods from the clone's checked-out branch, so a half-edit can break
  the guard running in that very session. Edit in a `git worktree` and copy the untracked
  `mods/*/claude/.claude-plugin/types` into it so `scripts/typecheck` finds the engine types.
- Security findings get an issue labeled `security` and `p0` to `p3` before the fix; a `p0` (a
  working bypass or leak with a concrete input) is fixed at once, the rest are scheduled.

## Releases

`python3 scripts/check-plugin-versions.py` is part of the pre-push set. The lint job fetches full
history and tags and compares each plugin's shipped `claude/`, `codex/` and `opencode/`
directories against the highest `vX.Y.Z` tag in the repository, whether or not the current
branch contains it. Changed plugins must increase their
version in every host manifest, keeping them equal, even when only one host changed. New
plugins need an initial version. Regenerate bundles before checking; source-only, README and
catalog metadata changes do not count as shipped plugin changes. A missing tag/history is an
error; fetch tags and history rather than skipping the check.

Feature and fix PRs target `develop` and are squash-merged. The version bump follows the
conventional-commit titles since the last tag: `feat` is minor, `fix` and `deps` are patch,
`!` or `BREAKING CHANGE:` is major; `docs`, `chore`, `ci`, `test`, and `style` alone do not release.

1. On `develop`, by PR, move the Unreleased entries in `CHANGELOG.md` under a heading for the new
   version and add its compare link (and update the Unreleased one) at the bottom of the file. No
   file holds the collection version: it lives in that changelog heading and in the tag.
   Collection tags do not set individual plugin versions.
2. Open a PR from `develop` to `main` and merge it with a merge commit, never a squash. Tag the
   merge on `main` as `v<version>` and push the tag. The release workflow checks the tag is on
   `main`, then waits up to 20 minutes for a successful push run of the CI workflow on the tagged
   commit and fails without one, then publishes notes from the changelog. The v0.x prereleases
   were tagged on `develop`.
