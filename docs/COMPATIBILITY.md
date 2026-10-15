# Host compatibility

The mods were written for Claude Code. Some of their logic does not depend on it, so a mod can
run on Codex or OpenCode when the host gives a hook enough power to do the job. This page says,
for every mod and host, what works, what does not, and why.

Labels: **works** (run on the real host), **not ported** (the host can do it, nobody has ported
it, with what would be lost if anything), **not possible** (the host cannot do it).

Versions checked: Claude Code 2.1.296, Codex CLI 0.162.1, OpenCode 2.0.29.

| Mod | Claude Code | Codex | OpenCode |
| --- | --- | --- | --- |
| `guard-rules` | **works** (terminal verified) | **works** | **works** |
| `secret-box` | **works** (terminal verified) | **not ported**; placeholders only, see below | **not ported**; the host can do nearly all of it |
| `prompt-gate` | works, untested | **not ported**; needs its own model client and key | **not ported**; the host offers a model call |
| `skill-pick` | works, untested | **not ported**; needs its own model client and key | **not ported**; the host lists skills and offers a model call |
| `delegation-board` | works, untested | **not possible**: hooks cannot draw anything | **not ported**; its UI plugin entry is not evaluated yet |
| `statusline` | works, untested | **not possible**: the status line only takes built-in items | **not ported**; its UI plugin entry is not evaluated yet |

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
| Not checked | | text typed into a running terminal session (`write_stdin`) | other tools than `shell` |

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
- **The options and class files are not protected from a model that can write files.** The same
  holds for the Claude plugin's settings. The guard is for accidents, not a security boundary.
- **OpenCode: v2 plugin API only.** The older `@opencode-ai/plugin` API (OpenCode 1.x) is not
  covered. A plugin is added by path in `plugins` in `opencode.json`; there is no marketplace.

## secret-box

| | Claude Code | Codex | OpenCode |
| --- | --- | --- | --- |
| Fill a placeholder in a command | rewrites the Bash command | possible: `PreToolUse` can replace the command | possible: `execute.before` can change the input |
| Scrub a value from command output | rewrites the tool result | **not possible** in a hook: `PostToolUse` cannot redact output (the helper could scrub its own output) | possible: `execute.after` can change the result |
| Scrub every conversation row | `session.append` and `session.send` | **not possible**: no hook changes the conversation | possible: the v2 session `context` hook can change all messages |
| `/secret-box` status command | yes | no documented way | possible: v2 plugins can add commands |

The helper that reads the keyring (`bin/secret-box`) is a plain script and already works on any host.
The Linux keyring backend is the only one so far.

## prompt-gate and skill-pick

Both call a small model, and both hook the prompt. Codex's `UserPromptSubmit` can block or add
context but cannot rewrite the prompt, and a hook has no model of its own, so the mod would need
its own client and API key, which changes what leaves your machine. OpenCode's v2 plugin context
offers a model call through the host's own providers and a skill list, so a port is possible
there.

## delegation-board and statusline

These draw UI. Codex hooks cannot add a pane or a band, and its `tui.status_line` setting accepts
only built-in item names, so there is nothing to port to. OpenCode ships a terminal UI plugin
entry (`@opencode/plugin/tui`) that nobody has evaluated for this yet.

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
