# Parser limits

[Back to guard-rules](../README.md).

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
- Wrappers: `env` (including `-S`, `-u`, `-i`, `-C`; `-P`/`--path` is unparsed), `command`, `exec`, `sudo`, `doas`, `nice`, `ionice`,
  `time`, `timeout`, `stdbuf`, `chronic`, `setsid`, `rtk`, with their value-taking options.
- Inline scripts with a literal script: `bash -c`/`sh -c` (and zsh, dash, ksh), `eval`, `secret-box exec [--scrub] --`.
- `$(...)`, backticks and process substitutions `<(...)`/`>(...)` are parsed as their own calls (nesting up to 4),
  and so are the substitutions in the body of an unquoted heredoc. A quoted heredoc runs no substitutions;
  its literal body is still checked where input is inspected.
- Arithmetic `$((...))` and `((...))` without a substitution, backtick, `[` or PATH reference inside.

A dynamic value in an argument only makes that value unknown: `git log -n "$N"`, `git diff $(git merge-base ...)`,
`git add src/{a,b}.ts` and `cd "$(git rev-parse --show-toplevel)" && git status` pass, while a write that depends on
an unknown variable is unparsed. A guarded git write after an unresolved directory change fails
the parsed lookup check, independently of `modeUnparsed`.

### When a command is unparsed

These constructs make the whole command unparsed when a parsed call or its text names `git`, `gh`, `glab`, `tea`, `fj`, `kubectl`,
`helm`, `terraform` or `tofu` anywhere (in any case, so `$GIT` counts):

- a dynamic command word after unwrapping (`$GIT push`, `"$(which git)" push`, `${G:-git} commit`);
- a dynamic word in a slot that decides the call: the git subcommand, a `-C` or `-c` value, a push remote or
  refspec, a gh/glab/tea/fj area or verb, a kubectl/helm/terraform verb, `--context`, `--kube-context` or
  `--kubeconfig`;
- a dynamic script for `eval` or `secret-box exec`; a shell reading its script from stdin (`| sh`, `<<<`, a heredoc);
  any `source`/`.` call (the guard does not read sourced files); an `env -S` string the guard cannot split;
- `case`, `select`, `coproc`, `trap`, `alias`, function definitions (`f()`, `function f`), and `declare` with
  other flags;
- assignments to `IFS`, `BASH_ENV`, `ENV` or `GIT_CONFIG_PARAMETERS`; any PATH token in command words,
  assignments or output redirections, including `{PATH}` and compact `-vPATH`; `env -P`/`--path`;
  `source`/`.`, `hash` or `enable` calls. These and alias or function definitions override exemptions for the
  whole command. Clearing PATH with `env -i` or `env -u PATH` also disables unmodeled command exemptions;
- arithmetic with a substitution, subscript or PATH reference inside;
- an unterminated quote, nesting deeper than 4, more than 16 combinations of directory and variables for one call,
  or a command too long to follow.

These are unparsed on their own, without another tool word:

- a command the guard does not model whose own words, or heredoc or here-string body, name one of those tools or
  a shell (`xargs git ...`, `flock /l git push`, `find -exec`, `su -c '...'`, `python3 -c "os.system('git push')"`,
  `perl`, `node -e`, `python3 <<'EOF'`). `echo`, `printf`, `man` (without `-P`, `--pager`, `-H` or `--html`), `which`, `type`, `grep`, `rg` (without `--pre`)
  and `cat` are text heads and exempt. Data commands `ls`, `mkdir`, `rmdir`, `touch`, `cp`, `mv`, `rm`, `head`,
  `tail`, `wc`, `tee`, `curl`, `basename`, `dirname`, `realpath`, `readlink`, `file`, `stat`, `du`, `df`, `cut`,
  `uniq`, `diff`, `cmp`, and `brew install` treat their arguments as data, but still check heredoc and here-string
  input. These exemptions require bare command names, so `./cat` and `/tmp/bin/curl` stay checked.
  Editors and pagers `vi`, `vim`, `nvim`, `nano`, `less` and `more` have no file-word exemption or flag allowlist.
  `sed` exempts literal file arguments only
  with known options: `-n`, `--quiet`, `--silent`, `-E`, `-r`, `--regexp-extended`, separate `-e SCRIPT` or
  `--expression SCRIPT`, and `--`. Script words always stay checked. An unsupported option, dynamic word or
  any `e` in any script keeps every word checked, including harmless text containing `e`; this avoids guessing
  whether a script can execute commands. Path-qualified `sed` has no file exemption.
  Unknown commands stay conservative, including runners such as `xargs`, `find -exec`, `flock`,
  `su -c`, `direnv exec`, interpreters, and programs with executable options such as `sort --compress-program`.
  Producer checks apply only to named input executors: `xargs`, `bash`, `sh`, `zsh`, `dash`, `ksh`, `awk`, `gawk`,
  `mawk`, `perl`, `python` with an optional numeric version, `ruby`, `node`, `env`, `parallel`, `watch`, `script`,
  `ssh`, `php`, `lua`, `tclsh`, `at`, `crontab`, `batch`,
  and executable or unsupported `sed` forms. Literal words and inline input are checked through pass-through
  pipeline stages. A modeled tool producer is already checked by its own rule; its command name does not count
  as output. Thus `kubectl get pods | awk '{print $1}'` and `git ls-files | xargs wc -l` pass.
  `sed` with known options and scripts containing no `e` keeps piped text as data. The guard does not inspect
  interpreter code to prove that it only prints input, so `echo git | awk '{print $0}'` is conservative too.
  For braces, `if`/`fi`, loop/`done` and subshell producers, the check conservatively includes the whole enclosing command's
  literal words rather than resolving group output. Process-substitution executors also check their enclosing
  command's inline input and pipeline producers; executor arguments retain substitution text. Substitutions
  remain bounded to four levels. These checks do not establish which descriptor reaches which process.
  A tool path in command position (`/usr/bin/git push`, `./terraform apply`) is checked by its normal rule;
- command-bearing environment values naming a tool or shell, even on text/data commands or in standalone
  assignments, `export` or declarations. The checked names are `PAGER`, `MANPAGER`, `LESS`, `LESSOPEN`,
  `LESSCLOSE`, `EDITOR`, `VISUAL`, `BROWSER`, `MANOPT`, `SHELL`, every `GIT_*` name, and names ending in
  `_PAGER`, `_EDITOR` or `_BROWSER`. Values match command names rather than directory segments or filename stems;
  executable basenames such as `/usr/bin/git` still count. A literal shell path in `SHELL` does not by itself
  name a guarded tool. `GIT_DIR=/srv/git/repo git log` and `SHELL=/bin/bash make test` pass;
- a glob or brace command word that can expand to a tool or shell (`gi[t]`, `/usr/bin/gi?`, `{git,true}`);
- a shell whose script is dynamic (`bash -c "$CMD"`, `bash <(curl ...)`);
- a guarded git write in a repository or environment the guard cannot follow (`--git-dir`, `--work-tree`,
  `--namespace`, `--config-env`, `--bare`, `GIT_DIR`/`GIT_COMMON_DIR`/`GIT_WORK_TREE`/`GIT_NAMESPACE`, an option git's parser may
  read differently such as `-C/path` or `-cname=value`, a variable the guard cannot tell).

Git and forge tools use the strictest of the attribution and protected-branch modes (and identity, once rules are
set); kubectl, helm and terraform use the context mode; a shell name uses both. `modeUnparsed=on` keeps
those inherited modes, `dry` caps denial at reporting, and `off` removes only unparsed findings. Parsed
checks, lookup failures and invalid configuration still apply. A git write after an unresolved directory
change (`cd "$X" && git push`, `env -C "$X" git push`, or `git -C "$X" push`) uses the strictest active git-side mode as a lookup finding, even with
`modeUnparsed=off`. On Claude Code, `ask` requests permission for enforced parser findings only;
parsed checks and failures still deny. Unanswered requests deny, including in the checked headless
bypass mode. Codex and OpenCode treat `ask` as `on` and warn once. See the [mode controls](../README.md#quiet-a-rule)
for the tested permission modes and approval limits.
Known false positives: a dynamic
command word next to a tool word (`$EDITOR notes.md && git status`) and an unmodeled command that names a tool as
data (`custom-reader docs/git`). Run those parts separately, or use literal command words.
Editor and pager file exemptions are removed: `vim terraform/main.tf`, `vim -R terraform/main.tf`,
`vim -o terraform/main.tf`, and tool-named paths or filenames under any of `vi`, `vim`, `nvim`, `nano`, `less`,
`more` are unparsed again, as are unlisted options such as `vim -u NONE terraform/main.tf` or `vim +1 terraform/main.tf`.
Harmless PATH setup, sourcing a script or hash lookups alongside tool words are conservative too
(`PATH=/usr/bin ls terraform`, `read PATH; cat docs/git`, `source .venv/bin/activate && git status`,
`hash tee; cat docs/git`). Data-command inline input is checked even without a runner (`tee <<< 'git notes'`).
PATH tokens are checked without a builtin allowlist: loop variables, `getopts`, `wait -p`, `read` and
descriptor allocation with `{PATH}` all disable exemptions. Harmless PATH reads next to a tool word,
arithmetic that only reads PATH (`echo $((PATH)) git`),
and clearing the environment before a data command (`env -i ls terraform`) are conservative too.
Text-only commands without a tool word still pass: `echo PATH=$PATH`, `grep -rn PATH= .` and
`printf 'PATH is %s\n' "$PATH"`.
Grouped producer checks can include unrelated tool names elsewhere in the enclosing command. Run setup
separately, use a file-reading tool, or run the command yourself.

### Other limits

- Pipeline checks read literal command words, not computed output. For example,
  `printf '%s%s push origin main' gi t | xargs env` still passes because the producer builds `git` at run time.
  This exact case remains in the regression corpus as a known gap. Output from files, transformations and
  external programs is not evaluated; arbitrary pipelines remain outside a security boundary.
- Variable values are not executed or resolved. A data path ending in a guarded executable basename, such as
  `GIT_DIR=/srv/git git log` or `PAGER='cat docs/git' man ls`, remains conservative. Startup files and variables,
  inherited PATH, aliases and functions are not read. Indirect writes through computed variable names or code
  loaded from files are not resolved.
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
- Whenever a command contains a message-bearing call, the whole command text and decoded argument words are scanned. A fixture or `grep`
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
  unclassified. A mention of `current-context` outside the recognized root line (even nested or in a comment),
  an escaped key spelling, or CR, NEL, LS or PS line breaks also makes the file unknown; CRLF is supported.
  A Terraform workspace or kube context given through a variable, substitution or secret placeholder is unclassified, and
  the directory name no longer relaxes it.
- `kubectl config use` and the krew plugin verbs `kubectl ctx|kubectx|switch|konfig NAME` (also the `kubectl-ctx`
  binary) are context switches, and any `kubectl config` verb outside `view`, `get-contexts`,
  `current-context`, `get-clusters` and `get-users` makes the context of later calls unknown. So do commands that
  switch the context or workspace without being a guarded tool (`kubectx`, `kubens` with arguments, `aws eks
  update-kubeconfig`, `gcloud ... get-credentials` or `container clusters create|create-auto`,
  `az aks|fleet|aksarc get-credentials` or `connectedk8s proxy`, `doctl ... kubeconfig save` or `cluster create`
  (including documented aliases), `oc login|project|new-project` or config writes, `kind export kubeconfig`,
  `minikube update-context`, `k3d kubeconfig merge|write`, `eksctl create cluster` or `utils write-kubeconfig`,
  `tsh kube login`, `vcluster connect|create`, `talosctl kubeconfig`, `scw k8s kubeconfig install`,
  `ibmcloud ks cluster config`, `civo kubernetes config`) and writes to a kubeconfig or
  `.terraform/environment` (a redirect, `cp`, `mv`, `tee`, `sed -i` and similar): after one, later mutating kube or
  Terraform calls in the same command are unclassified and denied, while reads (`kubectl get`, `terraform plan`) pass.
  File writers include `cp`, `mv`, `ln`, `install`, `rsync`, `tee`, `truncate`, `dd of=PATH`, `scp`, `sponge`,
  `sed`/`perl`/`yq`/`sops` with in-place flags, `gawk -i inplace`, and output options for `curl` (`-o`, `--output`),
  `wget` (`-O`, `--output-document`), `sops` (`--output`), `gpg` and `age` (`-o`, `--output`). Attached long
  values and short target/output values are checked too. Operand paths remain conservative, including sources
  for writers other than `dd`. A writer or redirect target containing a variable, substitution or secret
  placeholder makes both kube context and Terraform workspace lookups unknown; variables are not resolved.
- Not handled: `rm .terraform/environment`, kubeconfig writers outside that list (a script editing the file,
  `terragrunt`), `oc` and other tools that act on the cluster themselves,
  `git branch -m` renaming the current branch to a protected name, `git update-ref HEAD <rev>` without
  `--no-deref`, `git branch -f main HEAD`, `git fetch . feature:main`, `git reset --hard` while on a protected
  branch, `git remote add/set-url` earlier in a command,
  a command word built from fragments when the text names no tool (`a=gi; b=t; $a$b push`), a `cd` inside `bash -c` leaking out, `printf ... | git commit -F -`, `git commit -F file` message
  files, `gh api`, a script file run by a shell or `source` (`bash script.sh`, `. ./x.sh`), `fish -c`, `csh -c` or
  `tcsh -c` scripts, `git pull` creating a merge commit, git aliases (`-c alias.x=...` or from your git config),
  `git worktree add` followed by a commit in the new worktree, `git tag -u`, assignments right after a wrapper
  (`sudo FOO=1 git ...`), and push configuration set only through `GIT_CONFIG_*` variables.
- Body files not read: stdin (`-F -`), a path built from a variable, a file the guard cannot read (it is skipped),
  and a file that an earlier part of the same command writes other than by a heredoc in the command text.

- Context rule:
  - Environment name: `--context` / `--kube-context` / `HELM_KUBECONTEXT`; else a context switched
    to earlier in the command against the same kubeconfig; else the `current-context` read from
    the `--kubeconfig` file or colon-separated `KUBECONFIG` files (the first file that sets one); else the current
    kubectl context. `(custom target)` is used for `--server`, `-s`, `--cluster`,
    `--kube-apiserver`, `HELM_KUBEAPISERVER`, `HELM_KUBETOKEN`, `HELM_KUBECAFILE`, `TF_DATA_DIR`,
    `TF_CLOUD_ORGANIZATION`, `TF_CLOUD_HOSTNAME`, `TF_CLOUD_PROJECT`, `TF_CLI_ARGS` or `TF_CLI_ARGS_*`,
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
    Any assigned `TF_CLI_ARGS` or subcommand variant makes the call mutating and its target custom;
    injected flags are not evaluated, even when the variable names another subcommand or is empty.
    Ordinary reads without injected arguments keep their exemptions. Cloud target overrides affect
    mutations only. These variables are followed through exports; unexported assignments retain both
    possible environments when the inherited export state is unknown.
    A switch through a custom or reset environment stays unknown for later calls; its literal target
    cannot relax the inherited kubeconfig or Terraform directory.
  - `--dry-run` counts only as bare, `=client`, `=server` or `=true`, and the last `--dry-run` flag
    wins; `none`, `false` or anything else is a change. `--dry-run` only excuses verbs that take it.
  - Earlier `kubectl config use-context X`, `kubectl config set current-context X` and
    `terraform workspace select|new X` calls in the same command are followed as described above. Other
    `kubectl config` writes (`set-context`, `delete-context`, `rename-context`, `set`, `unset`) leave the
    current context unknown. Switch state uses the first existing file in a `KUBECONFIG` list, or the last
    file if none exists. An explicit `--kubeconfig` is always one path, including colons. Paths resolve
    against the call's directory (`./c` and `c` share state); no kubeconfig means `~/.kube/config`.
  - The guard runs its own lookups with fixed arguments (`kubectl config current-context`,
    `<tool> workspace show`) and never passes options from your command. A lookup that cannot run
    blocks the command; no current context counts as `(none)`, which is unclassified.
    Removed or empty target variables (`unset`, `export -n`, `env -u`), `env -i`, changed `HOME`, and
    `sudo`/`doas` resets count as `(custom target)`. Privilege-wrapper policy is not read, including
    whether `sudo -E` preserves variables. Reads remain allowed. Literal nonempty target assignments
    are followed; removed variables never fall back to the hook's inherited relaxed context.
  - Not seen: wrappers such as `k` or `kubecolor`, `helmfile` or `make` targets that run these
    tools, and `HELM_KUBECONTEXT`, `KUBECONFIG` or `TF_WORKSPACE` exported by an earlier Bash call
    in the session (only the current command text is read).

