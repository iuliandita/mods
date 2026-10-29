# secret-box

Resolves named placeholders from Linux Secret Service or macOS Keychain when a command runs.
Store a secret from your terminal, then use `{{secret:NAME}}` in commands. Optional directory
scopes restrict placeholder use, and known values are scrubbed where the host's hooks allow it.
See [what it does not protect](#what-it-does-not-protect) for the limits on each host.

- **placeholders**: a Bash command containing `{{secret:NAME}}` (`NAME` is letters, digits, `.`, `_`
  and `-`) is rewritten to run through the bundled `secret-box exec` helper. The helper puts the value
  in an environment variable of the child shell, so it is never in the argv of the helper or of bash.
  The program the command runs (curl, say) sees the value in its own argv if the command puts it
  there, so prefer stdin or config forms (`curl -K -`, `--data @-`). A command without a placeholder
  is not touched, so other guards still see it as written.
- **scrubbing on Claude Code**: each stored value, and its JSON-escaped, URL-encoded and base64 forms (including
  base64 of text around it, like `user:<value>`), are replaced with `{{secret:NAME}}` in every row the conversation keeps (your prompts, command output, the model's
  text, tool results, hook context, notes, attachments such as @-mentioned files and file-change
  diffs, other agents' messages, compaction summaries, notices) and in messages sent to other
  agents. Values shorter than 6
  characters are never scrubbed; `secret-box set` warns about them.
- **placeholder failures**: if the stored values cannot be loaded, a Bash call
  with a placeholder is denied before it runs, and the reason tells the model what to check.
  Scrubbing runs through the helper in batches, using current keyring values on every call.
  If that check fails, checked text is withheld; a sent message is refused. Saved files remain
  best-effort and may stay unchanged. Hooks never request a plaintext export of stored values.

Hooks only, no UI. Portability to other Claude surfaces is expected, but only terminal behavior
is verified; Desktop, VS Code and headless behavior remain untested.
Egress: none (no network, no model calls). The helper selects libsecret through `secret-tool`
on Linux and Keychain through `/usr/bin/security` on macOS. Windows is unsupported.

## What it does not protect

This is not a security boundary. These limits apply in mode `on`; `off` and `dry` do not scrub.

- **All hosts:** Values under 6 characters and unknown secrets are not scrubbed. Hashes, split
  values and transformations outside the supported JSON, URL and base64 forms can pass through.
  Child processes receive the values in their environment and may put them in argv, files or
  network requests; scrubbing does not prevent that access.
- **Claude Code:** A failed scrub withholds checked text. Saved Bash output over
  4 MiB (a file just under it can still exceed the helper's 4 MiB reply once JSON escapes are
  added, and then stays unchanged with the same toast), links, unexpected paths and files that
  cannot be read or written stay unchanged.
  Attachments, structured non-Bash records, tool calls and thinking can retain raw values even
  when model-facing text is scrubbed. Prompt-history protection is unverified.
- **Codex:** Only a helper-wrapped command's own stdout and stderr are scrubbed. Other tool
  results, prompts and conversation content stay raw. Failed helper loads block execution; a
  hook that cannot start leaves the command unchanged with its placeholder unfilled.
- **OpenCode:** A failed scrub replaces result content, errors and prompt text with notices,
  clears prompt attachments, and keeps the object shapes required by OpenCode 2.2.1. Messages retain only
  allowlisted roles and content-part fields; unchecked keys and nested payloads are discarded.
  Result and conversation hooks do not rewrite saved output files on disk.
- **Current values:** Each scrub reads current stored values, so new values need no reload.
  Removed or rotated values are no longer known to later scrubs, including saved-file checks.
  A wrapped command retains its initial values while filtering its own stdout and stderr.
- **Keyring access and scopes:** The helper has no `values` command in any mode. Scripts,
  dynamically built commands and direct reads through other keyring clients remain accessible.
  Placeholder checks cover only Claude Code and Codex `Bash`, and OpenCode `shell`/`bash`.
  Codex `write_stdin` and other non-Bash calls are not checked or rewritten.
  `secretScopes` checks Claude Code's session directory from `$.session.cwd()`, Codex's hook
  directory plus tool `workdir`, or OpenCode's project directory plus tool `workdir`.
  The installed Claude API exposes no separate Bash directory or guarantee that session cwd
  follows a persistent shell `cd`; scopes may differ from that shell's directory. Neither Linux
  Secret Service nor macOS Keychain makes these hooks a sandbox. Real macOS Keychain access
  and host integration remain unverified.

## Compatibility status

- Claude Code: verified on 2.1.296 in the terminal.
- Desktop, VS Code and headless: untested.
- Mode: `on` by default; available modes are `off`, `dry` and `on`.
- Egress: none. Requirements: `python3`, `bash`, and either `secret-tool` on Linux or `security` on macOS.

These facts match `mod.json`. See [installation and recovery](../../INSTALL.md) and
[contributor checks](../../CONTRIBUTING.md) for scope and validation limits.

## Install

    claude plugin marketplace add iuliandita/mods
    claude plugin install secret-box@iuliandita-mods

Needs Python 3 and `bash`. On Linux, install `secret-tool` (package `libsecret-tools` on Debian
and Ubuntu, `libsecret` on Arch and Fedora) and unlock a Secret Service keyring (GNOME Keyring,
KWallet's Secret Service, or similar). On macOS, use the built-in `/usr/bin/security` and an
unlocked default Keychain. Backend selection is automatic; the commands below are the same.

macOS stores each item under service `claude-mods-secret-box:NAME` and account `NAME` in the
default keychain. Listing reads metadata from the keychain search list and filters that service
prefix, without requesting password data or maintaining a separate index. Values use a versioned
UTF-8/base64 envelope so `security -w` returns Unicode and control characters without its ambiguous
hex conversion. Set sends the command through `security -i` on stdin, keeping values and their
encoded forms out of process arguments. Its encoded command must be shorter than 4096 bytes;
longer input is rejected before storage. Keychain may ask you to approve access. The backend is
covered by mocked command tests; a real macOS Keychain session remains unverified.

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
    secret-box exec [--scrub] -- SCRIPT    run SCRIPT, filtering stdout and stderr (--scrub is optional)
    secret-box scrub                     filter a JSON array of strings on stdin

A placeholder for a secret that is not stored makes the command exit 3 with a line naming it and
nothing runs. A placeholder inside single quotes (`'...'` or `$'...'`, also inside `$(...)` or
backticks within double quotes) would not expand, so it exits 4 and nothing runs; use double quotes.

## Slash command

    /secret-box           mode, stored secret names, helper path, how to add one
    /secret-box reload    re-read the keyring after adding or removing a secret

The status shows names only, never values. Reload refreshes that status metadata; scrubbing
always reads current values. A wrapped command filters its stdout and stderr with the values
loaded before execution, even if that command removes or rotates them.

## Codex and OpenCode

Install steps are in [INSTALL.md](../../INSTALL.md); what differs from Claude Code and why is in
[docs/COMPATIBILITY.md](../../docs/COMPATIBILITY.md). Both use the platform-selected backend.

- Codex: a `PreToolUse` hook on `Bash` replaces a placeholder command with the helper running it
  (`secret-box exec --scrub -- '...'`). The helper fills the values in and filters known values out
  of the command's own output. Codex hooks cannot rewrite results or the conversation, so nothing
  else is scrubbed: a value that reaches the chat by another route (a file the model reads, a prompt
  you typed) stays. The hook answers `allow`; the sandbox still applies to the rewritten command.
  Trust the hook once with `/hooks`.
- OpenCode 2.x: the same rewrite in `execute.before`, plus scrubbing of every tool result and error, of the
  messages the model sees again, and of the prompt as typed. If a scrub fails (locked keyring, timeout,
  reply over 4 MiB), results keep `output` and text `content` notices, errors keep their Error
  prototype with a notice message, and prompts keep notice `text` with empty `files`, `agents`
  and `skills`. Messages are rebuilt with
  only known roles and content-part fields from `@opencode/ai` 2.2.1. Tool calls use empty object
  inputs; calls and results retain only boolean `providerExecuted` values and paired replacement IDs.
  Text, reasoning and tool
  payloads are withheld; media, compaction and unknown parts become text notices. Unknown roles
  become `user`. Arbitrary keys, metadata and nested `role`/`type` values are discarded.
- The mode is read from `~/.config/iuliandita-mods/secret-box.json` (`{"mode": "on"}`; `off`, `dry`
  or `on`). An unreadable file counts as `on`. Nothing is read from a repository.
- The helper holds back the last few bytes of each stream until more output arrives or the command
  ends, so a value split across two reads is still caught; output can trail the command slightly.
- Output a background process writes after the command's shell has exited is dropped, so a
  command that starts a server returns instead of waiting for it. Signals sent to the helper are
  forwarded to the command.
- On OpenCode, when the keyring cannot be read, checked result, message and prompt strings
  are withheld; a placeholder command still fails closed.
- There is no `/secret-box` command on these hosts; run `secret-box names` in a terminal.
- A Codex hook that cannot start lets the command through with its placeholder unfilled (it holds
  no secret), so this hook does not use the fail-closed wrapper that `guard-rules` does.

## Options

Set it in the plugin's config menu or in `pluginConfigs` in your settings.

| Option | Default | Meaning |
|---|---|---|
| `mode` | `on` | `off` does nothing; `dry` only shows a toast for what it would rewrite or scrub; `on` enforces |
| `secretScopes` | empty | JSON object mapping secret names to arrays of absolute directory globs; unlisted names remain unrestricted |

For example, set `secretScopes` to `{"api.token":["/projects/api/**"]}`. On Codex and OpenCode,
the same option in the user-level JSON file also accepts an object:

```json
{"mode":"on","secretScopes":{"api.token":["/projects/api/**"]}}
```

Globs match the whole directory reported by the host: Claude Code uses `$.session.cwd()`
(the session directory), Codex uses the hook directory plus tool `workdir`, and OpenCode uses
the project directory plus tool `workdir`. The installed Claude API provides no separate Bash
directory and does not guarantee that session cwd follows a persistent shell `cd`. `*` and `?`
stay within a path segment; a `**` segment matches zero or more directories.
Use absolute paths, without `.` or `..` segments; bracket and brace patterns are unsupported.
An empty array denies that secret everywhere. In mode `on`, an out-of-scope placeholder is denied
before loading or running anything; malformed options deny all placeholder commands. Mode `dry`
reports the reason and leaves the command unchanged. These scopes check only the directory
reported above, not `cd` inside the script, symlink targets or network destinations.
They do not restrict direct keyring access or the helper when run outside the hooks.

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
  `<wrapper> exec --scrub -- '...'`, not the original. Do not allow `<wrapper> exec:*` broadly.
- The plaintext `values` command was removed. Hooks use `scrub`, which accepts a JSON array
  of strings on stdin and returns `results` (each with `text` and matched `names`), stored
  `names`, and `short` names, without exporting stored values. One helper call handles all
  distinct strings within a result or conversation update. Checked batches whose JSON output
  exceeds the host's 4 MiB process limit are withheld. The reply carries text as UTF-8, so its size
  is the text size plus JSON escapes (quotes, backslashes, newlines and control characters count
  two to six bytes each). `exec` always filters its own output; `--scrub` is accepted and does
  nothing more. The helper has no authentication
  boundary; arbitrary code and other keyring clients can still read the keyring.
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
