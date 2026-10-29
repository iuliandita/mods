# Security policy

Report suspected bypasses, leaks, unsafe installation or dependency vulnerabilities through
[GitHub private security reporting](https://github.com/iuliandita/mods/security/advisories/new).
Do not post working bypasses or secrets in public issues. Include the affected mod, collection
commit, host and version, surface, installation scope or config path, a redacted reproduction
and impact.

Fixes target the current development branch; older versions may not receive backports.
This is a personal project without a guaranteed response time.

Mods run unsandboxed with the user's permissions. Egress declarations describe intended behavior,
not an operating-system security boundary. Read each mod's limits and declared egress; third-party
harness behavior and user-provided private mods are outside this collection's control.

Host coverage differs: Codex does not recheck `write_stdin`, and its secret-box adapter scrubs
only commands routed through the helper. Guard failures block when its hook runs, but an
untrusted Codex hook is skipped. See [host compatibility](docs/COMPATIBILITY.md) for the verified
cases and limits.

`secret-box` uses Linux Secret Service or macOS Keychain without network or model calls. In
all modes, the helper has no plaintext `values` command. Hooks send text to its batched
`scrub` command over stdin and receive filtered text and name metadata. Scripts, dynamic commands
and other keyring clients remain accessible to code with the user's permissions. Placeholder
checks cover Claude Code and Codex `Bash`, and OpenCode `shell`/`bash` only;
Codex `write_stdin` and other non-Bash calls are not checked or rewritten. Optional
`secretScopes` use Claude Code's session directory (`$.session.cwd()`), Codex's hook directory
plus tool `workdir`, or OpenCode's project directory plus tool `workdir`. The installed Claude
API exposes no separate Bash directory or guarantee that session cwd follows a persistent
shell `cd`. Scopes do not restrict child processes, `cd` inside scripts, symlink targets or
network destinations.

Values under 6 characters and unsupported transformations are not scrubbed. A failed scrub
withholds checked text on Claude Code and OpenCode; Claude Code refuses unchecked sent messages.
OpenCode discards arbitrary keys and nested payloads on failure, keeping only allowlisted message
roles and content-part fields; results and prompts become withholding notices.
Each scrub reads current values; removed or rotated values are unknown to later scrubs. A
wrapped command retains its initial values while filtering its own stdout and stderr. Claude Code
may leave large or inaccessible saved outputs unchanged, Codex filters only a wrapped command's own
output, and OpenCode does not rewrite saved files. Keychain command tests use mocks; real macOS
access and host integration remain unverified. See [what secret-box does not protect](mods/secret-box/README.md#what-it-does-not-protect).

`notify` makes no network or model calls. It starts one local program (`notify-send` or
`osascript`) with the project folder name and a fixed reason as text, never message text or
commands, and without a shell. It reads options only from the plugin options or the user-level
`notify.json`. Its hooks never block the agent; a failing notifier is a warning line.
