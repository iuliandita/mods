# Agent Instructions

Shared context for AI agents working in `iuliandita/mods`. `CLAUDE.md` is a symlink to this
file. If `AGENTS.local.md` exists next to it and is not already loaded, read it too; it may
add paths and preferences but never relaxes the rules below.

## What this repo is

A collection of Claude Code mods (plugins built on the hooks-module API). Each mod is its own
plugin, installable on its own.

## Install contract (for agents)

Prefer the claude CLI directly, no clone needed. This installs from the GitHub marketplace
`iuliandita/mods`:

    claude plugin marketplace add iuliandita/mods
    claude plugin install <mod>@iuliandita-mods

`scripts/mods install` makes the same two kinds of calls but does not use the GitHub
marketplace by default: it registers the clone it runs from (its root directory) as the
`iuliandita-mods` marketplace, or `--source` when given, then installs `<mod>@iuliandita-mods`.
It skips the add when the marketplace is already registered from the same source and fails
when it is registered from a different one. With `--local`, private mods are installed from
`<clone>/local` as `<mod>@iuliandita-mods-local`.

From a clone, `scripts/mods` speaks JSON (`--json` on every command):

    scripts/mods list --json
    scripts/mods install <mod> [<mod> ...] [--scope user|project|local] [--local] \
        [--source <owner/repo>]
    scripts/mods uninstall <mod> [<mod> ...] [--scope user|project|local]
    scripts/mods doctor --json
    scripts/mods validate [--no-claude]
    scripts/mods generate [--check] [--local]

`--json` and `--root <repo>` work before or after the subcommand. Option abbreviations such as
`--js` are rejected. `--root` must be a directory with a `mods/` or `local/mods/` directory;
otherwise the command exits 1 before reading or writing anything. `--source` installs from
another marketplace source (an `owner/repo`, git URL or path) instead of this clone; it cannot
be combined with `--local` (exit 1). Mod names are still checked against this clone's catalog,
not the remote one, so the source must carry the same mods.

What an agent can rely on:

- With `--json`, every command prints exactly one JSON object with `ok` (boolean) and `errors`
  (a list of strings: empty when `ok` is true, non-empty when false). Failures exit 1. Usage,
  `--root`, I/O, and `generate` catalog errors carry only these two keys.
- Each command adds its own keys: `list` adds `claude` and `mods`; `install` adds `installed`
  and `uninstall` adds `uninstalled` (the plugin ids done so far, also on failure); `doctor`
  adds `claude`, `mods`, `notes`, and `source`; `validate` adds `problems` (same strings as
  `errors`); `generate` adds `written`, and `generate --check` adds `stale`.
- `claude` is always `{"found": bool, "version": string|null}`. `doctor` exits 1 with `ok` false
  when it is not found; `list` still succeeds and reports each `installed` as null. When claude
  is found but the installed-plugin read fails, `list` exits 1 with `ok` false, a non-empty
  `errors`, and `installed` null. `installed` means installed at any scope, unless `list --scope`
  is given and claude reports a scope per plugin (a plugin without one counts at any scope).
- `validate --no-claude` skips the checks that need the claude CLI.

`mods.json` at the repo root is the machine-readable catalog. Install only the mods the user
asked for. Mods run unsandboxed with the user's permissions: read a mod's README and its
declared `egress` before installing it.

Install from a terminal. The `/plugin` slash command is unavailable in the Desktop Code tab, but
a terminal install at user scope loads in Desktop sessions too.

## Layout

- `mods/<name>/mod.json` is the source of truth. `.claude-plugin/marketplace.json` and
  `mods.json` are generated: run `scripts/mods generate`, never hand-edit.
- `mods/<name>/claude/` is the plugin itself.
- `shared/` holds TypeScript helpers several mods use. A mod lists the ones it needs in
  `"shared"` in its mod.json; `scripts/mods generate` copies them to
  `mods/<name>/claude/hooks/shared/` (committed, so each mod installs on its own). Edit
  `shared/`, never the copies. Only helpers that never touch `$` live there: the engine does not
  follow `$` across an import, and `claude plugin validate` lists a mod's `$` calls (env, http,
  store) from the mod's own files, so code that uses `$` stays in each mod on purpose.
- `shared/<name>.inject.ts` is code that uses `$` and several mods need (the Jev client and log
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
  host can and cannot do is in `docs/COMPATIBILITY.md`; update it when a mod gains or loses a host.
  A host adapter reads its options only from the user's config dir, never a repository file.
  A terminal UI plugin for OpenCode is `host/tui.ts`, built into `opencode/tui.js` with `@opentui/core` left external
  (see `scripts/host-shims`).
  `host_files` in mod.json copies a plugin file (a helper script) into each host package.
  `prompt-gate` and `skill-pick` run the exported `gate`/`choose` of their `register.ts` on a Node
  stand-in for the engine (`host-lib/engine.ts`), so that file may import only types from
  `claude-code`; `scripts/host-shims/claude-code.d.ts` models those types for `typecheck --hosts`.
- `local/` is gitignored: private mods (`local/mods/<name>/`) installed with `--local`.
- `scripts/modslib/` is the CLI package; `tests/` is its pytest suite; `.github/` holds CI.
- `private-patterns.txt` (gitignored, one regex per line; see `private-patterns.example.txt`)
  adds patterns to the `scripts/mods validate` private scan. The built-in patterns cover
  absolute home paths, private IPv4 ranges, and any email address except `iulian.dita@gmail.com`,
  `noreply@users.noreply.github.com`, and placeholders (`example.com`, `example.org`,
  `example.net`, `*.example`). Files with NUL bytes are scanned too (UTF-16/32 decoded, else
  as latin-1).

## House rules

- Branches: `develop` is the default and v0.x prerelease channel. `main` becomes the stable
  release channel at v1.0.0. Every change by branch and PR. Conventional commits.
- Never add AI attribution to commits, PRs, tags, or files.
- Keep private hosts, domains, machine paths, and work context out of tracked files. The
  `scripts/mods validate` private-pattern scan enforces part of this.
- Security mods fail closed: a guard mod must report at least one gating hook, and every
  gating hook needs `.catch`.
- Run before pushing: `python3 -m pytest -q -m "not integration"`, `bun test mods/*/host`,
  `scripts/typecheck --hosts`, `scripts/mods validate`, and `scripts/mods generate --check`. Integration tests need the claude CLI and use a throwaway
  config dir; run them with `python3 -m pytest -q -m integration`.
- After changing a mod's TypeScript, run `scripts/typecheck [mod]` and `claude plugin test
  mods/<name>/claude`. The type check needs the API types the engine lays beside a mod it has
  loaded (`mods/*/claude/.claude-plugin/types`; the engine writes a `.gitignore` containing `*`
  there, so it stays untracked), so load a mod from this clone once.
  CI does not run it: `claude plugin validate` and `claude plugin test` do not lay those types
  (checked on 2.1.296), only a real session does, and that needs a logged-in claude.
- A session loads installed mods from the clone's checked-out branch, so a half-edit can break
  the guard running in that very session. Edit in a `git worktree` and copy the untracked
  `mods/*/claude/.claude-plugin/types` into it so `scripts/typecheck` finds the engine types.
- Claude Desktop does not place panes. A mod that must show something there draws in the band
  above the prompt (`ui.render` with `{ component: 'AbovePrompt' }`, skipped on the terminal when
  the terminal has its own surface) and stacks on `await next(e)` instead of replacing it, so
  several mods can share the band.
- `guard-rules` marks every shell shape outside its modeled grammar unparsed. A bypass fix comes
  with a corpus row or a `PUSH_FORMS` entry in `corpus.test.ts`, not only a code change.
- The secret-box hook rewrites any Bash command that contains a secret placeholder: write such
  text with the file tools, not in a shell command.
- Security findings get an issue labeled `security` and `p0` to `p3` before the fix; a `p0` (a
  working bypass or leak with a concrete input) is fixed at once, the rest are scheduled.
