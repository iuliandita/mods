# Changelog

## [Unreleased]

## [1.1.3] - 2026-11-15

The leftovers from the v1.1.2 review. Four plugins have a patch release in their Claude Code, Codex, and OpenCode manifests: `guard-rules` 1.1.2, `notify` 1.0.3, `delegation-board` 1.0.2, `statusline` 1.0.2. `secret-box` stays at 1.0.1.

Codex users: the `guard-rules` and `notify` plugins changed, so trust their hooks again in `/hooks` after the update. `scripts/mods doctor` reports hooks that are still untrusted.

### Changed

- `notify` no longer offers a `t3` option on Claude Code, where it was never read. Codex and OpenCode still read it from `notify.json` (#225).
- `guard-rules` judges only the directory of a `cd` that a later commit depends on when a pipeline sits between them (`cd X && a | b && git commit`); the `;` forms and a piped `cd` still judge both. The value of `git rebase -x` is no longer read as a branch (#224).

### Fixed

- `guard-rules` follows `git branch -m`/`-M` of the current branch and `git worktree add` like a switch, so a commit after renaming onto a protected name, or inside a just-added worktree of a protected branch, is denied (#224).
- `guard-rules` judges `git send-pack` like a push with explicit refspecs; without refs or with `--stdin` it is denied (#224).
- The `guard-rules` self-kill rule also denies killing the pids of a `pgrep -f` whose pattern matches the command itself: `kill $(pgrep -f X)` and `pgrep -f X | xargs kill` (#224).
- On Codex and OpenCode, `guard-rules` answers with a deny that names the cause when the account has no passwd entry, instead of an uncaught error (#224).
- `delegation-board`: `/board clear` also drops `unknown` rows, such as the engine's own forks, which could never settle (#225).
- `statusline` cancels its refresh timer when the session ends; a `/clear` or a resume keeps it (#225).
- `guard-rules/docs/limits.md` matches the code again: the lookup timeout on Codex and OpenCode, missing wrappers and context switchers, and entries for what stays uncovered (#224).

### CI and tooling

- The runners are on `ubuntu-26.04`. Node stays at 22 in CI, the oldest Node the hosts document, and Renovate no longer proposes Node or `@types/node` majors (#227).
- Dependency updates: TypeScript 5.9.3 for the host typecheck, zizmor 1.32.0.
- The secret-box and version tests share their helpers (#226).

## [1.1.2] - 2026-11-14

Fixes from a full review of the repository, including an independent review. Every plugin has a patch release in its Claude Code, Codex, and OpenCode manifests: `guard-rules` 1.1.1, `notify` 1.0.2, `secret-box` 1.0.1, `statusline` 1.0.1, `delegation-board` 1.0.1.

Codex users: the hook content of every plugin changed, so trust the hooks again in `/hooks` after the update. `scripts/mods doctor` reports hooks that are still untrusted.

### Changed

- `guard-rules` and `secret-box` no longer claim a verified Claude Code terminal run: no tracked record covers one, so their terminal surface in `mods.json` goes from `verified` to `untested` and `verified_on` is unset. `statusline` and `delegation-board` describe their Claude Desktop band as implemented and untested. `docs/COMPATIBILITY.md` separates what was run on a real host from what was checked against published types (#205).
- `guard-rules` and `secret-box` deny messages no longer suggest turning a rule or the mod off (#197, #198).
- `scripts/mods` follows its documented exit codes (1 failed, 2 usage, 3 required tool missing), and `validate` and `generate --check` report a host bundle check they could not run in a `skipped` key instead of passing silently. `doctor` reports the install `source` with its ref (`iuliandita/mods#main`) and `mods.json` gains `stable_source` (#180, #202).
- The plugin version gate compares against the highest `vX.Y.Z` tag in the repository, not the latest tag reachable from the branch (#196).
- `statusline` no longer promises that other mods' bands stack above it: from Claude Code 2.1.325 the engine orders the bands (#213).
- The worktree badge in `statusline` needs git 2.31 or newer.

### Fixed

- `guard-rules` parses command shapes that got past the lexer: backslash escapes, `${...}` expansions, directory changes earlier in a command, `--branches` pushes and git aliases. Command names spelled `=git` or in another case are treated as unparsed. 49 corpus rows cover the cases (#197).
- `secret-box exec --scrub` filters every value it injected, including ones resolved from another placeholder; if the values cannot be read to build the filter, `exec` exits 5 and nothing runs. More placeholder forms are recognized (#198).
- `notify` notifies in top-level T3 Code threads again (only delegated tasks count as child sessions), stops after a notifier timeout, and escapes markup in the notification body on Linux (#199).
- `statusline` follows the repository when the session changes directory, keeps its caches per repository, and reads stored options (#200).
- `delegation-board` truncates pane rows to the pane width and clears settled rows (#201).
- On Codex and OpenCode, a failed options read, a throwing first draw or a lookup child that ignores SIGTERM no longer breaks the host's render or keeps a caller waiting past its timeout (#203).
- `scripts/mods install` and `doctor` compare the ref when checking an existing marketplace source, so a clone following `develop` is no longer taken for the stable install (#180).

### CI and tooling

- The release workflow waits up to 20 minutes for a successful CI run on the tagged commit and fails without one. Dev requirements are a hashed lock installed with `--require-hashes`, the typecheck tools install from a lockfile, and pushes to `develop` and `main` no longer cancel each other's runs (#204).
- Removed the unused `shared` and `inject` keys from the generator; a `mod.json` that still carries one fails as an unknown field (#176).
- Dependency updates: GitHub Actions, pytest 9.2.0, markdownlint-cli2 0.24.0, the pinned Claude Code CLI 2.1.319.

## [1.1.1] - 2026-11-06

Only `notify` changed, from 1.0.0 to 1.0.1 in its Claude Code, Codex, and OpenCode manifests. Codex users: trust the `notify` hook again in `/hooks` after the update.

### Fixed

- `notify` skips detectable child and headless sessions, supports a process opt-out, and shows a fixed finish label from the current turn's final status marker. Local T3 child checks are read-only and optional; question cards notify once while waiting (#185). The plugin is now 1.0.1 on every host.

## [1.1.0] - 2026-11-04

Only `guard-rules` changed, from 1.0.0 to 1.1.0 in its Claude Code, Codex, and OpenCode manifests. The other plugins stay at 1.0.0.

### Added

- `guard-rules` denies a `pkill -f` call whose pattern matches the command that contains it, which killed the agent's own shell (exit 144). Exact, anchored and bracketed patterns pass. New option `modeSelfKill` (`on` by default, `dry` and `off` available) on Claude Code, Codex and OpenCode (#181).

## [1.0.1] - 2026-11-03

Plugin versions now match the stable release: every plugin is at 1.0.0 in its Claude Code, Codex, and OpenCode manifests (`guard-rules`, `secret-box`, `notify`, `delegation-board`, `statusline`). No plugin code changed since v1.0.0.

## [1.0.0] - 2026-11-03

First stable release. The plugin code is the same as v0.3.3, so plugin versions are unchanged: `guard-rules` 0.3.2, `secret-box` 0.3.2, `notify` 0.3.3, the rest 0.3.1. Collection tags do not set plugin versions.

### Changed

- `main` is now the stable channel and releases are tagged on it. The install commands in the READMEs, INSTALL.md and `mods.json` pin `main` (`iuliandita/mods#main` for Claude Code, `iuliandita/mods@main` for Codex). `develop` stays the default branch and the nightly; drop the suffix to follow it.
- SECURITY.md uses the shared Supported Versions wording: fixes land on `develop` and reach users through `main` and the next tagged release.

### Notes

- `notify` has not been verified on a real Claude Code, Codex, or OpenCode host; `docs/COMPATIBILITY.md` lists what each mod was verified on.

## [0.3.3] - 2026-10-29

Patch prerelease, tagged on `develop`. Plugin versions are unchanged: `guard-rules` 0.3.2, `secret-box` 0.3.2, `notify` 0.3.3, the rest 0.3.1.

Codex users: updating changes the `guard-rules` and `secret-box` hook content, so trust those hooks again in `/hooks` after the update. `scripts/mods doctor` reports hooks that are still untrusted.

### Added

- Renovate replaces Dependabot version updates (`renovate.json`: weekly schedule, 7-day cooldown, grouped GitHub Actions updates, OSV alerts). Automerge is off, so every Renovate PR needs a manual merge.
- `guard-rules` accepts opt-in `modeUnparsed=ask` on Claude Code for enforced parser findings; parsed violations still deny. Codex and OpenCode fall back to `on` with a warning.

### Fixed

- CI installs the pinned Claude Code CLI from a checked-in lockfile with `npm ci --ignore-scripts`, so the package integrity is verified; the version pin now lives in `.github/ci/claude-code/package.json`.
- `doctor` no longer doubles the `error:` prefix on Codex hook trust errors; INSTALL.md and the retired-mod steps say leftover Codex `hooks.state` entries for removed plugins are harmless.
- `secret-box` rechecks saved output metadata and link status immediately before writing, skips changed files, and documents the remaining race window in the engine API.
- `secret-box` merges overlapping known-value matches in the hooks and helper, including across streamed output chunks, so overlapping values leave no exposed tail.
- `guard-rules` scans decoded argument words for attribution and retains unparsed findings for encoded tool names, including when state combinations exceed the parser limit.
- `guard-rules` tracks Terraform argument injection and cloud target overrides, HOME changes and alternate git common directories; injected Terraform arguments no longer bypass mutation checks.
- `guard-rules` treats secret placeholders in context and workspace values as unknown targets, including switches earlier in the command.
- `guard-rules` leaves ambiguous kubeconfig keys and unsupported line breaks unclassified instead of falling through to a relaxed context in a later file.
- `guard-rules` treats cleared or removed infra target variables, empty values, changed HOME and privilege-wrapper environments as custom targets instead of using inherited relaxed lookups.
- `guard-rules` keeps explicit kubeconfig paths intact and tracks context switches by the first existing file in a `KUBECONFIG` list.
- `guard-rules` tracks more file writers, attached output options and `dd of=` paths; unresolved writer and redirect targets make later Kubernetes and Terraform writes unclassified.
- `guard-rules` invalidates stale kube context lookups after more documented switchers and cloud CLI aliases, and checks only the `oc config` verb for read exemptions.

## [0.3.2] - 2026-10-29

Patch prerelease, tagged on `develop`. Only the `notify` plugin changed (now 0.3.3); the other plugins stay at 0.3.1.

Codex users: updating changes the `notify` hook content, so trust the hooks again in `/hooks` after the update. `scripts/mods doctor` reports hooks that are still untrusted.

### Fixed

- `notify` clears `LD_LIBRARY_PATH` and `LD_PRELOAD` for Linux notifications so a host's bundled libraries do not break `notify-send`. Missing notifiers still warn without failing the session. The plugin is at 0.3.3.

### Changed

- `notify` titles a notification `<repo> (<harness>)`, such as `mods (Codex)`, and adds ` on <branch>` to the text, such as `Finished on develop`. The repo is the nearest parent folder with a `.git`; the branch is read from `.git/HEAD` without running git. The plugin is at 0.3.2.

## [0.3.1] - 2026-10-29

Patch prerelease, tagged on `develop`. All five current plugins are now at version 0.3.1.

Codex users: updating changes the hook content, so trust the hooks again in `/hooks` after the update. `scripts/mods doctor` reports hooks that are still untrusted.

### Fixed

- `notify` runs the Codex `Stop` hook synchronously with a one-second cap so `codex exec` waits for finish delivery. Permission hooks stay in the background, and notifier processes still have a 250 ms timeout.
- `notify` handles OpenCode 2.2.1 `session.execution.succeeded` and keeps legacy `session.idle` without double notifications per execution. Permission and form event names and payloads match the published 2.2.1 schema.
- `scripts/mods doctor` reports installed Codex hook trust and disabled state and fails for untrusted guard hooks. Install reminders and recovery docs explain re-trusting after every update; Codex hook labels identify the mod and event in `/hooks`.
- All five current plugins use version 0.3.1 in every host manifest so marketplace updates pick up their changes since v0.2.0. Lint now rejects shipped plugin changes without an increased version since the latest collection tag.

## [0.3.0] - 2026-10-29

Third collection prerelease, tagged on `develop`. Individual plugin versions are unchanged.

### Breaking

- `secret-box` removes the plaintext `values` command; hooks use batched `scrub` calls instead. Scripts that read values with `secret-box values` have no replacement by design; use `exec` to run a command with a placeholder. Directory and Bash-only placeholder limits are documented per host.
- `secret-box exec` always scrubs its output. `--scrub` is still accepted and changes nothing, but scripts that relied on raw output from `exec` now get scrubbed text.
- The `prompt-gate` and `skill-pick` mods are removed, with their shared helpers, the Jev client and the Codex and OpenCode adapters. Neither showed a measured benefit, and both made a model call per prompt. No prompt leaves the machine through mods now. To remove an existing install, run `scripts/mods uninstall prompt-gate skill-pick` at the scope you installed at; it also prints the Codex and OpenCode steps. `scripts/mods list` shows them as retired while installed.
- `guard-rules` is stricter in ways a script or workflow can depend on. It removes editor and pager file exemptions (use a file-reading tool for tool-named editor paths), disables exemptions for PATH tokens and `env -P`/`--path`, narrows data exemptions for scripts, path-qualified commands and editor options, and checks git writes after unresolved directory changes independently of `modeUnparsed`. Commands that were allowed before can now be denied; adjust the command, or set the mod's `mode` to `dry` or `off`.

### Added

- `notify` mod: a desktop notification when the agent finishes or waits on a permission prompt or other input, titled with the project folder, with an optional sound (off by default). Uses `notify-send` on Linux and `osascript` on macOS, warns once when none is available, and makes no network calls. Runs on Claude Code (hooks), Codex (hooks or its `notify` setting) and OpenCode (plugin events); untested on real hosts.
- `secret-box` automatically uses macOS Keychain through `security`, with platform-specific catalog requirements; Linux keeps `secret-tool`.
- `secret-box` option `secretScopes` limits named placeholders to configured directory globs on all three hosts.
- `guard-rules` option `modeUnparsed` (`on`, `dry`, `off`) controls parser findings separately; `on` preserves existing behavior and `ask` remains unsupported.

### Changed

- `secret-box` setup, platform requirements and protection limits are aligned across the root docs, security policy and catalog descriptions.
- `secret-box` summarizes scrubbing, keyring and scope limits per host in a single README section.
- `guard-rules` documents rule controls and common false positives in its README, with parser details on a linked page.
- `scripts/mods list|install|uninstall --help` describe `--scope`; INSTALL.md, CONTRIBUTING.md and AGENTS.md list `stack-check.py` and the exit codes, and `docs/README.md` links every mod.

### Fixed

- `secret-box` replaces provider-executed OpenCode tool calls and results with plain text notices after a scrub failure, so Anthropic accepts the history without unchecked server-tool payloads.
- `secret-box` scrubs outgoing messages and system content for OpenCode 2.2.1 compaction, generate and title requests as well as primary context, including user `!` shell output, with shared failure withholding.
- `secret-box` keeps OpenCode 2.2.1 tool-call inputs, provider execution flags, result objects, Error instances and typed prompts usable after a scrub failure, and checks non-enumerable Error fields during scrubbing.
- `guard-rules` disables exemptions for PATH tokens and `env -P`/`--path`, checks loop output through `done`, and recognizes `ssh`, `php`, `lua`, `tclsh`, `at`, `crontab` and `batch` as input executors.
- `notify` runs Codex hooks in the background, caps notifier delivery at 250 ms on both Codex entry paths, and skips events with `agent_id`.
- `guard-rules` removes editor/pager file exemptions, checks data-command inline input and PATH writes, and limits producer checks to named input executors; use a file-reading tool for tool-named editor paths.
- `delegation-board` on OpenCode honors `mode` `off` from the user-level options file; the panel shows a notice and reads no sessions.
- `statusline` clears the branch's PR badge when the repository or branch changes, so a failed lookup no longer shows the previous branch's PR.
- `secret-box` on OpenCode allowlists message roles and content-part fields after a scrub failure, discards arbitrary keys and nested payloads, and withholds results and prompts entirely.
- `secret-box exec` always scrubs its output (`--scrub` is still accepted); the helper reply is raw UTF-8, so large non-ASCII saved files fit the 4 MiB limit.
- `scripts/mods uninstall` always prints the Codex and OpenCode steps for retired mods, treats "not installed" in Claude Code as a skip and a missing `claude` CLI as a note, and keeps the steps in the payload when the Claude uninstall really fails.
- `guard-rules` checks literal pipeline producer words in command runners, executable `man` options and command-bearing environment values; computed pipeline output remains a documented limit.
- `guard-rules` allowlists editor flags, disables data exemptions after command-resolution changes, and checks dynamic `git -C` directories even with `modeUnparsed=off`.
- `guard-rules` treats file arguments and known data commands as data while keeping command runners guarded.
- `guard-rules` follows both plain and scrubbed `secret-box exec` wrappers when checking commands.

### Removed

- The `prompt-gate` and `skill-pick` mods (see Breaking).

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

[Unreleased]: https://github.com/iuliandita/mods/compare/v1.1.3...develop
[1.1.3]: https://github.com/iuliandita/mods/compare/v1.1.2...v1.1.3
[1.1.2]: https://github.com/iuliandita/mods/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/iuliandita/mods/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/iuliandita/mods/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/iuliandita/mods/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/iuliandita/mods/compare/v0.3.3...v1.0.0
[0.3.3]: https://github.com/iuliandita/mods/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/iuliandita/mods/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/iuliandita/mods/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/iuliandita/mods/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/iuliandita/mods/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/iuliandita/mods/releases/tag/v0.1.0
