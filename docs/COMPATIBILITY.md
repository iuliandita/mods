# Host compatibility

The mods were written for Claude Code. Some of their logic does not depend on it, so a mod can
run on Codex or OpenCode when the host gives a hook enough power to do the job. This page says,
for every mod and host, what works, what does not, and why.

Labels: **works** (the behavior described below was run on the real host), **untested**
(implemented, without recorded runtime verification), **not ported** (no adapter),
**not possible** (the checked host API cannot provide it). Verification of one behavior does
not verify every rule, mode or surface. Claude surface declarations remain in each `mod.json`.

Versions checked: Claude Code 2.1.296 (`guard-rules`, `secret-box`) and 2.1.301
(`delegation-board`, `statusline`), Codex CLI 0.162.1, OpenCode 2.0.29.

| Mod | Claude Code | Codex | OpenCode |
| --- | --- | --- | --- |
| `guard-rules` | **works** (terminal verified) | **works** | **works** |
| `secret-box` | **works** (terminal verified) | **works**, partly: placeholders and the command's own output, see below | **works** |
| `delegation-board` | **works** (terminal verified) | **not possible**: hooks cannot draw anything | **works**: a panel of child sessions, opened with `/board` |
| `statusline` | **works** (terminal verified) | **not possible**: the status line only takes built-in items | **works**, reduced: one line, no rate-limit bars |

## Claude terminal verification

On 2026-10-16, authenticated terminal sessions on Claude Code 2.1.301 checked:

- `delegation-board` 0.1.0: the pane opened on a real subagent spawn, showed running and completed
  parent/child rows and token totals, and matched `/board status`. `/board` closed and reopened
  it; `/board clear` removed finished rows.
- `statusline` 0.2.7: the band drew alongside the board, with live model, context, rate-limit,
  cache, cost and elapsed-time figures after real turns.

These were terminal smoke checks, not checks of every mode or segment. They did not verify
board failure/wait states, optional pricing or statusline resume. Desktop, VS Code and headless remain
unverified. Automated hook tests cover more branches with mocked engine interfaces; passing them
alone does not change a surface's status. CI's fixed CLI version is independent of each mod's
recorded runtime verification version.

## guard-rules

| | Claude Code | Codex | OpenCode |
| --- | --- | --- | --- |
| Blocks a call | `tool.call` hook returns `deny` | `PreToolUse` hook returns `permissionDecision: deny` | `execute.before` hook throws |
| Checked tool | `Bash` | `Bash` (shell and unified exec) | `shell` (and `bash`) |
| Rules | attribution, protected branch, identity, context | the same | the same |
| Options | plugin options | `~/.config/iuliandita-mods/guard-rules.json` | the same file |
| Classify an environment | `/guard-context` | `node .../guard-rules.mjs context` in your terminal | the same bundle |
| Dry mode | toast | `systemMessage` (not checked how Codex shows it) | written to the host log |
| If the guard itself fails | denies | denies; the hook command turns any failure into exit 2 | denies |
| Not checked | | text typed into a running terminal session (`write_stdin`); file tools other than `apply_patch`, `Edit`, `Write` | |
| Own files fenced off | n/a | `apply_patch`, `Edit`, `Write`, shell text | every non-shell tool, shell text |

What was run on the real hosts: a commit on `main` is blocked and the model sees the reason, and
the same commit goes through once the repository is listed in `unprotectedRepos`. The other rules
share the same code and its unit tests; they were not each run on Codex or OpenCode.

Why the differences:

- **Options come from a user-level file on Codex and OpenCode.** Codex documents no plugin
  options. OpenCode has them, but a repository's own `opencode.json` can set them too, so the
  guard would let a repository loosen it. The path is fixed under the account's home, not read
  from `$HOME` or `$XDG_CONFIG_HOME`, which a repository can set through a `.env` file.
- **Classifying an environment is a CLI, not a slash command.** Codex documents no way for a
  plugin to add a command. OpenCode v2 plugins can add one, but the CLI was enough. The CLI only
  changes a class from a terminal, and the hook refuses to run it for the model. That filter is
  best effort: it reads the command text, so a determined model can spell around it.
- **Codex lets a failed hook through.** With the hook exiting 1, Codex reported "PreToolUse
  Failed" and ran the command, so only exit code 2 blocks. The plugin's hook command maps any
  other failure (no `node`, a missing bundle, a crash) to 2, and the guard answers within 15
  seconds, inside the hook's 30 second timeout. The hook also needs your trust once (`/hooks` in
  Codex) or it is skipped.
- **Codex does not hook `write_stdin`.** Its docs say input written to a running terminal session
  does not run `PreToolUse` again, so a shell started in one call and fed commands in later calls
  is not checked.
- **The options and class files are only fenced off best effort.** The hook refuses shell
  commands that name their directories and file-edit tool calls aimed at them, by reading text and
  paths, so a path built at run time gets past it. A model that can run arbitrary code can still
  change them, as it can the Claude plugin's settings. The guard is for accidents, not a security
  boundary.
- **OpenCode: v2 plugin API only.** The older `@opencode-ai/plugin` API (OpenCode 1.x) is not
  covered. A plugin is added by path in `plugins` in `opencode.json`; there is no marketplace.

## secret-box

| | Claude Code | Codex | OpenCode |
| --- | --- | --- | --- |
| Fill a placeholder in a command | rewrites the Bash command | `PreToolUse` replaces the command with `secret-box exec --scrub -- '...'` | `execute.before` changes the shell input the same way |
| Optional `secretScopes` directory globs | checks the session directory | checks the hook directory and tool `workdir` | checks the project directory and tool `workdir` |
| Model calls to internal `values` | denies literal Bash calls and visible wrappers in mode `on` | the same pre-run check | the same pre-run check |
| Scrub the command's own output | rewrites the tool result | the helper filters its own stdout and stderr | `execute.after` rewrites the result, and the helper filters too |
| Scrub a tool result that is not a placeholder command | rewrites the tool result | **not possible**: `PostToolUse` cannot redact output | `execute.after` rewrites every tool's result and error |
| Scrub every conversation row and the prompt | `session.append` and `session.send` | **not possible**: no hook changes the conversation or the prompt | session `context` and `prompt` hooks |
| `/secret-box` status command | yes | no documented way | not ported; use `secret-box names` |
| If the mod fails | denies a placeholder command | denies when the hook runs and fails inside its own code; a hook that cannot start lets the command through with the placeholder unfilled | denies a placeholder command |

The [per-host limits summary](../mods/secret-box/README.md#what-it-does-not-protect) covers failed
loads, saved output, short values and child-process access. Scope and `values` checks are covered
by automated tests, not new real-host verification. They do not restrict arbitrary scripts or
other keyring clients, and scopes check only the call's starting directory.

What was run on the real hosts, with a throwaway file-backed store: on Codex 0.162.1 a placeholder
command ran through the helper and printed the placeholder, not the value, and the sandbox still
blocked a write in a read-only session after the hook answered `allow`; in the interactive UI an
escalated command asked for approval with and without a placeholder, so `allow` does not skip it.
On OpenCode 2.0.29 a
`printf '%s' <placeholder> | wc -c` printed the length of the value, and the single-quote check
refused a quoted placeholder. The Linux keyring backend (`secret-tool`) was not run through these
two hosts; the file backend is test-only.

Why the differences:

- **Codex cannot change what the model reads, only what runs.** So the helper does the filtering
  inside the command. A value that arrives through another tool (a file read, a web page, your
  own prompt) is not scrubbed on Codex.
- **The helper delays output.** To catch a value split across two reads it holds back the last few
  bytes of each stream until more arrives or the command exits.
- **The helper's scrubber is a port.** `bin/secret-box` carries a Python copy of the TypeScript
  scrubber's list of forms; `tests/test_secret_box_scrub.py` compares them and fails when they
  drift. One known gap: a lone UTF-16 surrogate has no JSON-escaped form in Python.
- **Codex hooks run as `allow`** so the replaced command is used. The documented rule is that
  `updatedInput` is accepted only with `allow`.

The helper that reads the keyring (`bin/secret-box`) is a plain Python script. It automatically
uses `secret-tool` on Linux or `/usr/bin/security` on macOS; Windows is unsupported. Both backends
keep the same helper commands. The macOS backend lists names from service-prefix metadata,
stores a versioned UTF-8/base64 envelope, and sends set commands over stdin instead of argv.
Its encoded set command must be under 4096 bytes. Backend tests mock `security`; real macOS
Keychain access, prompts and host integration remain unverified. The `requires_by_platform`
catalog field lets `scripts/mods doctor` check only the current platform's backend binary.

The Keychain command behavior follows Apple's [security manual](https://github.com/apple-oss-distributions/Security/blob/main/SecurityTool/macOS/security.1)
and its [command parser](https://github.com/apple-oss-distributions/Security/blob/main/SecurityTool/macOS/security.c).

## delegation-board and statusline

| | Claude Code | Codex | OpenCode |
| --- | --- | --- | --- |
| Draw anything | `ui.render` in the band above the prompt, a pane | **not possible**: hooks draw nothing, and `tui.status_line` takes only built-in item names | a terminal UI plugin (`ui.slot`, `ui.panel`) |
| statusline | two rows: model and effort, worktree and branch counts, lines changed, kube context, PR and issue counts, context, 5h and 7d limits, cache, cost, time | **not possible** | one line above the prompt: model, folder, branch, context tokens, cost, elapsed time, a running mark |
| delegation-board | a live pane of subagents and teammates, effort and prices | **not possible** | a panel of the session's child sessions: state, agent, time, tokens, cost, title |
| Open the board | `/board` | | `/board`, or **Delegation board** in the command palette (`ctrl+p`) |
| Setup | plugin install | | `plugins` in `~/.config/opencode/cli.json` (the global file; there is no project-level terminal config) |

The OpenCode terminal plugins do not read the Claude options or the user-level JSON option
files used by the hook adapters. Remove their entries from `cli.json` and restart OpenCode
to disable them. They make no model or forge calls of their own.

What was run on the real host (OpenCode 2.0.29): the statusline line drew above the prompt in and
out of a git repository, showed the branch, and redrew while a turn ran; after a real subagent run
the board listed it with its state, time, tokens and cost.

Why the differences:

- **OpenCode exposes no rate-limit figures, no PR or issue counts and no kube context** to a
  terminal plugin, and this port runs no `git`, `gh` or `kubectl` of its own, so those parts of the
  statusline are not there. The branch comes from the host's own VCS data.
- **No Solid build step.** The plugins draw with plain `@opentui/core` text nodes and a one-second
  timer instead of Solid components, so the packages need no JSX compiler; `@opentui/core` and the
  plugin API are supplied by the host at run time.
- **Subagents are child sessions.** The board has no effort or price table; it shows what the host
  records per session.
- **The keymap layer is global.** A layer in the default mode was accepted but its command never
  reached the palette.

## How a mod gets a host

A mod lists `hosts` in `mod.json`. Its host code lives in `mods/<name>/host/`, built into one file
per host by `scripts/mods generate` with the Bun version in `.bun-version`:

- `mods/<name>/codex/`: a Codex plugin (listed in `.agents/plugins/marketplace.json`).
- `mods/<name>/opencode/`: an OpenCode v2 plugin package.

The Claude plugin's hooks directory stays the source of the shared logic, so a fix lands once.

## Sources

- Codex hooks: <https://learn.chatgpt.com/docs/hooks> and the hook schemas in
  `codex-rs/hooks/schema/generated` of <https://github.com/openai/codex>.
- Codex plugins: <https://learn.chatgpt.com/docs/plugins.md>.
- OpenCode plugins: <https://opencode.ai/docs/plugins/> and the `@opencode/plugin` 2.0.29
  type definitions.
