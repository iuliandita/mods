# secret-box

Keeps secret values out of the chat. You store a secret once, in your OS keyring, from a terminal.
After that the model writes `{{secret:NAME}}` in a Bash command, the value is filled in only when
the command runs, and any known value that still reaches the conversation is replaced with its
placeholder.

- **placeholders**: a Bash command containing `{{secret:NAME}}` (`NAME` is letters, digits, `.`, `_`
  and `-`) is rewritten to run through the bundled `secret-box exec` helper. The helper puts the value
  in an environment variable of the child shell, so it is never in the argv of the helper or of bash.
  The program the command runs (curl, say) sees the value in its own argv if the command puts it
  there, so prefer stdin or config forms (`curl -K -`, `--data @-`). A command without a placeholder
  is not touched, so other guards still see it as written.
- **scrubbing**: each stored value, and its JSON-escaped, URL-encoded and base64 forms (including
  base64 of text around it, like `user:<value>`), are replaced with `{{secret:NAME}}` in every row the conversation keeps (your prompts, command output, the model's
  text, tool results, hook context, notes, attachments such as @-mentioned files and file-change
  diffs, other agents' messages, compaction summaries, notices) and in messages sent to other
  agents. Values shorter than 6
  characters are never scrubbed; `secret-box set` warns about them.
- **fails closed** for placeholder commands only: if the stored values cannot be loaded, a Bash call
  with a placeholder is denied before it runs, and the reason tells the model what to check.
  Scrubbing is best-effort: when loading fails it is off (one toast says so) and is retried at most
  every 30 seconds.

Hooks only, no UI. Portability to other Claude surfaces is expected, but only terminal behavior
is verified; Desktop, VS Code and headless behavior remain untested.
Egress: none (no network, no model calls). One backend in this version: libsecret through
`secret-tool` (Linux). macOS, Windows and other backends are not supported yet.

## Compatibility status

- Claude Code: verified on 2.1.296 in the terminal.
- Desktop, VS Code and headless: untested.
- Mode: `on` by default; available modes are `off`, `dry` and `on`.
- Egress: none. Requirements: `secret-tool`, `python3` and `bash` (Linux Secret Service).

These facts match `mod.json`. See [installation and recovery](../../INSTALL.md) and
[contributor checks](../../CONTRIBUTING.md) for scope and validation limits.

## Install

    claude plugin marketplace add iuliandita/mods
    claude plugin install secret-box@iuliandita-mods

Needs `secret-tool` (package `libsecret-tools` on Debian and Ubuntu, `libsecret` on Arch and Fedora),
Python 3, `bash`, and an unlocked keyring (GNOME Keyring, KWallet's Secret Service, or similar).

## Add a secret

Run this in a terminal, not in the chat. The value is read with a hidden prompt and goes straight to
the keyring:

    <plugin folder>/bin/secret-box set NAME

`/secret-box` prints the exact path for your install. Then tell the model the name, and it uses
`{{secret:NAME}}` in commands:

    curl -H "Authorization: Bearer {{secret:github.token}}" https://api.github.com/user

Other commands of the helper:

    secret-box names [--json]    list stored names
    secret-box remove NAME       delete a secret
    secret-box exec -- SCRIPT    run SCRIPT with its placeholders filled in (what the hook calls)

A placeholder for a secret that is not stored makes the command exit 3 with a line naming it and
nothing runs. A placeholder inside single quotes (`'...'` or `$'...'`, also inside `$(...)` or
backticks within double quotes) would not expand, so it exits 4 and nothing runs; use double quotes.

## Slash command

    /secret-box           mode, stored secret names, helper path, how to add one
    /secret-box reload    re-read the keyring after adding or removing a secret

The status shows names only, never values. Known values are also reloaded after every command the
hook rewrites; the values that command ran with are still scrubbed from its own output if the reload
no longer has them.

## Codex and OpenCode

Install steps are in [INSTALL.md](../../INSTALL.md); what differs from Claude Code and why is in
[docs/COMPATIBILITY.md](../../docs/COMPATIBILITY.md). Only the Linux keyring backend exists.

- Codex: a `PreToolUse` hook on `Bash` replaces a placeholder command with the helper running it
  (`secret-box exec --scrub -- '...'`). The helper fills the values in and filters known values out
  of the command's own output. Codex hooks cannot rewrite results or the conversation, so nothing
  else is scrubbed: a value that reaches the chat by another route (a file the model reads, a prompt
  you typed) stays. The hook answers `allow`; the sandbox still applies to the rewritten command.
  Trust the hook once with `/hooks`.
- OpenCode 2.x: the same rewrite in `execute.before`, plus scrubbing of every tool result, of the
  messages the model sees again, and of the prompt as typed.
- The mode is read from `~/.config/iuliandita-mods/secret-box.json` (`{"mode": "on"}`; `off`, `dry`
  or `on`). An unreadable file counts as `on`. Nothing is read from a repository.
- The helper holds back the last few bytes of each stream until more output arrives or the command
  ends, so a value split across two reads is still caught; output can trail the command slightly.
- There is no `/secret-box` command on these hosts; run `secret-box names` in a terminal.
- A Codex hook that cannot start lets the command through with its placeholder unfilled (it holds
  no secret), so this hook does not use the fail-closed wrapper that `guard-rules` does.

## Options

Set it in the plugin's config menu or in `pluginConfigs` in your settings.

| Option | Default | Meaning |
|---|---|---|
| `mode` | `on` | `off` does nothing; `dry` only shows a toast for what it would rewrite or scrub; `on` enforces |

## Limits

This is not a security boundary.

- It catches exact known values and their JSON-escaped (including the ASCII `\uXXXX` form of a non-ASCII value, as `json.dumps` prints it), URL-encoded and base64 forms, not derived ones (a hash, a
  value split across lines, a different encoding, a value with a character changed).
- The child process holds the value in its environment and can print it. The output is then scrubbed
  on the way into the conversation, but only if it matches one of the forms above.
- A rewritten call's stored `tool_use` keeps the original command text, with placeholders and never
  a value.
- A rewritten command runs in a fresh `bash -c`: `cd`, `export`, aliases and shell functions from
  earlier calls are not carried into it, and its changes are not carried out. It is not your
  interactive shell, so zsh syntax and glob rules differ, and an unquoted placeholder is word-split
  and globbed after it expands. Quote it: `"{{secret:NAME}}"`.
- Placeholders in quoted heredocs (`<<'EOF'`) are not expanded. The single-quote check does not
  parse heredocs or `case` patterns, so an apostrophe in a heredoc body or a `pattern)` inside
  `$(...)` can confuse it.
- Bash permission rules (allow and deny patterns) see the wrapper command
  `<wrapper> exec -- '...'`, not the original. Do not allow `<wrapper> exec:*` broadly.
- `secret-box values` prints every secret, and the model can run it through Bash. The scrubber
  catches that output only in the raw and escaped forms above; a transformed copy (reversed,
  base64 of a split value, split across lines) is not caught. The keyring protects values at rest
  and from accidental display, not from a model that is told to exfiltrate them.
- Rows are rewritten when they are stored. The screen may show a row just before its rewrite.
- The model's own tool calls and thinking blocks cannot be rewritten by a hook. If the model writes a
  literal value into a command, that stored `tool_use` keeps it; the value is scrubbed from the rows
  that follow.
- Bash output is also scrubbed in the answer the transcript keeps, for every Bash call in mode `on`:
  every string anywhere in it (`stdout`, `stderr`, `text`, an error text, the model-facing hints,
  `structuredContent`, diffs and other nested fields, up to 12 levels deep; anything deeper is
  replaced by a notice), and object keys too. The path fields (`persistedOutputPath`, `rawOutputPath`)
  are left as they are.
- A row's `content` is what a hook can rewrite. The engine stores some parts of a row as made, out of
  a hook's reach: an attachment's payload (the transcript keeps the raw @-mentioned file or diff; the
  model reads only the scrubbed rendering) and the structured record of a non-Bash tool's result (Read,
  Grep and others; their model-facing text is scrubbed). These may keep a value in the transcript file.
- When a Bash result points at a saved output file (a long output is kept in a file), the file is
  scrubbed in place in mode `on`, after the answer itself: it is rewritten only if it held a known
  value. Only a regular file (not a link) that is a direct child of a `tool-results` folder (absolute, normalized path), up to 4 MiB, is touched;
  a larger file is never scrubbed in place. If the file cannot be checked, read or written, or is
  too large or in an unexpected place, it is left unchanged and one toast per session says
  `could not scrub the saved output file` with a short reason; it may still hold a secret. The
  file existed unscrubbed between the command finishing and the rewrite. Mode `dry` reads and
  writes nothing.
- If the hook fails or runs out of time after the command ran (a hung file step, say), the fallback
  scrubs the answer only: it does no file work and shows no toast, so the saved file may keep a
  value. The file step is the likely cause of such a failure, so the fallback does not repeat it.
- Whether a secret typed into the chat reaches the prompt-history file before a hook can rewrite it
  is unverified. This mod does not promise otherwise. The supported path is
  `secret-box set` in a terminal; do not paste secrets into the chat.
- Detection of a pasted, unknown secret is not part of this version.

## Development

    claude plugin test mods/secret-box/claude
    claude plugin validate --strict mods/secret-box/claude
