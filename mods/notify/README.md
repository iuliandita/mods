# notify

Shows a desktop notification when the agent finishes a turn and when it waits on you: a permission
prompt or another input request. The title is the repo folder name and the harness, such as
`mods (Codex)`; the body is a short fixed reason and the branch, such as "Finished on develop" or
"Needs your permission on feature/x". Only a fixed state label can come from the final message;
other message text and commands are never put in a notification.
A sound is optional and off by default. Egress is `none`: the mod starts one local
program, `notify-send` or `osascript`, and makes no network or model calls.

## Compatibility status

- Claude Code: untested. The hooks are covered by automated tests with a mocked engine only.
- Codex and OpenCode: untested. The Codex events come from the hook schemas in Codex CLI 0.166.0
  and the OpenCode events from the published 2.2.1 event schema; adapter tests do not verify
  desktop delivery in an authenticated host session.
- Desktop, VS Code and headless: untested. Delivery requires access to a desktop notification
  service on the machine running the agent.
- Linux uses `notify-send` (libnotify), macOS uses `osascript`. Other platforms get one warning.
- Mode: `on` by default; available modes are `off` and `on`.
- Egress: none. Requirements: `notify-send` on Linux, `osascript` on macOS.

## Install

```sh
claude plugin marketplace add iuliandita/mods#main
claude plugin install notify@iuliandita-mods
```

For Codex and OpenCode see [Codex and OpenCode](#codex-and-opencode) and
[INSTALL.md](../../INSTALL.md).

## Events

| Event | Claude Code | Codex | OpenCode |
| --- | --- | --- | --- |
| `finish`: the agent stopped | `Stop` hook | Synchronous `Stop` hook (one-second cap); or the `notify` setting (`agent-turn-complete`) | `session.execution.succeeded` (2.2.1); `session.idle` for older versions |
| `input`: permission needed | `Notification` with type `permission_prompt` | Background `PermissionRequest` hook | `permission.asked` |
| `input`: waiting for input | `AskUserQuestion` render hook; `Notification` with type `idle_prompt` or `elicitation_dialog` | not available | `form.created` (native question cards on 2.2.1); `question.asked` on older versions |

Other notification types (a finished login, say) are ignored. Child and headless sessions are
skipped when their host exposes a signal:

- Claude Code: `agent_id`, a `T3CODE_THREAD_ID` starting with `thread:delegated-task:`, or
  `CLAUDE_CODE_ENTRYPOINT=sdk-cli` (`claude -p`). T3 Code is a desktop app that runs these agents
  in threads and can delegate work to child threads; it sets `T3CODE_THREAD_ID` in each session,
  and other thread ids still notify. The generic Claude child-session env flags do not
  distinguish interactive parent sessions and are not used.
- Codex: the first `session_meta` record at `transcript_path` identifies `codex exec` and native
  subagents. The read stops at the first line, with a 64 KiB cap. T3 child sessions are checked
  through the optional local database lookup below.
- OpenCode: sessions created with a parent, or titled starting with `T3 Code `, are skipped.
  On first sight of an existing session, the plugin asks the host for its parent and title when
  that API is available. `OPENCODE_SESSION_ID` in the process environment suppresses nested
  runs. T3 child sessions also use the optional database lookup.

Unknown or unavailable child evidence leaves notifications enabled. Set
`IULIANDITA_MODS_NOTIFY=off` in a child process to suppress all its notifications explicitly.
Question cards notify once while open; matching finish events during that wait are suppressed.
On Claude Code, `idle_prompt` arrives after a finish, so a long wait can still notify twice;
set `events` to `finish` to avoid that.

## Options

- `mode`: `off` or `on` (default `on`). `off` sends no notices; Claude Code registers no hooks
  and Codex starts no notifier.
- `events`: comma-separated, `finish` and `input` (default both). An empty or unrecognized value
  means both.
- `t3`: `auto` (default) or `off`. Codex and OpenCode check T3's local state database when it
  exists. The lookup matches the harness session id to a delegated thread or parent lineage.
  `off` disables this lookup; Claude Code uses its environment signal instead.
- `state`: `on` (default) or `off`. For finishes, the last non-blank line of the current turn's
  final assistant message can start with `[done]`, `[needs you]`, `[waiting]`, or `[partial]`.
  The mod does not produce these markers: they appear only when the agent's own instructions
  tell it to end each turn with one.
  These map to `Done`, `Needs you`, `Running`, and `Unfinished`. Matching is case-sensitive;
  trailing text is ignored. Other lines or unavailable messages give `Finished`. `off` always
  gives `Finished`. The body stays "<label> on <branch>" when the branch is known.
- `IULIANDITA_MODS_NOTIFY=off`: environment opt-out for all three hosts, including input notices.
  It applies to the process, independently of the options file.
- `sound`: `off` (default) or `on`. On macOS the notification plays the `Glass` sound. On Linux the
  mod sets the `sound-name` hint, which only some notification servers honor.

Claude Code takes `mode`, `events`, `sound` and `state` as plugin options. Its `t3` plugin
option is accepted and has no effect, because Claude Code never reads the database.
Codex and OpenCode read the same names from
`~/.config/iuliandita-mods/notify.json`, a JSON object with string values, for example
`{"events": "finish", "sound": "on"}`. The path is fixed under your account's home, and a repository
cannot change it. A file that cannot be read gives the defaults and one warning line.

## Missing notifier

If `notify-send` or `osascript` is not installed, cannot run, exits non-zero, times out, or the
platform is not Linux or macOS, the mod shows one warning and the session carries on:
`notify: warning: notify-send not found: no notification was shown; install it or set mode to off`.
After a notifier timeout (5 s), Claude Code and OpenCode send no more notifications until the
session or the OpenCode server restarts, so a hung notification service delays one event only.
On Claude Code the warning is a toast, once per session. On OpenCode it goes to the host log, once
per distinct message. A Codex hook is a new process each time, so its warning goes to the hook's
stderr on every call. `scripts/mods doctor` lists the notifier for your platform under `requires`.
On Linux, the mod clears `LD_LIBRARY_PATH` and `LD_PRELOAD` before starting `notify-send` so hosts that set them do not load their bundled libraries into it.

## Codex and OpenCode

Install steps are in [INSTALL.md](../../INSTALL.md); what each host can do is in
[docs/COMPATIBILITY.md](../../docs/COMPATIBILITY.md).

- Codex: the plugin runs `bin/notify.mjs hook` synchronously for `Stop`, so
  interactive sessions wait for finish delivery. Detectable `codex exec` sessions are skipped.
  The hook has a one-second timeout; the notifier process still has a 250 ms timeout. `PermissionRequest` keeps `async: true`,
  so notification delivery does not delay approval prompts.
  See [Codex background hooks](https://developers.openai.com/codex/hooks#run-hooks-in-the-background).
  Delivery has a 250 ms process timeout on both Codex entry paths and still exits 0 on failure.
  After every install or update, review and trust changed hooks again with `/hooks`, or Codex
  skips them. `scripts/mods doctor` reports their trust state.
  Codex's own `notify` setting covers completion only. To use it instead of the plugin hooks, add
  `notify = ["node", "<clone>/mods/notify/codex/bin/notify.mjs", "notify"]` to `~/.codex/config.toml`;
  Codex appends its JSON payload as the last argument. Do not use both, or a finish notifies twice.
- OpenCode 2.x: a server plugin listens to the event stream; list the package in `plugins` in
  `opencode.json`. OpenCode's terminal UI has its own attention notifications; this plugin does not
  change them.
  The published `@opencode/ai` 2.2.1 package depends on `@opencode/schema` 2.2.1, whose
  [event types](https://unpkg.com/@opencode/schema@2.2.1/dist/event-manifest.d.ts) retain
  `permission.asked` (`data.sessionID`) and `form.created` (`data.form.sessionID`). Finish
  notifications are deduplicated per session until `session.execution.started` or the older
  `session.status` busy event. Receiving both completion names notifies once; the next execution
  can notify again. Failed executions are not mapped to a finish notice.
  Parent and final-message host queries have a 150 ms timeout. State labels use the host's
  session context only after the plugin observes an execution start, and only when the last
  assistant message was created in that execution. If the plugin loaded mid-turn, the host API
  is absent or slow, or no current assistant message is available, the label stays `Finished`.

## Limits

- The state word itself is disclosed to the desktop notification service, along with the
  folder, harness and branch. No other final-message text is disclosed; set `state=off` to
  keep the fixed `Finished` label. Claude Code reads `last_assistant_message`; Codex reads
  `last_assistant_message` on Stop or `last-assistant-message` in the legacy notify payload.
  Missing fields stay `Finished`; no earlier assistant message is used as a fallback.
- T3 child detection reads `~/.t3/userdata/statev2.sqlite`, or
  `$T3CODE_HOME/userdata/statev2.sqlite` when that override is set. It is local and read-only,
  has no egress, uses a 20 ms busy timeout, and closes the connection after each lookup.
  No database is created. Bun uses built-in `bun:sqlite`; Node uses built-in `node:sqlite`
  (available without a flag from Node 22.13). A runtime without that driver, an unknown schema,
  an unreadable or busy database, or an unknown session fails open. The repository does not
  require a newer Node just for this lookup; use the environment opt-out where detection is
  unavailable. `t3=off` prevents database access.
- It tells you something happened; it does not check that you saw it. A focused terminal still gets
  the notification.
- Remote sessions notify on the machine the agent runs on, not on your desktop.
- The folder in the title is the nearest parent of the session directory that has a `.git` folder
  or file, so worktrees and submodules count; the search stops at your home folder. With no repo
  it is the session directory's last folder, and `~` for the home folder itself. The branch comes
  from reading `.git/HEAD` (a detached HEAD shows the first 7 characters of the commit); if that
  cannot be read, the body has no branch. No git command is run on any host. Control characters
  are replaced with spaces and each name is cut at 60 characters. Characters git does not allow
  in a branch name are dropped, and on Linux `&`, `<` and `>` in the body are escaped so a
  branch name cannot format the notification.
- Codex cancels unfinished background permission hooks when the session ends. The finish hook
  waits up to its one-second cap; the notifier and the legacy `notify` setting's delivery each
  have a 250 ms process timeout. A slow notifier can still time out before showing anything.

## Development

```sh
claude plugin test mods/notify/claude
claude plugin validate --strict mods/notify/claude
bun test mods/notify/host
```
