# Changelog

## [Unreleased]

### Added

- `notify` mod: a desktop notification when the agent finishes or waits on a permission prompt or other input, titled with the project folder, with an optional sound (off by default). Uses `notify-send` on Linux and `osascript` on macOS, warns once when none is available, and makes no network calls. Runs on Claude Code (hooks), Codex (hooks or its `notify` setting) and OpenCode (plugin events); untested on real hosts.

- `secret-box` automatically uses macOS Keychain through `security`, with platform-specific catalog requirements; Linux keeps `secret-tool`.

- `secret-box` option `secretScopes` limits named placeholders to configured directory globs on all three hosts.

- `guard-rules` option `modeUnparsed` (`on`, `dry`, `off`) controls parser findings separately; `on` preserves existing behavior and `ask` remains unsupported.

### Changed

- `secret-box` setup, platform requirements and protection limits are aligned across the root docs, security policy and catalog descriptions.

- `secret-box` summarizes scrubbing, keyring and scope limits per host in a single README section.

- `guard-rules` documents rule controls and common false positives in its README, with parser details on a linked page.

### Fixed

- `delegation-board` on OpenCode honors `mode` `off` from the user-level options file; the panel shows a notice and reads no sessions.

- `statusline` clears the branch's PR badge when the repository or branch changes, so a failed lookup no longer shows the previous branch's PR.

- `secret-box` on OpenCode keeps object keys and the `role` and `type` values when a scrub fails, so messages stay readable; `exec` always scrubs its output (`--scrub` is still accepted); the helper reply is raw UTF-8, so large non-ASCII saved files fit the 4 MiB limit.

- `scripts/mods uninstall` always prints the Codex and OpenCode steps for retired mods, treats "not installed" in Claude Code as a skip and a missing `claude` CLI as a note, and keeps the steps in the payload when the Claude uninstall really fails.

- `guard-rules` checks literal pipeline producer words in command runners, executable `man` options and command-bearing environment values; computed pipeline output remains a documented limit.

- `guard-rules` allowlists editor flags, disables data exemptions after command-resolution changes, and checks dynamic `git -C` directories even with `modeUnparsed=off`.

- `secret-box` removes the plaintext `values` command; hooks use batched `scrub` calls instead. Directory and Bash-only placeholder limits are documented per host.

- `guard-rules` narrows data exemptions for scripts, path-qualified commands and editor options, and checks git writes after unresolved directory changes independently of `modeUnparsed`.

- `guard-rules` treats file arguments and known data commands as data while keeping command runners guarded.
- `guard-rules` follows both plain and scrubbed `secret-box exec` wrappers when checking commands.

### Removed

- Breaking: the `prompt-gate` and `skill-pick` mods, with their shared helpers, the Jev client and
  the Codex and OpenCode adapters. Neither showed a measured benefit, and both made a model call
  per prompt. No prompt leaves the machine through mods now. To remove an existing install, run
  `scripts/mods uninstall prompt-gate skill-pick` at the scope you installed at; it also prints the
  Codex and OpenCode steps. `scripts/mods list` shows them as retired while installed.

## [0.2.0] - 2026-10-29

Second collection prerelease, tagged on `develop`. Individual plugin versions are unchanged.

### Breaking

- `scripts/mods` usage errors (unknown command or flag, bad arguments) now exit 2 instead of 1.
  Scripts that test for exit 1 should accept 2 as well.
- A missing `claude` CLI or pinned `bun` now exits 3 instead of 1. Install the tool, or treat 3
  as "required tool missing".
- Human-readable errors now go to stderr with an `error:` prefix and a next step, not to stdout.
  Scripts that parse error text from stdout should read stderr or use `--json`, which still
  prints `ok` and `errors` on stdout.

### Changed

- `scripts/mods --help` lists Environment and Exit codes sections.
- README has a logo, a status line and the shared section layout.
- Changelog uses Keep a Changelog headings and compare links.

### CI

- Job ids are `lint`, `test` and `integration`; a new `security` workflow runs a secret scan
  and a workflow audit.
- A `release` workflow publishes GitHub release notes from this changelog on tag push; `v0.*`
  tags must be on `develop`.
- The shared stack canon is vendored and checked in `lint`; a weekly `stack-sync` workflow
  opens an issue on drift.
- Release process is documented in CONTRIBUTING.md.

### Docs

- Recorded Claude Code 2.1.301 terminal smoke checks for `prompt-gate`, `skill-pick`,
  `delegation-board` and `statusline` in the compatibility docs and generated catalog.
  Other Claude surfaces remain unverified.
- CI still uses a fixed CLI version; individual mods can record runtime verification on
  different versions without rewriting older evidence.

## [0.1.0] - 2026-10-15

First collection prerelease. Individual plugin versions remain independent of this tag.

- Mod schema: `mods/<name>/mod.json` with a plugin under `mods/<name>/claude/`.
- Generated `.claude-plugin/marketplace.json` and `mods.json` catalog (`scripts/mods generate`).
- Installer CLI `scripts/mods` with `list`, `install`, `uninstall`, `doctor`, `validate`, and
  `generate`; `--json` output on every command.
- `validate` gates: generated files up to date, private-pattern scan, and
  `claude plugin validate --strict`.
- CI workflow: unit tests and `validate --no-claude`, plus integration tests and full `validate`
  against the real claude CLI.
- `local/` (gitignored) for private mods, installed with `--local`.
- Mod `guard-rules`: blocks AI attribution, direct commits to protected branches, wrong git
  identity, and mutating kubectl, helm and terraform calls on protected or unclassified
  environments.
- Mod `secret-box`: keeps secrets out of the chat; a secret placeholder in a Bash command is
  filled in from the OS keyring at execution time and known values are scrubbed from output.
- Mod `prompt-gate`: a small model flags a vague prompt and asks one short question; default
  mode `dry` only measures.
- Mod `skill-pick`: names the 1 to 5 installed skills that fit each prompt; default mode `dry`.
- Mod `delegation-board`: a live pane of the session's subagents and teammates.
- Jev cascade in `prompt-gate` and `skill-pick`: with a TypeSafe key set, Jev signals are
  combined with Haiku; the prompt goes to a third party, restrictable with `jevPaths`.
- Shared TypeScript helpers live in `shared/` and `scripts/mods generate` copies them into each
  mod; `generate` removes only unlisted copies that carry the generated header and reports
  any other file as an error. The Jev client and log helper are one template injected between
  markers in each mod's `register.ts`; `generate --check` flags a block that drifted.
- Installer: `uninstall` also finds private mods and resolves a name present as both public
  and local to the public one; a `--source` that looks like a flag is rejected; a git URL or
  relative `--source` no longer re-adds the marketplace on every install; `list` reports a
  failed installed-plugin read as an error and accepts `--scope`; CLI errors are structured
  (`ok` and `errors`) under `--json`. Install docs say `scripts/mods install` registers the
  clone (or `--source`), not the GitHub marketplace.
- Private scan: reads files with NUL bytes (UTF-16, UTF-32 with or without a byte-order mark)
  and flags email addresses other than the public identifier and placeholders.
- CI: actions pinned to commit SHAs, claude-code pinned in one env var and checked against
  every `verified_on` by a test, `pytest` pinned, dependabot also watches pip.
- Hardening: `secret-box` scrubs the persisted Bash output, every session row kind and
  structured results (keys of user data too, never the engine's own fields). `guard-rules`
  treats anything outside its modeled shell grammar as unparsed when the text names a
  protected tool, tracks branch, directory, env, context and workspace as sets of possible
  states, and probes git identity with an exact environment allowlist.
- Behavior change in `guard-rules`: relaxed context and workspace patterns now match on a
  word boundary (`-`, `_`, `.`, `/`, `:`, `@`), so a name like `devops-eu` or `testing` is no
  longer relaxed by `*dev*` or `*test*` and falls back to unclassified.
- Security round 5: `guard-rules` reads `$"..."` locale strings, cuts `$'...'` at NUL, follows
  `sudo -s/-i` and `env -S` command strings, treats a dynamic checkout, switch or rebase operand and
  `git symbolic-ref HEAD` as an unknown branch, denies a later commit or implicit push after a git
  config write or `GIT_CONFIG_*` include, and reads the kubeconfig `current-context` and a Terraform
  workspace strictly (anything not plain is unclassified). `secret-box` also scrubs the ASCII
  `\uXXXX` JSON form of a non-ASCII secret.
- `guard-rules` option `unprotectedRepos`: path prefixes of repositories exempt from the
  protected-branch rule only; attribution and identity still apply there.
- `guard-rules` also runs on Codex (plugin with a `PreToolUse` hook) and OpenCode 2.x (plugin),
  from the same rules code. New `hosts` field in `mod.json`, bundles built by `scripts/mods
  generate` with the Bun version in `.bun-version`, a generated `.agents/plugins/marketplace.json`,
  and `docs/COMPATIBILITY.md` with what works on each host for every mod, and why.
- `secret-box` also runs on Codex and OpenCode 2.x. The helper's `exec --scrub` fills placeholders in
  and filters known values out of the command's own output (a Python port of the scrubber, checked
  against the TypeScript one); OpenCode also scrubs tool results, the conversation and the prompt.
  New `host_files` field in `mod.json` copies a plugin file into each host package.
- `prompt-gate` and `skill-pick` also run on Codex (a `UserPromptSubmit` hook with a detached
  dry-run measurement, a nested low-effort luna session as the small model) and OpenCode 2.x (a low-effort DeepSeek Flash
  model call and the host's skill list). `scripts/typecheck --hosts` checks them against a stand-in for the
  engine types.
- `statusline` and `delegation-board` also run on OpenCode 2.x as terminal UI plugins (`opencode/tui.js`,
  listed in `~/.config/opencode/cli.json`): a one-line status and a panel of child sessions. Codex
  has no way to draw from a plugin. `scripts/mods generate` builds `host/tui.ts` into `opencode/tui.js`.
- OpenCode prompt advisers honor a changed model setting on the next call, including when an
  earlier request is still in flight.
- Host limits and costs: Codex secret scrubbing covers only helper-wrapped commands; prompt
  advisers use plan tokens on Codex and the selected model provider on OpenCode, including in
  `dry` mode. On these hosts `jevPaths` restricts all model calls. OpenCode terminal UI plugins
  use host data without their own model or forge calls.
- `prompt-gate` and `skill-pick` dry mode releases the prompt first and measures from a clock
  timer afterwards; `delegation-board` resets on `/clear` and prints a text table when its pane
  is not placed (Claude Desktop).

[Unreleased]: https://github.com/iuliandita/mods/compare/v0.2.0...develop
[0.2.0]: https://github.com/iuliandita/mods/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/iuliandita/mods/releases/tag/v0.1.0
