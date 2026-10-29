# notify

Shows a desktop notification when the agent finishes a turn and when it waits on you: a permission
prompt or another input request. The title is the project folder name and the body is a short fixed
reason, such as "Finished" or "Needs your permission". Message text and commands are never put in a
notification. A sound is optional and off by default. Egress is `none`: the mod starts one local
program, `notify-send` or `osascript`, and makes no network or model calls.

## Compatibility status

- Claude Code: untested. The hooks are covered by automated tests with a mocked engine only.
- Codex and OpenCode: untested. The Codex events come from the hook schemas in Codex CLI 0.165.0
  and the OpenCode events from the 2.0.29 plugin and client types; nothing was run on a real host.
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
| `finish`: the agent stopped | `Stop` hook | `Stop` hook; or the `notify` setting (`agent-turn-complete`) | `session.idle` |
| `input`: permission needed | `Notification` with type `permission_prompt` | `PermissionRequest` hook | `permission.asked` |
| `input`: waiting for input | `Notification` with type `idle_prompt` or `elicitation_dialog` | not available | `form.created` |

Nothing else is promised. Other notification types (a finished login, say) are ignored. Subagents
are left out: Claude Code's `Stop` does not fire for them and a call with an `agent_id` is skipped,
Codex's `SubagentStop` is not hooked, and OpenCode sessions created with a parent are skipped once
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

- Codex: the plugin hooks `Stop` and `PermissionRequest` and runs `bin/notify.mjs hook`, which always
  exits 0 so it cannot stop the agent. Trust the hooks once with `/hooks`, or Codex skips them.
  Codex's own `notify` setting covers completion only. To use it instead of the plugin hooks, add
  `notify = ["node", "<clone>/mods/notify/codex/bin/notify.mjs", "notify"]` to `~/.codex/config.toml`;
  Codex appends its JSON payload as the last argument. Do not use both, or a finish notifies twice.
- OpenCode 2.x: a server plugin listens to the event stream; list the package in `plugins` in
  `opencode.json`. OpenCode's terminal UI has its own attention notifications; this plugin does not
  change them.

## Limits

- It tells you something happened; it does not check that you saw it. A focused terminal still gets
  the notification.
- Remote sessions notify on the machine the agent runs on, not on your desktop.
- The title is the last folder of the session directory. Control characters are replaced with
  spaces and the name is cut at 60 characters.

## Development

    claude plugin test mods/notify/claude
    claude plugin validate --strict mods/notify/claude
    bun test mods/notify/host
