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
untrusted or modified Codex hook is skipped, including under `codex exec`. After every plugin
update, review and trust changed hooks again with `/hooks`; guards fail open until then.
`scripts/mods doctor` reports hook trust and fails for untrusted or disabled guards.
See [host compatibility](docs/COMPATIBILITY.md) for the verified
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
roles and content-part fields. Provider-executed tool calls and results become plain text notices.
Client tool inputs become empty objects; replacement call/result pairs and an explicit
`providerExecuted: false` are preserved. Results keep notice `output` and text
`content`, errors retain their Error prototype with a notice message, and prompts keep notice
`text` with empty attachment arrays. Unchecked own fields are discarded.
On OpenCode 2.2.1, the `context`, `compaction`, `generate` and `title` hooks check outgoing
messages and system content, including user `!` shell output. Failed system checks become a text
notice. Stored history and output files are not rewritten; opaque media/provider payloads,
content added by later hooks, tool definitions, request options and transport headers are not
covered by these checks.
Each scrub reads current values; removed or rotated values are unknown to later scrubs. A
wrapped command retains its initial values while filtering its own stdout and stderr. Claude Code
may leave large or inaccessible saved outputs unchanged, Codex filters only a wrapped command's own
output, and OpenCode does not rewrite saved files. Keychain command tests use mocks; real macOS
access and host integration remain unverified. See [what secret-box does not protect](mods/secret-box/README.md#what-it-does-not-protect).

`notify` makes no network or model calls. It starts one local program (`notify-send` or
`osascript`) with the repo folder name, the harness, the branch name and a fixed reason as text, never message text or
commands, and without a shell. It reads options only from the plugin options or the user-level
`notify.json`. A failing notifier is a warning line and never denies an operation. Codex waits
for the finish hook, capped at one second with a 250 ms notifier timeout; permission
notifications stay in the background.
