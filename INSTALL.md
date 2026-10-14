# Install and recover

Mods run unsandboxed with your permissions. Read the selected mod's README, requirements,
`mod.json` surface status, and declared egress before installing. A local source loads the
checkout's current code, so do development in a separate checkout or worktree.

## Marketplace installation

```bash
claude plugin marketplace add iuliandita/mods
claude plugin install guard-rules@iuliandita-mods --scope user
```

Install from a terminal. User scope can load in Desktop sessions, but loading is not equivalent
to verified hook behavior. Each mod's manifest records actual surface coverage.

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

JSON commands emit one object with `ok` and `errors`; failure exits 1. `install` adds `installed`
and `uninstall` adds `uninstalled`, including IDs completed before a later failure. These calls
are sequential, not an atomic transaction: completed changes are not automatically rolled back.
Inspect the error and completed IDs, check `claude plugin list --json`, fix the cause, and retry
only the remaining names. To undo a completed installation, uninstall its recorded ID at the same
scope. Recover a known earlier version from a preserved checkout/source and explicitly reinstall
it; preserve settings and avoid blindly resetting Claude configuration.

## Contributor checks

```bash
python3 -m pytest -q -m "not integration"
scripts/mods validate --no-claude
scripts/mods generate --check
```

`validate --no-claude` excludes engine validation and hook tests. Full validation needs the pinned
Claude CLI. Typechecking additionally needs API types laid down by an authenticated local session;
CI plugin validation/testing does not create them. See [CONTRIBUTING.md](CONTRIBUTING.md) for
integration and TypeScript checks. These exclusions are not a claim of verified runtime behavior.
