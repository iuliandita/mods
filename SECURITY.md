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
mode `on`, its pre-run hooks deny literal model shell calls to the internal `values` command,
including visible shell and exec wrappers. Scripts, dynamic commands and other keyring clients
remain accessible to code with the user's permissions. Optional `secretScopes` restrict named
placeholders by the call's starting directory; they do not restrict child processes, `cd` inside
scripts, symlink targets or network destinations.

Values under 6 characters and unsupported transformations are not scrubbed. A failed first load
leaves scrubbing off; a failed reload retains only the last successful values. Claude Code may
leave large or inaccessible saved outputs unchanged, Codex filters only a wrapped command's own
output, and OpenCode does not rewrite saved files. Keychain command tests use mocks; real macOS
access and host integration remain unverified. See [what secret-box does not protect](mods/secret-box/README.md#what-it-does-not-protect).
