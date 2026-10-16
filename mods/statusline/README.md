# statusline

A two-row status line drawn in the band above the prompt, in the terminal and in Claude Desktop.
It is a port of a `statusLine` script into a mod: the same segments, symbols, palettes and
width-dropping order, drawn by the engine instead of by a command. In a git repository with a
GitHub or GitLab remote it runs `gh` or `glab` for PR and issue counts (see Egress).

Terminal checks on Claude Code 2.1.301 verified live usage figures and drawing alongside the
delegation board. See [verification scope](../../docs/COMPATIBILITY.md#claude-terminal-verification)
for the checked segments and remaining limits.

Install:

    claude plugin marketplace add iuliandita/mods
    claude plugin install statusline@iuliandita-mods

## What it shows

Row 1, the repository and the session:

| Segment | Example | Source |
| --- | --- | --- |
| Model and effort, low to max | `◆ Sonnet 5.5  ▰▰▱▱▱` | `$.session.model()`; effort from each main-loop request (`turn.step`), else the transcript, else `effortLevel` in settings |
| Fast mode | `⚡` | the transcript (`usage.speed`) |
| Folder, always (also beside a worktree badge of the same name) | `repo` | `$.session.cwd()` |
| Worktree and branch badges, then `+staged ~modified ?untracked =conflicts ↑ahead ↓behind` | ` ⌥ feature `  ` ⎇ feat/x  +1 ~2 ?3` | `git status --porcelain=v2 --branch`, `git rev-parse` (a linked worktree's name) |
| The branch's PR or MR | `#12 ✓`, `!87 ●` | `gh pr list` / `glab api` |
| Open PRs (MRs) and issues, at 120 columns and up | `⑂ 7 ⊙ 23` (`≈` marks counts that could not be refreshed for 30 minutes) | `gh api graphql` / `glab api` |
| Lines added and removed in the session | `+412 -87` | the engine's own totals as its last `cost-state` entry in the transcript saved them, plus edit and write results after it; `Δ+21 -6` (uncommitted lines, `git diff --numstat HEAD`) until the session has changed any |
| Kube context and namespace | `☸ lab/apps` (a red badge for a `prod` context) | `kubectl config view --minify`, else the kubeconfig text |
| Agent of an `--agent` session | `@reviewer` | the classic hook input's `agent_type` |
| Session name (italic), output style, when room is left | `refactor auth`  `✎ Explanatory` | transcript title, else the session's title; the `outputStyle` row of `/config` (a style chosen in the session is there, not in a settings file), else settings |

Row 2, context and harness:

| Segment | Example | Source |
| --- | --- | --- |
| Context | `ctx ━━━━━━━── 66% 340k/512k >200k` | `$.session.usage().context`, measured against the auto-compact window (below) |
| 5h and 7d limits | `5h ━━●── 28% (+2) ↻3h19m ▲22m` | `$.session.usage().rateLimits` |
| Spend limit of a gateway | `spend ━━── 40%` | the same |
| Cache | `◔ 99% w 59m ⊘2`: `w` (green) while warm, with the time left; `◔ 99% c` (blue) once cold | the transcript's cache reads, writes and inputs, and the cache lifetime its last response wrote (5m or 1h) |
| Cost | `$88.25` | `$.session.usage().cost` |
| Session time / API time | `14h17m/4h50m` | `startedAt`; API time as below |

API time is the time spent waiting for API responses over the whole session, the figure the
terminal's own status line input carries as `total_api_duration_ms`. The engine API does not expose
it, but Claude Code saves its running totals in the transcript as `cost-state` entries
(`totalAPIDuration`, `totalLinesAdded`, `totalLinesRemoved`), at session start and resume. The mod
takes the latest of these and adds the main-loop requests it timed after it. A new session with no
such entry yet counts the requests this mod has timed. A resumed session whose transcript has
requests after its last entry that ran before this mod loaded (none saved, or the last run ended
without saving) has an unknown API time: the API part is left out rather than shown lower than it
is. Under a minute reads `<1m`, never `0m`. The per-turn `turn_duration` entries are wall time
including tools, so they are not used.

The pace marks read as in the script: the bar's tick is the share of the window elapsed; `(+2)`
is usage points ahead of the clock (green behind, plain on pace, yellow or red ahead); `↻` is the
time to the reset; `▲22m` is when the limit is hit at the average pace so far (shown when that
pace ends 10% or more over); `■` means the limit is reached. Bars run green, yellow, red.

What does not fit is dropped, least important first, and the rest widen into richer forms. On
row 1 the PR/issue counts, the session name and the output style are drawn only in width left over,
the counts last, so on a short row they go first. Then the order of dropping is: agent, PR badge,
kube context (kept longer when it is a `prod` context), fast mode, folder, lines changed, then the
worktree and branch; the model is never dropped.

A segment whose data fails is left out and named by its source at the end of row 1, dim:
`✗kube`, `✗git`, `✗transcript`, `✗forge`, and so on for any source or segment. So a screenshot
says why a segment is missing.

In the terminal a thin dim rule, the band's width, sits above the two rows; Claude Desktop draws
its own edge above the band, so the mod draws no rule there. The empty row under the band, just
above the prompt's border, is the engine's own notification row (it is there with this mod off),
not part of the band. Other mods' bands stack above this one.

Colours are the script's palettes (dark, light, neutral, and noctalia when its Ghostty theme
exists), as raw colours. `auto` picks as the script does; without a hint that is neutral, which
reads on dark and light backgrounds. `NO_COLOR` keeps bold and italic, and badges become `[x]`.

## Loading

The band appears once, whole: it waits for the first pass over its sources (at most 1.5 seconds
after start; measured at about 0.5 to 1.5 seconds), so row 1 does not grow segment by segment. Every
source starts on that first pass, git and its forge lookup included. From then on, a figure that is
still on its way is drawn as a dim placeholder of its usual shape at its usual place, so nothing pops
in or shifts the row. A source that failed shows its `✗name`, never a placeholder, and a segment
that does not apply (no repository, no kube context, no forge remote) is simply absent.

| Segment | Placeholder | Comes from | Until |
| --- | --- | --- | --- |
| ctx | `ctx ──── --` | the engine, after the session's first API response | that response; a resumed session has it at once |
| 5h, 7d | `5h ──── --` | the engine | the first response; still missing after it means the plan has none, and it is dropped |
| cost | `$--` | the engine | the first response |
| time | `--` | the session's start | one minute of session time |
| API time | `/--` after the time | the transcript's saved totals | the transcript is read (10-second deadline), or in a new session the first response |
| cache | `◔ --` | the transcript | the same as API time |
| PR/issue counts | `⑂ -- ⊙ --` | `gh` or `glab` | they answer, at most 10 seconds; a failure shows `✗forge` |

A resumed session's transcript is read through on the first pass, 4 MiB at a time for up to 5
seconds (a 14 MB transcript took about 1 second), so its API time and cache show on the first band.
Before, it was read 4 MiB per refresh, and a 14 MB transcript took 90 seconds, showing `/0m` and no
cache until then. The cache figure of a resumed session is shown as soon as the transcript is read,
not held back until the next response: the hit ratio covers its past requests, and `w` or `c` comes
from the time of its last response and the cache's lifetime, which is still true after a restart.
A session resumed from another folder keeps its transcript under the folder it started in; the mod
looks there too.

Rate limits can arrive at load, before any request (the engine keeps them per account), or only
with the first response; either way they are never shown before the engine reports them. No
spinner is drawn: an animation would redraw the band on a timer. `placeholders: off` restores the
earlier behaviour, each segment appearing when its data does.

## Claude Desktop

The band draws the same symbols in the terminal and in Desktop: the `icons` set applies to both,
and every other mark (the bars, the pace tick `●`, `↻`, `▲`, `■`, `◆`, `▰▱`, `✎`, `Δ`, `⊘`, `≈`)
is the same character on both. For identical symbols everywhere, set `icons: nerd` when a Nerd Font
is installed (Desktop's web view finds it through the system's font fallback), else keep the
default (`unicode`). A character can still look slightly different on the two surfaces, because the
terminal and the web view draw it with different fonts.

| Glyph | `unicode` (default) | `nerd` | `ascii` |
| --- | --- | --- | --- |
| folder | `🖿` (U+1F5BF, a flat folder; not the colour emoji) | U+F07B | none |
| branch | `⎇` | U+E0A0 | none |
| worktree | `⌥` | U+F1BB | `wt:` |
| kube | `☸` (with U+FE0E, text style) | U+F10FE | `k8s` |
| PRs, issues | `⑂` `⊙` | U+F407, U+F41B | `pr` `iss` |
| cache | `◔` | U+F1C0 | `cache` |

If Desktop shows the wrong glyphs (for example the unicode set while `icons` is `nerd`): the mod
reads its options from two places, what Claude Code hands it at load and its entry under
`pluginConfigs` in your user `settings.json` (`statusline@iuliandita-mods`), and the stored entry wins
from the first refresh on. Only the user file counts: a repository's own `.claude/settings.json`
cannot change these options. A Desktop session was seen drawing the unicode set with `icons: nerd` stored, while
the same engine handed the option over in every other way it was run, so the mod no longer depends on
the first. If it still happens, check that only one `statusline@...` entry exists under
`pluginConfigs` (with two, neither is used), and restart the Desktop session: a session keeps the mod
version it started with. Nerd glyphs in Desktop need a Nerd Font installed on the system.

What differs by surface: the rule above the rows (terminal only; Desktop draws its own edge), and
the PR/issue counts, which on Desktop are not held back to 120 columns (the band is usually
reported narrower than it looks there) and are dropped only when the row is full.

Absent by design in a new session: lines changed (none yet), time (under a minute, shown as `--`),
and the API part (none timed yet). Desktop runs Claude Code with the login shell's `PATH`, so
`gh`, `glab`, `kubectl` and `git` are found as in the terminal.

## Options

- `mode`: `on` (default) or `off`. `off` registers no hook: nothing is drawn and nothing runs.
- `rows`: `2` (default) or `1`, everything in one row.
- `forge`: `on` (default) or `off`. See Egress.
- `forgeHosts`: extra forge hosts, `host=github` or `host=gitlab`, comma-separated.
- `icons`: `auto` (default, `unicode`), `unicode`, `nerd` (Nerd Font glyphs, the script's
  default) or `ascii` (words only); the same set on both surfaces. See "Claude Desktop".
- `placeholders`: `on` (default) or `off`. See Loading.
- `theme`: `auto` (default), `dark`, `light`, `neutral` or `noctalia`.
- `refreshSeconds`: 5 to 3600 (default 30). Each finished turn refreshes too.
- `ctxWindow`: `auto` (default) or `full`. See "The context window".

Options are set in the `/config` menu or in `settings.json` under
`pluginConfigs."statusline@iuliandita-mods".options`. Like any change to an installed mod's
version, an update (`claude plugin update`) takes effect only after Claude Code is restarted: a
running session keeps the code it loaded.

## The context window

Claude Code's auto-compact window is "how full the context window can get before Claude Code
compacts the conversation": a token count from 100K to 1M, capped at the model's own window (the
model-configuration docs, "Set the auto-compact window"; the engine's `/context` breakdown measures
against the same figure, its `rawMaxTokens`). With a 1M model and a 512k window, compaction runs
near 512k, so 340k used is 66% of the room you have, not 34%.

With `ctxWindow: auto` the ctx segment is measured against that window, resolved as Claude Code
resolves it:

1. `CLAUDE_CODE_AUTO_COMPACT_WINDOW` in the environment;
2. `modelSettings["<model id>"].autoCompactWindow` (what `/autocompact` saves), matched by the exact
   model id, then the id without a bracket suffix (`claude-opus-5-5[1m]` uses `claude-opus-5-5`),
   then the longest key the id starts with (a dated id); `"auto"` there means the model's own window;
3. the top-level `autoCompactWindow`;
4. otherwise the model's full window.

The result is capped at the model's window. The percentage is coloured by the reduced figure and is
shown past 100% (`104%`, in the error colour) when usage exceeds the window. `>200k` still marks the
200k-token threshold. With `ctxWindow: full` the denominator is always the model's window.

The settings are the merged settings Claude Code reads. A `--autocompact` flag given at launch is not
visible to a mod, so a session started with it shows the saved window instead.

## Replacing the script

This mod draws in the terminal's band too, so a terminal that still has a `statusLine` setting
shows two status lines. Once this one looks right in both apps:

1. Remove the `statusLine` key from your user `settings.json`.
2. Uninstall any plugin that runs that command for Desktop, such as `statusline-anywhere`.

To match a script that used Nerd Font icons and a dark palette, set `icons` to `nerd` and `theme`
to `dark` (or keep `auto` with `STATUSLINE_THEME=dark` in the environment).

## Differences from the script

- Row 1 runs model, folder, worktree, branch, its PR, the PR/issue counts, lines changed, kube,
  agent, session name and style; the script puts the counts at the far right of row 1 and the lines
  at the end of row 2.
- The folder is always shown; the script hid it when it matched the worktree's name.
- The width is the band's own width; the script used the terminal's columns less 4.
- Vim mode is not shown: the engine exposes neither the vim setting's current mode nor the prompt's
  state.
- A spend limit shows its percentage and reset only: the engine does not report its dollar amounts.
- Cache misses count main-loop responses after the first that wrote the cache without reading any;
  the terminal's own counter is not exposed, so the number can differ from what the script showed
  there.
- API time and the cache, lines and title figures are rebuilt from the transcript (the engine's
  last cost snapshot and what follows it) and the requests this mod times; they are complete once
  the transcript has been read (4 MiB per refresh). Requests made between the last snapshot and the
  mod's load, as after a mid-session reload of the mod, are not counted.
- `✗ctxwin` marks a context window that could not be resolved (settings unreadable or no model id).
- Symbols replace the script's words: `⎇`/`⌥` before branch and worktree (no `wt:`), `⑂ n ⊙ n` for
  the PR and issue counts (no `PRs`), `◔` for the cache, with `w` or `c` for warm or cold (no `cold`),
  `🖿` before the folder and `☸` before the kube context in the `unicode` set.
- The pace tick is `●` in the terminal too (the script drew `┃` there and `●` only in Desktop).
- Failures are named on row 1 for every source, not only kube and forge on row 2.

## Egress

With `forge=on` (the default), in a git repository whose `origin` remote is on github.com,
gitlab.com or a host listed in `forgeHosts`, the mod runs your logged-in `gh` (GitHub) or `glab`
(GitLab). It sends the repository's owner and name and the current branch name to that forge, to
read the branch's open PR or MR and the open PR and issue counts. It does so at most every 5 minutes
for the counts and every 2 minutes (or on a branch change) for the PR, never while drawing. A
remote on any other host is not contacted; an ssh alias is resolved with `ssh -G`, which reads your
ssh config and does not connect. Without `gh` or `glab` installed nothing is sent.

Everything else stays on the machine: `git`, `kubectl`, `tail` on the session transcript, and
reads of settings, the kubeconfig and the Desktop app's theme file. With `forge=off` nothing leaves
the machine.

## Development

Pure formatting, parsing and math live in `claude/hooks/segments.ts`, tested in
`segments.test.ts`, including a parity test against the script's own output; the hooks and engine
calls live in `claude/hooks/register.tsx`.

    scripts/typecheck statusline
    claude plugin test mods/statusline/claude
    claude plugin validate --strict mods/statusline/claude

## OpenCode

On OpenCode 2.x the mod is a terminal UI plugin: one line above the prompt with the model, folder, branch,
context tokens, cost, elapsed time and a mark while a turn runs. List it in `plugins` in
`~/.config/opencode/cli.json` (see [INSTALL.md](../../INSTALL.md)). It has no rate-limit bars, PR or issue
counts, kube context or line counts: OpenCode does not hand those to a plugin. Codex has no way to draw from
a plugin. It makes no model or forge calls of its own and does not read the Claude options
above or `~/.config/iuliandita-mods/statusline.json`. Remove its entry from `cli.json` and restart
OpenCode to disable it. Details in [docs/COMPATIBILITY.md](../../docs/COMPATIBILITY.md).
