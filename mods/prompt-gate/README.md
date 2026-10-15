# prompt-gate

Before the main model spends a turn on a vague prompt, a small model says so and asks one short
question. The default mode only measures, so you can see how useful it is before turning it on.

## Privacy

With `TYPESAFE_API_KEY` set, the prompt text (and, with `projectTerms` on, the start of the project's `AGENTS.md` or `CLAUDE.md`) is sent to api.typesafe.ai (Jev) to be judged.
Nothing is sent without the key. The default scope is every directory, and the first time a prompt would be sent you
get a one-time notice saying so.

- Restrict it with `jevPaths`, a comma-separated list of directory prefixes, for example
  `jevPaths: "~/personal/"`. `~` means your home directory and everything under it. Jev is used only
  when the session's working directory is equal to or under one entry; `..` segments are resolved first.
  A non-blank value with no usable entry (for example `","`) allows nowhere.
- Set `classifier=haiku` to never contact Jev.
- Tighten the scope if your prompts can contain work or customer data.

## Modes

- `off`: nothing runs.
- `dry` (default): the prompt goes in at once and adds no latency; the measurement (classifier and
  log write) runs just after, on a timer, and its errors are dropped. The classifier judges the text
  after the hooks beneath this one have run. Nothing is blocked. With Jev active it runs Jev and Haiku side by side and
  logs whether they agree.
- `flag` (recommended over `on`): the classifier judges the prompt first. `clear` passes. `vague`
  still enters unchanged, with one added line for the main model: "prompt-gate: this prompt may be
  too vague to act on. If so, ask the user: <question>". The prompt is never dropped, so a wrong
  `vague` costs nothing.
- `on`: the classifier judges the prompt first. `clear` passes. `vague` drops the prompt and shows
  one short question or a one-line rewrite. Sending the same text again within 10 minutes runs it
  without another model call. A wrong `vague` costs the user a resend.

A model error, timeout or unparseable reply logs `error` and lets the prompt through. The one
exception is a Jev score that already says vague (0.75 or more, or 0.5 with `classifier` set to
`jev`) while Haiku fails: the prompt is then judged vague with a generic question. This is an
advisory gate, not a security guard.

Skipped without a model call: prompts with attachments, prompts that start with `/` or `!`, prompts
shorter than `minChars`, prompts longer than 4000 characters, and prompts that do not come from the composer or the remote bridge.

## Classifier

With `TYPESAFE_API_KEY` set, the prompt goes to a third party (api.typesafe.ai) in every enabled mode unless
`jevPaths` or `classifier` set to `haiku` limits it. This is the default on purpose.

`classifier` (default `auto`):

- `auto`: when `TYPESAFE_API_KEY` is set and the path gate passes, Jev (TypeSafe's System One model)
  returns P(vague) for the prompt, and Haiku is used only when that is not decisive. Without a key,
  or outside `jevPaths`, Haiku alone judges.
- `haiku`: Haiku alone; Jev is never contacted.
- `jev`: Jev decides (vague at P >= 0.5) and Haiku only writes the question. Without a key it
  behaves as `haiku`.

The Jev score is the mean of four questions (vague, outcome stated, one concrete action, startable
without questions) sent in one request; if an answer is missing, the vague answer alone is used.

Cascade in `auto` (`flag` and `on`): P <= 0.25 is clear and Haiku is not called; P >= 0.75 is vague
and Haiku is called only to write the question (a generic one if that fails); in between, Haiku's
verdict decides. The thresholds are constants in `gate.ts`. A Jev error, timeout (6 s), non-2xx or
unusable answer falls back to Haiku alone and logs path `jev-fallback`. Haiku's call times out at 8 s,
so in `on` and `flag` mode the worst case before the prompt goes on is about 14 s (6 s Jev, then 8 s
Haiku).

## Codex and OpenCode

Install steps are in [INSTALL.md](../../INSTALL.md); what differs and why is in
[docs/COMPATIBILITY.md](../../docs/COMPATIBILITY.md).

- Options are the same names as below in `~/.config/iuliandita-mods/prompt-gate.json` (string
  values). Nothing is read from a repository.
- Codex: each prompt is judged by a nested `codex exec` session (luna, low effort, read-only, about
  18k tokens of your plan). `jevPaths` also limits this call. `on` blocks with the question and a
  second identical prompt runs. Dry mode measures from a detached process, which also starts a
  nested session when a model call is needed. `model` accepts a `gpt-*` name; the default
  `haiku` selects `gpt-6-luna` here.
- OpenCode: a DeepSeek Flash model from the host's model list answers, using low/minimal effort
  when available (or the host's default when no eligible candidate remains); `model` accepts
  `provider/model`. `jevPaths` limits it. `on` runs as `flag`, because a hook can only stop a
  prompt by throwing and OpenCode shows no reason for that.
- `classifier=haiku` disables Jev on these hosts but still calls the host model. `jevPaths`
  restricts both Jev and the host model, unlike Claude where it restricts only Jev. `off`
  stops both. Errors fail open.
- These adapters do not report host-model usage, so their log's zero model-token counts do not
  mean no cost. OpenCode uses the selected provider's billing; its 20-second timeout stops
  waiting but cannot cancel the request or cap its output.
- Stats: `node <plugin>/bin/prompt-gate.mjs summary`, `last` or `clear`.
- With `TYPESAFE_API_KEY` set, the prompt goes to Jev as described under Privacy; on Codex the
  first dry-mode prompt shows that notice once.

## Options

- `mode`: `off`, `dry`, `flag` or `on` (default `dry`).
- `classifier`: `auto`, `haiku` or `jev` (default `auto`).
- `jevPaths`: comma-separated directory prefixes (`~` allowed). Jev is used only when the session's
  working directory is one of them or under one. Empty (default) means anywhere; a non-blank value
  with no usable entry means nowhere. See Privacy.
- `model`: the classifier model (default `haiku`).
- `minChars`: shortest prompt that is judged (default 15).
- `projectTerms`: `yes` (default) gives the classifier the first 1500 characters of the working
  directory's `AGENTS.md`, else `CLAUDE.md`, as vocabulary; `no` does not. The vocabulary is read once
  per session and goes to Jev only when both the directory it was read from and the current
  directory pass `jevPaths`.

## Log and command

The plugin keeps the last 200 records of `{ time, hash, length, verdict, latency, input tokens,
output tokens, mode, bounced, path, jev, jevIn, jevOut, jevMs, agree }`. `path` is `haiku`, `jev`,
`cascade` or `jev-fallback`; `jev` is P(vague) or null; `jevIn`, `jevOut` and `jevMs` are Jev's
tokens and latency; `agree` (dry only) is whether Jev P >= 0.5 matched Haiku's vague verdict.
Tokens and latency of the Haiku call are in `input`, `output`; `latency` covers the whole
classification. Neither the prompt text nor the API key is stored; the hash is a non-cryptographic
53-bit value, only enough to match a bounce with its resend.

- `/prompt-gate`: mode, model, classifier, counts of clear, vague and error, vague rate, median and
  p90 latency, summed tokens, records per path, Jev median latency, dry-mode Jev/Haiku agreement
  rate, summed Jev tokens.
- `/prompt-gate last`: the last 5 records.
- `/prompt-gate clear`: empties the log.

## Limits

The gate cannot know what the main model already knows from the conversation, so a short follow-up
("yes, do that") can be called vague. `minChars` and the resend override are the answer. Each judged
prompt costs one small-model call; the log counts tokens so the cost is measured, not guessed.

## Egress and secrets

On Claude Code, egress is `anthropic` and `third-party:typesafe`. The prompt (and the project vocabulary, if enabled) goes to
Anthropic through the session's own client. With `TYPESAFE_API_KEY` set, the prompt and, if
`projectTerms` is on, the project vocabulary also go to api.typesafe.ai in `auto` and `jev`, in every enabled
mode including `dry`. The key is read
once per session, sent only as the Authorization header, and never logged or stored.

To avoid the third party: unset the key, set `classifier` to `haiku`, or set `jevPaths` so Jev runs only in
projects you choose. Setting `jevPaths` is recommended.

On Codex the model call goes to OpenAI through the nested session; on OpenCode it goes to the
selected host provider. Jev egress follows the same key and classifier settings on both.

On Claude Code, in `on` and `flag` mode the classifier sees the prompt as typed, before any other mod rewrites it; in `dry` mode it sees the text after the hooks beneath this one. Claude's `secret-box` has no prompt-submit hook (it scrubs the stored transcript, tool calls and the request to the main model), so a secret pasted into the chat is replaced for the main model but still reaches Haiku and, with `TYPESAFE_API_KEY` set, api.typesafe.ai, in every enabled mode including `dry`. Keep secrets out of prompts (use the placeholders), or set `mode` to `off`. In `on` and `flag` mode the classifier calls (including the one to api.typesafe.ai) go out before blocking hooks beneath this one run, so a prompt such a hook would drop has already been sent. OpenCode has a separate secret-box prompt hook; do not rely on hook ordering to protect pasted secrets from advisers. Codex does not scrub user prompts.

## Install

```
claude plugin marketplace add iuliandita/mods
claude plugin install prompt-gate@iuliandita-mods
```
