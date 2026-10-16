# delegation-board

One live pane that shows what the session's subagents and teammates are doing, so delegation is
visible and its token cost is countable. It only observes: no hook changes a spawn, a turn or a
tool call. Egress is `none`; nothing leaves the machine.

Install:

    claude plugin marketplace add iuliandita/mods
    claude plugin install delegation-board@iuliandita-mods

## What it shows

- Header: `N agents: R running, W waiting, D done, F failed` (killed counts as failed).
- One row per agent, running and waiting first, then the newest finished, as many as fit the pane
  height (the pane's body rows less the header and footer; the viewport less 4 when the pane does
  not say). Columns: state, type, model, effort (or `-`), elapsed (`12s`, `3m04s`), tokens in/out
  (`1.2k/340`), cost when configured, and the task description (cut to 60 characters). A subagent's
  children sit directly under it, indented one step; finished rows are dimmed.
- Footer: summed tokens and, when priced, the summed estimate. It covers the rows on the board, so
  it shrinks when rows are cleared or pushed out. A trailing `+` (`~$1.20+`) means some row with
  tokens matched no price, so the estimate is a floor.
- `No subagents yet.` when there is nothing to show. The last 40 rows are kept; finished and
  `unknown` rows are pushed out first.

Tokens in are input plus cache reads plus cache writes, as the turns reported them. The task prompt
is never stored, only its short description.

## Claude Desktop

Desktop does not place the pane, so there the mod draws a compact band above the prompt instead: at
most 3 one-line rows of the running subagents (type, model, state, elapsed, tokens in/out, and the
description when the line has room), cut to the band's width, and a dim `+N more` row when more are
running. It shows nothing when no subagent is live, while a survey holds the band, and in a terminal
(which keeps the pane). It redraws whenever the board changes. `/board` and `/board status` work as
before. Not yet checked by eye in Desktop.

## Command

- `/board`: close the pane if it is placed and shown, otherwise open it. If the surface does not
  place it, the command says so and prints the table as text instead.
- `/board clear`: drop finished rows.
- `/board status`: print the header and footer as text; works where no pane is placed.
- Anything else prints usage.

## Options

- `mode`: `off` or `on` (default `on`). `off` registers only the command, which says it is off.
- `open`: `spawn` (default) opens the pane at the first subagent of a session; `never` leaves it to
  `/board`.
- `prices`: optional JSON object of dollars per million tokens, `[input, output]`, keyed by a model
  id substring, for example `{"sonnet": [3, 15]}`. Cache reads and writes are billed as input. When a
  row's model matches a key (the longest key wins), the row and the footer show an estimate marked
  `~`. Unset, or if the JSON or any number is invalid, the cost column is omitted. There is no
  built-in price table, because prices change.

## How it works

Rows start at the engine's `agent.spawn` hook (agent id and resolved model from its result, type,
description, parent, background and teammate flags). The Agent tool call's `effort` is held by
`tool_use_id` until the spawn claims it; unclaimed entries expire after 10 minutes. Each
`turn.complete` that carries an agent id adds its token counts to that row. The authoritative status
(`pending`, `running`, `waiting`, `idle`, `completed`, `failed`, `killed`) comes from
`$.agent.list()`, polled once a second by one timer that runs while any row is not finished and is
cancelled when none is; the next spawn starts it again. An `idle` teammate keeps it running, because
the list is where a resumed teammate shows as `running` again; `unknown` rows do not. A poll that fails or takes over a second changes nothing. A row's end time is the first poll that sees
a finished status. A live row that three successful polls in a row do not list is given up on and
shown as `unknown`. Every hook fails open and returns the engine's value untouched.

The rows are kept in memory and mirrored to session state for the pane to draw. At session start
they are read back once, so a reload keeps the board and resumes polling, and a pane you closed is
not reopened by `open: spawn`. `/clear` (and a resume) ends the session: the rows, totals and the
first-spawn flag are dropped at `session.end`, since `session.start` does not fire for a `/clear`.

## Limits

- Elapsed is wall-clock from the spawn hook, so a queued or backgrounded agent counts from its
  start.
- The engine's own forks (compaction, memory) appear only if a `turn.complete` carries their id; they
  show state `unknown` and type `unknown`. Workflow agents and teammates the engine stops listing
  start as `pending` and turn `unknown` after about 3 seconds, keeping the tokens their turns
  reported.
- A teammate in a terminal pane of its own runs no loop here, so its tokens are not counted.
- Tokens are what the turns reported; the board does not know prices unless told.
- Terminal smoke checks on Claude Code 2.1.301 verified live and completed agent rows, token
  totals and pane commands; the other surfaces are untested. See [verification scope](../../docs/COMPATIBILITY.md#claude-terminal-verification).
- The Desktop band shows only live agents and no cost, children indent or totals; use `/board status`
  for those. Its elapsed time moves while a subagent is live (the board redraws once a second) and
  freezes when the last one finishes, when the band disappears.

## Surfaces

The pane is drawn only where the surface places it (`$.ui.open` resolves `isPlaced`). It does not
render in Claude Desktop (observed). Where it is not placed, `/board` says so, mentions the compact
rows above the prompt, and prints the table as text; `/board status` prints the summary.

## OpenCode

On OpenCode 2.x the mod is a terminal UI plugin: `/board` or **Delegation board** in the command palette (`ctrl+p`) opens a
panel listing the session's child sessions (subagents) with state, agent, time, tokens, cost and title, redrawn
every second. List the package in `plugins` in `~/.config/opencode/cli.json` (see [INSTALL.md](../../INSTALL.md)).
There is no effort or price table. The port makes no model calls, does not read the Claude
options above or `~/.config/iuliandita-mods/delegation-board.json`, and shows up to 40 recent
descendant sessions while its total includes every recorded descendant. Remove its entry from
`cli.json` and restart OpenCode to disable it. Codex has no way to draw from a plugin. Details in
[docs/COMPATIBILITY.md](../../docs/COMPATIBILITY.md).
