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
| `secret-box` | **works** (terminal verified) | **works**, partly: placeholders and the command's own output, see below | **works** |
| `prompt-gate` | works, untested | **works**, needs `ANTHROPIC_API_KEY` for the small model | **works**; `on` runs as `flag` |
| `skill-pick` | works, untested | **works**, needs `ANTHROPIC_API_KEY`; no use records | **works**; no use records |
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
| Scrub the command's own output | rewrites the tool result | the helper filters its own stdout and stderr | `execute.after` rewrites the result, and the helper filters too |
| Scrub a tool result that is not a placeholder command | rewrites the tool result | **not possible**: `PostToolUse` cannot redact output | `execute.after` rewrites every shell result |
| Scrub every conversation row and the prompt | `session.append` and `session.send` | **not possible**: no hook changes the conversation or the prompt | session `context` and `prompt` hooks |
| `/secret-box` status command | yes | no documented way | not ported; use `secret-box names` |
| If the mod fails | denies a placeholder command | denies when the hook runs and fails inside its own code; a hook that cannot start lets the command through with the placeholder unfilled | denies a placeholder command |

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

The helper that reads the keyring (`bin/secret-box`) is a plain script. The Linux keyring backend is
the only one so far.

## prompt-gate and skill-pick

| | Claude Code | Codex | OpenCode |
| --- | --- | --- | --- |
| Hook | `prompt.submit` | `UserPromptSubmit` command hook | `session.prompt` hook |
| Small model | the engine's model call | the Anthropic Messages API with `ANTHROPIC_API_KEY` (`ANTHROPIC_BASE_URL` is honored when it is https or a loopback address); no key means "error" and the prompt goes through | the host's `generate.text` with its own default model (the mod's `model` option is ignored) |
| Stop a vague prompt (`on`) | drops it with the question | `decision: block` with the question; sending it again unchanged runs it | **runs as `flag`**: a throw stops the prompt but shows only a generic error, and the terminal UI sends it again |
| Add a note (`flag`, skill-pick `on`) | adds context | `additionalContext` | appends the note to the prompt text |
| Dry mode | measures from a timer after the prompt went on | the hook returns at once and starts a detached process that measures | measures from a timer in the host process |
| Skill catalog (skill-pick) | the engine's skill listing | read from `SKILL.md` files in the folders Codex uses | `skill.list` |
| Use records and agreement (skill-pick) | from the `Skill` tool call | **not possible**: Codex has no skill tool call to watch | **not ported** |
| Options | plugin options | `~/.config/iuliandita-mods/<mod>.json` | the same file |
| Stats | `/prompt-gate`, `/skill-pick` | `node .../<mod>.mjs summary\|last\|clear` | the same bundle |
| Privacy notice for Jev | toast | `systemMessage` on the first prompt | host log |

What was run on the real hosts, with a local stand-in for the Anthropic API (no real key was used):
on Codex 0.162.1 a vague prompt was blocked with its question and the same prompt went through
when sent again, `flag` put the note in the model's context, `dry` measured from the detached
process and logged a record, and skill-pick put a skill name from the real skill folders in the
model's context. On OpenCode 2.0.29 the note reached the model for both mods and `skill.list`
supplied the catalog. The host's own model call failed in this environment (the provider refused
the request for its default token limit), so the real OpenCode classification was not run; the
adapter treats that as an error and lets the prompt through.

Why the differences:

- **A Codex hook has no model.** The small model call needs your Anthropic key, so the prompt goes
  to Anthropic in addition to OpenAI. With `TYPESAFE_API_KEY` set it also goes to Jev, as in the
  Claude plugin; set `classifier` / `picker` to `haiku` or use `jevPaths` to limit that.
- **Dry mode on Codex needs a second process.** A hook must answer before the model sees the
  prompt, and the hook process ends with its answer, so a detached `measure` process does the work.
  It stops itself after 60 seconds.
- **Bounced prompts are remembered in a file on Codex** (the hook is a new process each time), in
  the mod's store under `~/.local/share/iuliandita-mods`, per working directory.
- **Where a prompt goes is announced once.** With `ANTHROPIC_API_KEY` set, the first dry-mode prompt
  carries a notice that prompts are sent to api.anthropic.com; with a Jev key, one for Jev. Dry mode
  does nothing (no process is started) while neither key is set.
- **The vocabulary file is confined.** `AGENTS.md` or `CLAUDE.md` is read only when it resolves to a
  regular file under the working directory, up to 64 KiB; skill files are read for their front
  matter only, at most 300 folders per directory and 100 repository skills, and the user's and
  system skills come before the repository's.
- **The OpenCode note is part of your message.** The flag line is appended to the prompt text, so
  it shows in the history.
- **OpenCode cannot bounce a prompt.** The hook's only way to stop one is to throw.

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
