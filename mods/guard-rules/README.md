# guard-rules

Stops four kinds of mistakes in Bash commands before they run, and tells the model why so it can
fix the command and retry.

- **attribution**: no `Co-Authored-By:` or `Claude-Session:` trailers, "Generated with ... Claude"
  lines, claude.ai session links, Claude Code links, or robot-emoji lines in `git commit`, `git merge`,
  `git revert`, annotated `git tag`, `gh pr`, `gh issue` and `gh release` commands, and the
  equivalent `glab` (`mr`, `issue`, `release`), `tea` (`pulls`, `issues`, `releases`) and `fj`
  (`pr`, `issue`, `release`) commands (heredoc bodies included). A body file named in a `gh` or
  `glab` call (`-F`, `--body-file`, `--notes-file`, `--description-file`) is read and scanned too.
- **protected branches** (default `develop,main`): no `git commit`, `merge`, `cherry-pick`,
  `revert`, `am` or `rebase` while on one, and no `git push` that targets one (`origin main`,
  `HEAD:main`, `--all`, the matching refspec `:`, a wildcard destination, an implicit push from
  `develop`). An implicit push also honors `push.default` (`matching` counts as `--all`,
  `upstream` checks the upstream branch) and configured `remote.<name>.push` refspecs, which are
  read for every remote and also apply to a push that names only a source. The first commit of
  an empty repository, a detached HEAD, `git merge --ff-only`, `git push --tags` and a bare
  `--abort` or `--quit` of `merge`, `cherry-pick`, `revert`, `am` or `rebase` are allowed.
- **identity** (off until configured): a repository under a configured path prefix must commit as
  that prefix's email (author and committer); a repository under no prefix is blocked. This catches commits that silently
  use the global default identity.
- **context**: no `kubectl`, `helm`, `terraform` or `tofu` command that changes something (`apply`,
  `delete`, `upgrade`, `destroy`, `rollout restart`, `state rm`, ...) on a protected or unclassified
  environment. The environment is the kubectl/helm context, or for terraform the workspace plus the
  names of the working directory and its parent. Names are matched case-insensitively against the
  protected and relaxed patterns, and a name in neither list is blocked until you classify it.
  Only known reads (`get`, `describe`, `diff`, `auth can-i`, `template`, `plan`, `init`,
  `workspace select`, ...) and real dry runs pass; any other verb or plugin counts as a change, as
  do `init -migrate-state`, `-force-copy` and `-reconfigure`, and `workspace select -or-create`.

Commands wrapped by the secret-box mod (`secret-box exec [--scrub] -- '...'`) are unwrapped and checked like `bash -c`.

Hooks only, no UI. Portability to other Claude surfaces is expected, but only terminal behavior
is verified; Desktop, VS Code and headless behavior remain untested.
Egress: none (no network, no model calls).

## Compatibility status

- Claude Code: verified on 2.1.296 in the terminal.
- Desktop, VS Code and headless: untested.
- Codex CLI 0.162.1 and OpenCode 2.0.29: a protected-branch block and the `unprotectedRepos`
  exemption were run on each; see [Codex and OpenCode](#codex-and-opencode).
- Mode: `on` by default; available modes are `off`, `dry` and `on`.
- Egress: none. Requirements: `git`.

The Claude Code lines match `mod.json`. See [installation and recovery](../../INSTALL.md) and
[contributor checks](../../CONTRIBUTING.md) for scope and validation limits.

## Install

    claude plugin marketplace add iuliandita/mods
    claude plugin install guard-rules@iuliandita-mods

## Options

Set them in the plugin's config menu or in `pluginConfigs` in your settings. They live in your
settings, never in a repository.

| Option | Default | Meaning |
|---|---|---|
| `protectedBranches` | `develop,main` | Comma-separated names; `*` is a wildcard (`release/*`). An empty list is an error; set `modeProtectedBranch` to `off` instead |
| `unprotectedRepos` | empty | Comma-separated path prefixes (`~` allowed), for example `~/notes`. A repository whose toplevel is at or under a prefix is exempt from the protected-branch rule only (commits, merges, rebases, pushes); attribution and identity still apply there. The match stops at a path boundary (`~/notes` does not cover `~/notes-old`), and a toplevel git cannot report never exempts |
| `identityRules` | empty | JSON array, for example `[{"prefix": "~/personal/", "email": "me@example.com"}]` |
| `protectedContexts` | `*prod*,*production*,*live*,*qa*,*staging*,*stage*,*uat*,*preprod*,*pre-prod*` | Environment names blocked for changing commands; `*` is a wildcard, matching is case-insensitive |
| `relaxedContexts` | `*dev*,*development*,*test*,*local*,*sandbox*,minikube,kind-*,k3d-*,docker-desktop,rancher-desktop` | Environment names where changing commands are allowed. A `*` next to a literal must meet it at `-`, `_`, `.`, `/`, `:` or `@`, so `*dev*` matches `dev` and `my-dev-x` but not `devops-eu` |
| `modeAttribution` | `on` | `off`, `dry` (toast only) or `on` |
| `modeProtectedBranch` | `on` | same |
| `modeIdentity` | `on` | same; does nothing until `identityRules` is set |
| `modeContext` | `on` | same; covers `kubectl`, `helm`, `terraform` and `tofu` |
| `modeUnparsed` | `on` | `on` keeps inherited modes, `dry` reports instead of denying unparsed commands, `off` disables only parser findings; no `ask` support |

Invalid options deny git and GitHub writes until fixed, so a typo cannot silently turn a rule off.

`unprotectedRepos` exempts by location: it trusts the toplevel git reports for the directory the command
runs in. A clone or linked worktree of another repository placed under a listed prefix is exempt too, and
a push from a listed repository to an explicit URL or path is judged by the source repository only. Git
reports physical paths while prefixes are compared as written, so a prefix that goes through a symlink
never matches and the rule keeps applying. Keep the list to repositories where direct commits are intended.

## Classifying an environment

A name that matches neither list is blocked, and the reason tells the model to ask you. You answer by
typing the slash command yourself:

    /guard-context <name> protected|relaxed
    /guard-context forget <name>
    /guard-context list

Classifications are stored per machine, not in your settings or the repository, and a stored name
wins over the patterns. The command acts only when you typed it (or sent it from a bridge client);
a run started by the model or another plugin is refused, so the model cannot classify an
environment for itself. Names are lower-cased and limited to 200 characters without whitespace or
control characters.

## Codex and OpenCode

The same rules run on Codex (a `PreToolUse` hook on `Bash`) and OpenCode 2.x (a plugin hook on its
shell tool). Install steps are in [INSTALL.md](../../INSTALL.md); what differs from Claude Code and
why is in [docs/COMPATIBILITY.md](../../docs/COMPATIBILITY.md).

- Options are the same names and values as above, in a JSON file with string values:
  `~/.config/iuliandita-mods/guard-rules.json`. The path is fixed under your account's home
  (not `$HOME` or `$XDG_CONFIG_HOME`, which a repository can set through a `.env` file). A file
  that is not a JSON object is a config error and denies git and forge writes until fixed. A
  repository's own config is never read.
- `/guard-context` becomes `node <clone>/mods/guard-rules/codex/bin/guard-rules.mjs context list |
  <name> protected|relaxed | forget <name>`, run in your own terminal. Classes are stored in
  `~/.local/share/iuliandita-mods/guard-rules/contexts.json`; a store that exists but cannot be
  read denies instead of reading as empty. The hook refuses to run that command for the model,
  as a best-effort filter, not a boundary.
- Codex lets a failing hook through unless it exits 2. The plugin's hook command turns any other
  failure (no `node`, a missing bundle, a crash) into a block, and the guard answers within 15
  seconds. Trust the hook once with `/hooks`, or Codex skips it.
- Codex does not run its hook for text typed into an already-running terminal session
  (`write_stdin`), so a shell started first and fed commands later is not checked.
- The hook also refuses shell commands that name `~/.config/iuliandita-mods` or
  `~/.local/share/iuliandita-mods`, and edit, write and patch tool calls aimed at them (Codex
  `apply_patch`, `Edit`, `Write`; every OpenCode tool other than the shell). It reads text and
  paths, so a path built at run time gets past it; nothing stops a model that can run arbitrary
  code from changing those files, as with the Claude plugin's settings. Keep the guard for accidents.
- OpenCode needs the v2 plugin API; dry-mode findings go to the host log.

## Quiet a rule

All modes default to `on`. `dry` reports a finding without blocking; `off` disables that rule.
Identity does nothing until `identityRules` is set. Change options in your user settings.

| Option or command | Values | Effect |
|---|---|---|
| `modeAttribution` | `on`, `dry`, `off` | Controls attribution checks in commit and forge messages |
| `modeProtectedBranch` | `on`, `dry`, `off` | Controls direct changes and pushes to protected branches |
| `protectedBranches` | Comma-separated names or globs | Changes which branches are protected; cannot be empty |
| `unprotectedRepos` | Comma-separated path prefixes | Exempts these locations from the branch rule only |
| `modeIdentity` | `on`, `dry`, `off` | Controls identity checks once configured |
| `identityRules` | JSON array, or empty | Sets path/email pairs; empty disables identity checks |
| `modeContext` | `on`, `dry`, `off` | Controls mutations on protected or unknown infra environments |
| `modeUnparsed` | `on`, `dry`, `off` | Caps unparsed findings without changing parsed rule checks |
| `protectedContexts`, `relaxedContexts` | Comma-separated names or globs | Changes environment matching; protected matches win |
| `/guard-context <name> protected\|relaxed` | One classification | Records a machine-local classification that overrides patterns |
| `/guard-context forget <name>` | One name | Removes its stored classification |

With `modeUnparsed=on`, unparsed commands inherit the strictest active git-side mode, or `modeContext`
for infra. `dry` reports findings that would deny; `off` suppresses parser findings. Both can let
commands run that the guard cannot inspect. Parsed rule checks still apply. A git write after an
unresolved directory change, including `git -C "$X"`, uses the active git-side modes even with `modeUnparsed=off`.
There is no approval prompt;
`ask` is rejected as an invalid option on every host.

The model cannot approve its own exception. Type the command yourself with the `!` prefix in Claude
Code, or run it in your own terminal. On Codex and OpenCode, use the context CLI described above.

## Common false positives

- A dynamic command word next to a guarded tool, such as `$EDITOR notes.md && git status`.
  Use a literal editor name or run the parts separately.
- A command runner that only searches text, such as `find . | xargs grep git`. The guard cannot
  tell whether its arguments will be executed; use a direct `rg` or `grep` call.
- A pipeline into an interpreter that only prints input, such as `echo git | awk '{print $0}'`, or a
  harmless pager setting such as `PAGER='cat docs/git' man ls`. Runner input and command-bearing environment
  values stay checked; ordinary text pipelines and `man git` pass.
- An unknown utility with a tool name as data, such as `custom-reader docs/git`, or an editor
  opening a bare file named `git`. Known file commands and literal editor filenames with an extension pass.
- A path-qualified data command such as `/usr/bin/ls terraform`, or an editor option operand
  such as `vim -u NONE terraform/main.tf` or `vim +1 terraform/main.tf`. Data exemptions require a bare command
  name; editor flags must all be on the [safe list](docs/limits.md). `vim -R terraform/main.tf` passes.
- A PATH assignment, `hash`, `alias`, `enable` or a function definition alongside tool words disables data
  exemptions for the whole command, even for harmless setup such as `PATH=/usr/bin ls terraform`.
- A `sed` command with unsupported options or an `e` anywhere in its script, even harmless text
  such as `sed -e s/name/title/ docs/git`. All its words stay checked; see the [supported options](docs/limits.md).
- A fixture or search containing attribution text in the same shell call as a message-bearing
  git or forge command. Split the calls so the message scan does not include the fixture.
- A valid command whose directory, environment, refspec, script or option cannot be resolved
  from literal text. Rewrite it with literal values, or run it yourself.

## Limits

This is an accident guard, not a security boundary. It reads Bash command text, not the contents of
scripts or other tools. See [parser limits](docs/limits.md) for the modeled grammar, state tracking,
context resolution, unsupported syntax and known gaps, including pipeline output assembled at run time.
Codex's `write_stdin` is outside hook coverage.

## Development

    claude plugin test mods/guard-rules/claude
    claude plugin validate --strict mods/guard-rules/claude
