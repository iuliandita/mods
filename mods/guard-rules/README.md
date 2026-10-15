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

Commands wrapped by the secret-box mod (`secret-box exec -- '...'`) are unwrapped and checked like `bash -c`.

Hooks only, no UI, so it works the same in the terminal, the desktop app, VS Code and headless runs.
Egress: none (no network, no model calls).

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

## When a rule is wrong for you

The model cannot approve its own exception. Type the command yourself with the `!` prefix in Claude
Code (commands you type are not passed through the guard), run it in your own shell, or set the rule
to `dry` or `off`.

## Limits

This guards against accidents. It is not a security boundary.

### What the parser models

The guard reads the command text only (no aliases, functions or variables from your shell, and nothing a script
such as `make release` runs). It models a small, explicit grammar and treats everything else as unparsed:

- Words are literal when built from plain characters, `'...'`, `$'...'`, `"..."` without `$` or backticks, and
  backslash escapes. Anything else (`$X`, `${...}`, `$(...)`, backticks, `$((...))`, unquoted `*?[`, unquoted
  `{a,b}` or `{1..3}`) is dynamic.
- Connectors `&& || ; | |& &` and newlines; `( )`, `{ }`, `!`, `if`/`while`/`until`/`for` with their keywords,
  `[[ ]]`, `test` and `[`; comments, redirections and assignment prefixes.
- Builtins: `export` (`-n` removes the export), `unset [-v|-f|-n]`, `declare`/`typeset`/`local`/`readonly` with only
  `-x +x -r -g -l -u`, `set -a`/`+a`/`-o allexport`, `cd`, `pushd [-n] DIR`, bare `pushd` (swaps the top two),
  `popd [-n] [+N|-N]`. A plain assignment, or `declare` without `-x`, reaches later calls only when the name was
  exported earlier in the command; otherwise both the new and the old value are possible.
- Wrappers: `env` (including `-S`, `-u`, `-i`, `-C`), `command`, `exec`, `sudo`, `doas`, `nice`, `ionice`,
  `time`, `timeout`, `stdbuf`, `chronic`, `setsid`, `rtk`, with their value-taking options.
- Inline scripts with a literal script: `bash -c`/`sh -c` (and zsh, dash, ksh), `eval`, `secret-box exec --`.
- `$(...)`, backticks and process substitutions `<(...)`/`>(...)` are parsed as their own calls (nesting up to 4),
  and so are the substitutions in the body of an unquoted heredoc. A quoted heredoc is data.
- Arithmetic `$((...))` and `((...))` without a substitution, backtick or `[` inside.

A dynamic value in an argument only makes that value unknown: `git log -n "$N"`, `git diff $(git merge-base ...)`,
`git add src/{a,b}.ts` and `cd "$(git rev-parse --show-toplevel)" && git status` pass, while a write that depends on
an unknown directory or variable is unparsed.

### When a command is unparsed

These constructs make the whole command unparsed when its text names `git`, `gh`, `glab`, `tea`, `fj`, `kubectl`,
`helm`, `terraform` or `tofu` anywhere (in any case, so `$GIT` counts):

- a dynamic command word after unwrapping (`$GIT push`, `"$(which git)" push`, `${G:-git} commit`);
- a dynamic word in a slot that decides the call: the git subcommand, a `-C` or `-c` value, a push remote or
  refspec, a gh/glab/tea/fj area or verb, a kubectl/helm/terraform verb, `--context`, `--kube-context` or
  `--kubeconfig`;
- a dynamic script for `eval` or `secret-box exec`; a shell reading its script from stdin (`| sh`, `<<<`, a heredoc);
  `source`/`.` of `<(...)`, `/dev/stdin` or a dynamic path; an `env -S` string the guard cannot split;
- `case`, `select`, `coproc`, `trap`, `alias`, function definitions (`f()`, `function f`), and `declare` with
  other flags;
- assignments to `IFS`, `BASH_ENV`, `ENV` or `GIT_CONFIG_PARAMETERS`;
- arithmetic with a substitution or subscript inside;
- an unterminated quote, nesting deeper than 4, more than 16 combinations of directory and variables for one call,
  or a command too long to follow.

These are unparsed on their own, without another tool word:

- a command the guard does not model whose own words, or heredoc or here-string body, name one of those tools or
  a shell (`xargs git ...`, `flock /l git push`, `find -exec`, `su -c '...'`, `python3 -c "os.system('git push')"`,
  `perl`, `node -e`, `python3 <<'EOF'`). `echo`, `printf`, `man`, `which`, `type`, `grep`, `rg` (without `--pre`)
  and `cat` are text heads and exempt. Names are matched as whole words, so a path such as `ls src/git` counts too;
- a glob or brace command word that can expand to a tool or shell (`gi[t]`, `/usr/bin/gi?`, `{git,true}`);
- a shell whose script is dynamic (`bash -c "$CMD"`, `bash <(curl ...)`);
- a guarded git write in a repository or directory the guard cannot follow (`--git-dir`, `--work-tree`,
  `--namespace`, `--config-env`, `--bare`, `GIT_DIR`/`GIT_WORK_TREE`/`GIT_NAMESPACE`, an option git's parser may
  read differently such as `-C/path` or `-cname=value`, a `cd` to a dynamic path, a variable the guard cannot tell).

Git and forge tools use the strictest of the attribution and protected-branch modes (and identity, once rules are
set); kubectl, helm and terraform use the context mode; a shell name uses both. Known false positives: a dynamic
command word next to a tool word (`$EDITOR notes.md && git status`) and an unmodeled command that names a tool as
data (`brew install gh`). Run those parts separately, or use literal command words.

### Other limits

- State changes inside one command are followed as the set of values each could have: the directory (`cd`,
  `pushd`, `popd`, `cd -`, `env -C DIR`, `sudo -D DIR`), variables set by `export`, `declare -x` and friends or a
  statement of only assignments (`unset` removes one; a prefix on the call wins), the branch per repository, the
  kube context per kubeconfig and the terraform workspace per directory. A change counts as certain only for later
  calls joined to it by `&&` (or `then`); after `;`, `||`, a newline or any other connector, or when the change is
  negated (`!`), piped, backgrounded (`&`), in a loop, in `$(...)`, or (for the directory and variables) in a
  `( ... )` subshell, every value it could have is checked and a write is denied if any one is protected or
  unknown. A loop body is checked a second time for the back edge; a relative `cd` or `git switch -` inside a loop
  is unknown. More than 8 values for one state count as unknown. `pushd +N`/`-N` makes the directory unknown.
- A plain `cd` collapses `..` as the shell's logical `cd` does. `git -C`, `env -C`, `sudo -D`, `terraform -chdir`
  and `cd -P` let the OS resolve `..` after any symlink, so the guard probes that path as written; terraform there
  counts as `(custom target)`.
- It fails closed: if the guard itself errors, the command is blocked and the reason says so and how to switch the
  rules off. A git lookup that fails or times out (10 s) denies the command, while a non-repository or a detached
  HEAD is allowed.
- Whenever a command contains a message-bearing call, the whole command text is scanned. A fixture or `grep`
  containing a trailer in the same command as a commit can be denied; split the command.
- Branch switches are parsed getopt style (`-bmain`, `-qb main`, `--create=x`, `--orphan x`); for `git switch` the
  word after `--` is the branch, and `git checkout` switches only when nothing follows `--`. An option the guard
  does not know, or `git switch -`/`git checkout -` to a branch the command did not name, goes to a branch the
  guard cannot tell, which counts as protected for a later commit or implicit push. A switch to a name with no
  local branch may create one from a remote (DWIM), so both the old and the named branch are possible.
- `git rebase <upstream> <branch>` (and `--root <branch>`) is denied when `<branch>` is protected, and later calls
  are judged on `<branch>`.
- Push destinations: `refs/heads/` and `heads/` are stripped; any other `refs/` destination except `refs/tags/`
  counts as a wildcard. For `git push`, the first positional is always the repository, also with `--repo` (git
  itself reads `git push --repo=origin main` as a push to a remote named `main`). A long option the guard does not
  know before the first positional is read both ways; a hit in either denies.
- Repeated `-c` overrides keep their order: every `-c remote.*.push` counts, and a `-c branch.<name>.merge`
  decides the upstream before the repository config is read.
- `git init` and a commit in one command is denied when identity rules are set; run `git init` on its own first.
- Identity is read with `git var`, run with the command's `-c` identity keys, `include.path` and
  `includeIf.*.path` (in order), and only these variables: `GIT_AUTHOR_NAME/EMAIL`, `GIT_COMMITTER_NAME/EMAIL`,
  `EMAIL`, `HOME`, `XDG_CONFIG_HOME`, `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`, `GIT_CONFIG_NOSYSTEM`, and
  `GIT_CONFIG_COUNT/KEY_n/VALUE_n` rebuilt from identity keys only (a count that is not a literal number up to 32 is
  unparsed). Anything else, such as `GIT_TRACE` or `GIT_EXEC_PATH`, never reaches the probe. `env -i`, `env -u` or a
  shell `unset` of one of those variables cannot be reproduced by the guard, so the commit is denied; `--author` is
  not read.
- Locale strings (`$"git"`) are read as plain double-quoted strings, and an ANSI-C string ends at its first NUL
  (`$'main\000x'` is `main`), as in bash. `sudo -s`/`-i`/`--shell`/`--login` with a command runs the words as one
  shell script, followed like `bash -c`. `env -S` is split by GNU env rules (`\_` separates words, `\c` ends the
  string, only `${NAME}` expands); a string env would reject, or one built from a variable, is unparsed when the
  command names a tool. A command word that is not a plain name or path (`"git push" origin main`) counts as one of
  its own words.
- A checkout, switch or rebase operand built from a variable, substitution or secret placeholder goes to a branch the
  guard cannot tell: a later commit or push counts as on a protected branch, and such a rebase is denied.
  `git symbolic-ref HEAD refs/heads/X` is followed like a switch (any other ref or a non-literal one is unknown) and
  `git update-ref --no-deref HEAD` detaches. A secret placeholder in a push refspec or `git -C` value is unparsed.
- An earlier `git config` write in the same command (any form but a read) makes later identity checks deny and makes
  a push without an explicit destination count as protected; an upstream change (`branch -u`, `push -u`, checkout or
  switch with `--track` or a start point) does the same for implicit pushes when `push.default` is `upstream` or
  `tracking`. `GIT_CONFIG_PARAMETERS`, or `GIT_CONFIG_KEY_n` naming `include.path`/`includeIf.*.path` (or a
  non-literal key), makes the identity unknown and denies under an identity rule.
- The kubeconfig `current-context` is read only from a root-level key whose value is plain or quoted without a
  backslash escape; anything else (escapes, anchors, tags, block or flow values, multi-line or duplicate keys) is
  unclassified. A Terraform workspace or kube context given through a variable or substitution is unclassified, and
  the directory name no longer relaxes it.
- `kubectl config use` and the krew plugin verbs `kubectl ctx|kubectx|switch|konfig NAME` (also the `kubectl-ctx`
  binary) are context switches, and any `kubectl config` verb outside `view`, `get-contexts`,
  `current-context`, `get-clusters` and `get-users` makes the context of later calls unknown. So do commands that
  switch the context or workspace without being a guarded tool (`kubectx`, `kubens` with arguments, `aws eks
  update-kubeconfig`, `gcloud ... get-credentials`, `az aks get-credentials`, `doctl ... kubeconfig save`, `oc login`,
  `kind export kubeconfig`, `minikube update-context`, `k3d kubeconfig merge`) and writes to a kubeconfig or
  `.terraform/environment` (a redirect, `cp`, `mv`, `tee`, `sed -i` and similar): after one, later mutating kube or
  Terraform calls in the same command are unclassified and denied, while reads (`kubectl get`, `terraform plan`) pass.
- Not handled: `rm .terraform/environment`, kubeconfig writers outside that list (a script editing the file,
  `terragrunt`), `oc` and other tools that act on the cluster themselves, the guard's own lookups after
  `export -n KUBECONFIG`, `git branch -m` renaming the current branch to a protected name, `git update-ref HEAD <rev>` without
  `--no-deref`, `git branch -f main HEAD`, `git fetch . feature:main`, `git reset --hard` while on a protected
  branch, `git remote add/set-url` earlier in a command, a secret placeholder in the value of a context or workspace
  variable, a command word built from fragments when the text names no tool (`a=gi; b=t; $a$b push`), a `cd` inside `bash -c` leaking out, `printf ... | git commit -F -`, `git commit -F file` message
  files, `gh api`, a script file run by a shell or `source` (`bash script.sh`, `. ./x.sh`), `fish -c`, `csh -c` or
  `tcsh -c` scripts, `git pull` creating a merge commit, git aliases (`-c alias.x=...` or from your git config),
  `git worktree add` followed by a commit in the new worktree, `git tag -u`, assignments right after a wrapper
  (`sudo FOO=1 git ...`), and push configuration set only through `GIT_CONFIG_*` variables.
- An unquoted `-m Co-Authored-By:A` and octal `$'\012'` newlines do not match the attribution patterns (the scan
  reads the command text; `$'...'` is decoded only for parsing).
- Body files not read: stdin (`-F -`), a path built from a variable, a file the guard cannot read (it is skipped),
  and a file that an earlier part of the same command writes other than by a heredoc in the command text.

- Context rule:
  - Environment name: `--context` / `--kube-context` / `HELM_KUBECONTEXT`; else a context switched
    to earlier in the command against the same kubeconfig; else the `current-context` read from
    the `--kubeconfig` or `KUBECONFIG` files (the first file that sets one); else the current
    kubectl context. `(custom target)` is used for `--server`, `-s`, `--cluster`,
    `--kube-apiserver`, `HELM_KUBEAPISERVER`, `HELM_KUBETOKEN`, `HELM_KUBECAFILE`, `TF_DATA_DIR`,
    a context switch the guard cannot tell, a `-chdir` built from a variable, a kubeconfig the guard
    cannot read, and a context option that may be the value of an option the guard does not know
    (`kubectl apply -f --context=x`). With `(custom target)`, a context or kubeconfig file name can
    only make the call protected. Terraform and tofu use the workspace named by
    `workspace new|delete|select`, else `TF_WORKSPACE` or `workspace show`, and the directory
    names (`-chdir` honored).
  - Option values are never read as flags: a word after a value-taking option, or after a kubectl
    or helm option the guard does not know, is not a `--dry-run` or `--context`. An unknown option
    before the verb makes the call count as a change.
  - Terraform: a protected name wins, then a relaxed workspace or working-directory name is
    enough; the parent directory can only protect, never relax. Otherwise the first non-`default`
    name is asked for. The `default` workspace is never a name. Classify a directory as
    `/guard-context <dir-name> protected|relaxed`; `/guard-context (custom target) relaxed` works too.
  - `--dry-run` counts only as bare, `=client`, `=server` or `=true`, and the last `--dry-run` flag
    wins; `none`, `false` or anything else is a change. `--dry-run` only excuses verbs that take it.
  - Earlier `kubectl config use-context X`, `kubectl config set current-context X` and
    `terraform workspace select|new X` calls in the same command are followed as described above. Other
    `kubectl config` writes (`set-context`, `delete-context`, `rename-context`, `set`, `unset`) leave the
    current context unknown. The switch state is keyed by the kubeconfig paths resolved against the call's
    directory (`./c` and `c` are the same file; `./c` in two directories are not); no kubeconfig means
    `~/.kube/config`.
  - The guard runs its own lookups with fixed arguments (`kubectl config current-context`,
    `<tool> workspace show`) and never passes options from your command. A lookup that cannot run
    blocks the command; no current context counts as `(none)`, which is unclassified.
  - Not seen: wrappers such as `k` or `kubecolor`, `helmfile` or `make` targets that run these
    tools, and `HELM_KUBECONTEXT`, `KUBECONFIG` or `TF_WORKSPACE` exported by an earlier Bash call
    in the session (only the current command text is read).

## Development

    claude plugin test mods/guard-rules/claude
    claude plugin validate --strict mods/guard-rules/claude
