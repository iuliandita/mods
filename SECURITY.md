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
untrusted Codex hook is skipped. Prompt and skill advisers fail open and make model calls even
in `dry` mode. See [host compatibility](docs/COMPATIBILITY.md) for the verified cases and limits.
