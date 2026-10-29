# Install and recover

Mods run unsandboxed with your permissions. Read the selected mod's README, requirements,
`mod.json` surface status, and declared egress before installing. A local source loads the
checkout's current code, so do development in a separate checkout or worktree.

The v0.x prerelease installs from `develop`, the default branch. `main` becomes the stable
release channel at v1.0.0.

## Marketplace installation

```bash
claude plugin marketplace add iuliandita/mods
claude plugin install guard-rules@iuliandita-mods --scope user
```

Install from a terminal. User scope can load in Desktop sessions, but loading is not equivalent
to verified hook behavior. Each mod's manifest records actual surface coverage.

## Host and backend setup

`mods.json` lists the install command per host for each mod that supports it, and each mod's
README describes the host setup. [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) shows what works
where.

For `secret-box`, install Python 3 and `bash`, plus `secret-tool` on Linux (with an unlocked
Secret Service keyring). macOS uses the built-in `/usr/bin/security` and an unlocked Keychain;
backend selection is automatic. Windows is unsupported. `scripts/mods doctor --json` checks
common binaries plus the current platform's `requires_by_platform` entries. Missing backend
binaries appear in the mod's `requires` results; the JSON envelope and exit codes are unchanged.
Real macOS Keychain access and prompts remain unverified.

Store values with `secret-box set NAME` in your own terminal, never in the chat. Run
`secret-box names` to check backend access without printing values. The helper has no plaintext
`values` command; hooks use batched `scrub` calls instead. Placeholder checks cover only
Claude Code and Codex `Bash`, and OpenCode `shell`/`bash`; Codex `write_stdin` is not covered. Configure optional
`secretScopes` directory globs in the Claude plugin options or the user-level
`~/.config/iuliandita-mods/secret-box.json` file on Codex and OpenCode. Unlisted names remain
unrestricted; malformed settings deny placeholder commands. See the mod's
[options](mods/secret-box/README.md#options) and [limits](mods/secret-box/README.md#what-it-does-not-protect).

For `notify`, install `notify-send` (libnotify) on Linux; macOS uses the built-in `osascript`.
A missing notifier is a one-line `notify: warning:` and never a failure; `scripts/mods doctor`
lists it under the mod's `requires`. On Codex and OpenCode set options in
`~/.config/iuliandita-mods/notify.json`; see the mod's [README](mods/notify/README.md) for the events
each host supports. Codex hooks run in the background and skip events with `agent_id`; notifier
delivery has a 250 ms process timeout. It has no verified runtime check on any host yet.

## Clone CLI and scopes

```bash
scripts/mods list --json
scripts/mods doctor --json
scripts/mods install guard-rules secret-box --scope user --json
scripts/mods uninstall guard-rules secret-box --scope user --json
```

`install` and `uninstall` default to `user`; `project` and `local` are also accepted and passed
to Claude's plugin CLI. Use the original scope when uninstalling. `list --scope` filters reported
scopes; entries without a scope count at any scope. `installed: null` means installation state
could not be established, not that the plugin is absent.

From a clone, installation registers the clone root as `iuliandita-mods`, not GitHub.
Use `--source iuliandita/mods` for GitHub, or a git URL/path for another source. Names are still
validated against this clone's catalog, so the alternate source must carry those mods.
`--root <repo>` selects the catalog root and works before or after the command, as does `--json`.
Private mods use `scripts/mods install <name> --local`; they register `<clone>/local` as
`iuliandita-mods-local`. `--local` cannot be combined with `--source`.

## Updates and source mismatch

Collection tags (starting with the `v0.1.0` prerelease) identify a repository snapshot. Each
plugin keeps its own version; a collection tag does not set every plugin to that version.

There is no `scripts/mods update` command. For a GitHub marketplace, refresh and update with
Claude's CLI:

```bash
claude plugin marketplace update iuliandita-mods
claude plugin update guard-rules@iuliandita-mods --scope user
```

For a clone source, first review and fast-forward the checkout, run the validation/generation
checks below, then update the installed plugin at its original scope. Keep the clone available.

An existing marketplace must match the requested source. The CLI skips an identical registration
and refuses a different or uncomparable source. Inspect it first:

```bash
claude plugin marketplace list --json
```

If switching is intentional, record installed plugin IDs and scopes, preserve local configuration,
then remove only that marketplace registration and retry the intended install:

```bash
claude plugin marketplace remove iuliandita-mods
scripts/mods install guard-rules --source iuliandita/mods --scope user --json
```

Do not remove unrelated marketplaces or assume removal restores an earlier plugin version.

## Partial failures and recovery

JSON commands emit one object with `ok` and `errors`. Exit codes: 0 done, 1 failed, 2 usage error,
3 a required tool (claude, or the pinned bun) is missing. `install` adds `installed`
and `uninstall` adds `uninstalled`, including IDs completed before a later failure. These calls
are sequential, not an atomic transaction: completed changes are not automatically rolled back.
Inspect the error and completed IDs, check `claude plugin list --json`, fix the cause, and retry
only the remaining names. To undo a completed installation, uninstall its recorded ID at the same
scope. Recover a known earlier version from a preserved checkout/source and explicitly reinstall
it; preserve settings and avoid blindly resetting Claude configuration.

## Codex and OpenCode

Only mods with `hosts` in `mods.json` run there; see [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md).
Both hosts run the mod with your permissions, like Claude.

Codex:

```bash
codex plugin marketplace add iuliandita/mods
codex plugin add guard-rules@iuliandita-mods   # or secret-box or notify, same suffix
```

Codex skips a plugin hook until you trust it once with `/hooks` in the Codex terminal UI.
Remove with `codex plugin remove guard-rules@iuliandita-mods`.

OpenCode 2.x has no marketplace: clone this repository and add the package to `opencode.json`
(`~/.config/opencode/opencode.json` for all projects):

```json
{ "plugins": [{ "package": "/path/to/clone/mods/guard-rules/opencode" }] }
```

Terminal UI mods (`statusline`, `delegation-board`) are listed in `plugins` in
`~/.config/opencode/cli.json` instead; OpenCode has no project-level file for these:

```json
{ "plugins": [{ "package": "/path/to/clone/mods/statusline/opencode" }] }
```

Hook-adapter options for both hosts live in `~/.config/iuliandita-mods/<mod>.json` (see the
mod's README), never in a repository. OpenCode terminal UI plugins do not read Claude plugin
options; `delegation-board` reads only `mode` from its file there, `statusline` reads none. Remove their `cli.json` entries and restart OpenCode to disable them;
remove hook-plugin entries from `opencode.json` to uninstall those. Preserve the clone and
user-level configuration when updating or rolling back a path-based install.

After a Codex install the hook command is
`node <plugin>/bin/guard-rules.mjs`; the same file in a clone (`mods/guard-rules/codex/bin/`) is
the command line tool for OpenCode users too.

## Retired mods

`prompt-gate` and `skill-pick` are no longer in the catalog. Remove an existing install with
`scripts/mods uninstall prompt-gate skill-pick --scope user --json` (use the scope you installed
at). The command also prints the steps it cannot do itself: on Codex run
`codex plugin remove <mod>@iuliandita-mods`, and on OpenCode remove the `plugins` entry in
`opencode.json` that ends in `mods/<mod>/opencode`. Their option files in
`~/.config/iuliandita-mods/` and stored files under `~/.local/share/iuliandita-mods/` can be
deleted. These steps are printed (and listed under `manual` with `--json`) whatever happens on the
Claude side. A retired mod that Claude Code reports as not installed, or a missing `claude` CLI,
is skipped with a note (`skipped` with `--json`) and the command still succeeds; a real Claude
failure exits non-zero and still carries the steps. `scripts/mods list` shows a retired mod only
while it is installed.

## Contributor checks

```bash
python3 -m pytest -q -m "not integration"
bun test mods/*/host
scripts/typecheck --hosts
scripts/mods validate --no-claude
scripts/mods generate --check
python3 .github/stack/stack-check.py
```

`generate` builds the Codex and OpenCode bundles with the Bun version in `.bun-version`
and refuses another version, so the committed files are reproducible.

`validate --no-claude` excludes engine validation and hook tests. Full validation needs the pinned
Claude CLI. Typechecking additionally needs API types laid down by an authenticated local session;
CI plugin validation/testing does not create them. See [CONTRIBUTING.md](CONTRIBUTING.md) for
integration and TypeScript checks. These exclusions are not a claim of verified runtime behavior.
