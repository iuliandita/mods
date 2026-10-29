# Changelog

## [Unreleased]

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

[Unreleased]: https://github.com/iuliandita/mods/compare/v0.1.0...develop
[0.1.0]: https://github.com/iuliandita/mods/releases/tag/v0.1.0
