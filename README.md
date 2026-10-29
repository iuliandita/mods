<h1><img src="assets/wordmark.png" alt="mods" width="360"></h1>

Hooks and plugins for Claude Code, Codex, and OpenCode that you install one at a time: commit and infrastructure guards, secret handling, prompt and skill advisers, and session status panels.

Each mod is a plugin built on its host's hooks or plugin API. Mods run with your permissions and are not sandboxed: read a mod before installing it. Each mod lists what leaves your machine (`egress`) in its README and in `mods.json`.

Status: prerelease (v0.x). Installs come from `develop`, the default branch; `main` becomes the stable channel at v1.0.0.

## Install

Set up with an agent:

> Set up https://github.com/iuliandita/mods for the coding agents I use, following its INSTALL.md.

Or install by hand. Run these in a terminal; the plugins also load in Claude Desktop sessions.

    claude plugin marketplace add iuliandita/mods
    claude plugin install <mod>@iuliandita-mods

These calls install from the GitHub marketplace. From a clone, `scripts/mods install <mod>`
registers that clone as the marketplace instead (or `--source <owner/repo>`).

For Codex and OpenCode, see the mod's README and [INSTALL.md](INSTALL.md). OpenCode hook
plugins use `opencode.json`; its terminal UI plugins use the global `cli.json` instead.
Prompt advisers make model calls even in their default `dry` mode; check the host's costs
and privacy limits before installing them.

## Usage

Installed mods run as hooks or panels in the host session. List what a clone offers and what is
installed with `scripts/mods list`, and check the environment with `scripts/mods doctor`. Add
`--json` to either for one machine-readable object. Details are in [INSTALL.md](INSTALL.md).

### Catalog

- `guard-rules`: blocks AI attribution in commits and PRs, direct commits to protected branches, commits under the wrong git identity, and mutating kubectl, helm and terraform calls on protected or unclassified environments.
- `secret-box`: keeps secret values out of the chat; a secret placeholder in a Bash command is filled in at execution time from the OS keyring.
- `prompt-gate`: before the main model spends a turn on a vague prompt, a small model says so and asks one short question. With a TypeSafe API key in the environment the prompt goes to a third party (Jev); `jevPaths` restricts where.
- `skill-pick`: names the 1 to 5 installed skills that fit each prompt. With a TypeSafe API key the prompt and skill descriptions go to a third party (Jev); `jevPaths` restricts where.
- `delegation-board`: a live pane of the session's subagents and teammates: type, model, effort, state, elapsed time and tokens; in Claude Desktop, a compact band above the prompt.
- `statusline`: a two-row status line above the prompt in the terminal and Claude Desktop: model and effort, git state, context against your auto-compact window, 5h and 7d limits with pace, cache, cost and time. In a git repo with a GitHub or GitLab remote it runs `gh` or `glab` for PR and issue counts; `forge=off` turns that off.

`mods.json` has the full catalog: egress, modes, requirements, and the install command per mod.
All six mods have recorded Claude terminal checks; the compatibility page lists the tested
behavior and versions. Other Claude surfaces remain unverified.

## Compatibility

`guard-rules`, `secret-box`, `prompt-gate` and `skill-pick` run on Claude Code, Codex and OpenCode. `statusline` and `delegation-board` run on Claude Code and, as terminal UI plugins, on OpenCode.
[What works on which host, and why](docs/COMPATIBILITY.md).

## Private mods

Put your own mods in `local/mods/<name>/` (gitignored) and install them with
`scripts/mods install <name> --local`.

## License

MIT

## Part of the stack

- [agents](https://github.com/iuliandita/agents): global prompts and subagent roles for every harness you use.
- [skills](https://github.com/iuliandita/skills): task skills, installed one at a time. idstack calls them by name.
- mods: hooks for Claude Code, Codex, and OpenCode, installed one at a time.
- [idstack](https://github.com/iuliandita/idstack): infra, DevOps, and SRE playbooks layered on pstack.

Installing one does not install the others.

## Project and support

Made by [iuliandita](https://iuliandita.com). [Other projects](https://iuliandita.com/projects/).

See [installation and recovery](INSTALL.md), [contributing](CONTRIBUTING.md),
[documentation](docs/README.md), and [private security reporting](SECURITY.md).
