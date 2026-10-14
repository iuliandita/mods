# mods

Claude Code mods you can install one at a time.

Mods are plugins built on the hooks-module API. They run with your permissions and are not
sandboxed: read a mod before installing it. Each mod lists what leaves your machine (`egress`)
in its README and in `mods.json`.

## Install

    claude plugin marketplace add iuliandita/mods
    claude plugin install <mod>@iuliandita-mods

Run it in a terminal. It works for Claude Code and loads in Claude Desktop sessions too.

These calls install from the GitHub marketplace. From a clone, `scripts/mods install <mod>`
registers that clone as the marketplace instead (or `--source <owner/repo>`).

## Catalog

- `guard-rules`: blocks AI attribution in commits and PRs, direct commits to protected branches, commits under the wrong git identity, and mutating kubectl, helm and terraform calls on protected or unclassified environments.
- `secret-box`: keeps secret values out of the chat; a secret placeholder in a Bash command is filled in at execution time from the OS keyring.
- `prompt-gate`: before the main model spends a turn on a vague prompt, a small model says so and asks one short question. With a TypeSafe API key in the environment the prompt goes to a third party (Jev); `jevPaths` restricts where.
- `skill-pick`: names the 1 to 5 installed skills that fit each prompt. With a TypeSafe API key the prompt and skill descriptions go to a third party (Jev); `jevPaths` restricts where.
- `delegation-board`: a live pane of the session's subagents and teammates: type, model, effort, state, elapsed time and tokens; in Claude Desktop, a compact band above the prompt.
- `statusline`: a two-row status line above the prompt in the terminal and Claude Desktop: model and effort, git state, context against your auto-compact window, 5h and 7d limits with pace, cache, cost and time. In a git repo with a GitHub or GitLab remote it runs `gh` or `glab` for PR and issue counts; `forge=off` turns that off.

`mods.json` has the full catalog: egress, modes, requirements, and the install command per mod.

## Private mods

Put your own mods in `local/mods/<name>/` (gitignored) and install them with
`scripts/mods install <name> --local`.

## License

MIT

## Project and support

Made by [iuliandita](https://iuliandita.com). [Other projects](https://iuliandita.com/projects/).

See [installation and recovery](INSTALL.md), [contributing](CONTRIBUTING.md),
[documentation](docs/README.md), and [private security reporting](SECURITY.md).

[agents](https://github.com/iuliandita/agents) provides global prompts and role definitions; [skills](https://github.com/iuliandita/skills) provides individually installed task guidance. Installing one collection does not install the others.
