# notify

Shows a desktop notification when the agent finishes a turn and when it waits on you: a permission
prompt or another input request. The title is the project folder name and the body is a short fixed
reason, such as "Finished" or "Needs your permission". Message text and commands are never put in a
notification. A sound is optional and off by default. Egress is `none`: the mod starts one local
program, `notify-send` or `osascript`, and makes no network or model calls.

## Compatibility status

- Claude Code: untested. The hooks are covered by automated tests with a mocked engine only.
- Codex and OpenCode: untested. The Codex events come from the hook schemas in Codex CLI 0.165.0
  and the OpenCode events from the published 2.2.1 event schema; adapter tests do not verify
  desktop delivery in an authenticated host session.
- Desktop, VS Code and headless: untested. A notification needs a desktop session, so a headless or
  remote session shows none.
- Linux uses `notify-send` (libnotify), macOS uses `osascript`. Other platforms get one warning.
- Mode: `on` by default; available modes are `off` and `on`.
- Egress: none. Requirements: `notify-send` on Linux, `osascript` on macOS.

## Install

    claude plugin marketplace add iuliandita/mods
    claude plugin install notify@iuliandita-mods

For Codex and OpenCode see [Codex and OpenCode](#codex-and-opencode) and
[INSTALL.md](../../INSTALL.md).

## Events

| Event | Claude Code | Codex | OpenCode |
| --- | --- | --- | --- |
| `finish`: the agent stopped | `Stop` hook | Synchronous `Stop` hook (one-second cap), including `codex exec`; or the `notify` setting (`agent-turn-complete`) | `session.execution.succeeded` (2.2.1); `session.idle` for older versions |
| `input`: permission needed | `Notification` with type `permission_prompt` | Background `PermissionRequest` hook | `permission.asked` |
| `input`: waiting for input | `Notification` with type `idle_prompt` or `elicitation_dialog` | not available | `form.created` |

Nothing else is promised. Other notification types (a finished login, say) are ignored. Subagents
are left out: Claude Code's `Stop` does not fire for them and a call with an `agent_id` is skipped,
Codex skips events carrying `agent_id` and does not hook `SubagentStop`, and OpenCode sessions created with a parent are skipped once
the plugin has seen them created (a subagent that already existed when the plugin loaded is not
recognized). `idle_prompt` arrives some time after a finish on Claude Code, so with both events on
a long wait can notify twice; set `events` to `finish` to avoid that.

## Options

- `mode`: `off` or `on` (default `on`). `off` registers no hook and starts no process.
- `events`: comma-separated, `finish` and `input` (default both). An empty or unrecognized value
  means both.
- `sound`: `off` (default) or `on`. On macOS the notification plays the `Glass` sound. On Linux the
  mod sets the `sound-name` hint, which only some notification servers honor.

Claude Code takes these as plugin options. Codex and OpenCode read the same names from
`~/.config/iuliandita-mods/notify.json`, a JSON object with string values, for example
`{"events": "finish", "sound": "on"}`. The path is fixed under your account's home, and a repository
cannot change it. A file that cannot be read gives the defaults and one warning line.

## Missing notifier

If `notify-send` or `osascript` is not installed, cannot run, exits non-zero, or the platform is not
Linux or macOS, the mod shows one warning and the session carries on:
`notify: warning: notify-send not found: no notification was shown; install it or set mode to off`.
On Claude Code the warning is a toast, once per session. On OpenCode it goes to the host log, once
per distinct message. A Codex hook is a new process each time, so its warning goes to the hook's
stderr on every call. `scripts/mods doctor` lists the notifier for your platform under `requires`.

## Codex and OpenCode

Install steps are in [INSTALL.md](../../INSTALL.md); what each host can do is in
[docs/COMPATIBILITY.md](../../docs/COMPATIBILITY.md).

- Codex: the plugin runs `bin/notify.mjs hook` synchronously for `Stop`, so one-shot
  `codex exec` waits for finish delivery before exiting. The hook has a one-second timeout;
  the notifier process still has a 250 ms timeout. `PermissionRequest` keeps `async: true`,
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

## Limits

- It tells you something happened; it does not check that you saw it. A focused terminal still gets
  the notification.
- Remote sessions notify on the machine the agent runs on, not on your desktop.
- The title is the last folder of the session directory. Control characters are replaced with
  spaces and the name is cut at 60 characters.
- Codex cancels unfinished background permission hooks when the session ends. The finish hook
  waits up to its one-second cap; the notifier and the legacy `notify` setting's delivery each
  have a 250 ms process timeout. A slow notifier can still time out before showing anything.

## Development

    claude plugin test mods/notify/claude
    claude plugin validate --strict mods/notify/claude
    bun test mods/notify/host
