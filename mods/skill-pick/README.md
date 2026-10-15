# skill-pick

For each prompt, a small model (and, when a TypeSafe key is set, Jev scoring each skill) names the 1 to 5 installed skills
that fit it, as many as the ask needs, so the main model can be pointed at them. The default mode only measures, including how often the main model then
loads one of the picked skills, so the usefulness is known before it is switched on.

## Privacy

With `TYPESAFE_API_KEY` set, the prompt text and the names and descriptions of your installed skills are sent to
api.typesafe.ai (Jev) to be judged. Nothing is sent without the key. The default scope is every directory, and the first time a prompt would be sent you
get a one-time notice saying so.

- Restrict it with `jevPaths`, a comma-separated list of directory prefixes, for example
  `jevPaths: "~/personal/"`. `~` means your home directory and everything under it. Jev is used only
  when the session's working directory is equal to or under one entry; `..` segments are resolved first.
  A non-blank value with no usable entry (for example `","`) allows nowhere.
- Set `picker=haiku` to never contact Jev.
- Tighten the scope if your prompts can contain work or customer data.

## Modes

- `off`: nothing runs: no listing capture, no model or Jev call, no log record, and Skill tool calls are not recorded.
- `dry` (default): the prompt goes in as typed, then the small model picks and the result is
  logged. No added latency: the pick runs from a timer after the prompt has been let through, so a slow
  or hung picker never delays it. Its log record appears a moment after the prompt.
- `on`: the small model picks first. If it names skills, the prompt gets one context line:
  `skill-pick: skills that may fit this prompt: a, b. Load one with the Skill tool only if it applies.`
  The prompt itself is never dropped or rewritten.

The catalog is the skill listing the engine injects each session; the plugin reads it and passes it
on unchanged to the small model. A picked name counts only if it is a listing entry (`- name: description`),
or, for a listing without entries in that form, occurs in the listing text.
Before a listing has been seen (the first prompt of a session can precede it) the prompt passes and
the record says `no-listing`.

A model error, timeout or unparseable reply logs `error` and lets the prompt through. The small model call
is bounded to 8 s. In `on` mode the prompt waits for the pick, so the worst case
is a 6 s Jev request followed by the 8 s small model, about 14 s; `dry` never waits.

Skipped without a model call: prompts with attachments, prompts that start with `/` or `!`, prompts
shorter than `minChars`, prompts longer than 4000 characters, and prompts that do not come from the
composer or the remote bridge.

## Picker and the Jev cascade

With `TYPESAFE_API_KEY` set, the prompt and the skill catalog descriptions go to a third party
(api.typesafe.ai) in every mode (`dry` and `on`), unless `jevPaths` or `picker` = `haiku` limits it. This is the
default on purpose; set one of those if it is not what you want.

`picker` is `auto` (default), `haiku` or `jev`. In `auto`, when `TYPESAFE_API_KEY` is set, the path gate
passes and the listing has at least 2 `- name: description` entries, one Jev request scores every skill
(the first 200 entries, descriptions cut to 300 characters) as P(fits) from 0 to 1, bounded to 6 s.
Past 200 entries (and for skills with an all-digit name) the rest are not scored; when anything was left
out, a Jev "nothing fits" no longer skips the small model, which sees the full catalog, and its picks
outside the scored subset are kept.
The same request also carries Choice questions ("which one skill best fits the prompt?") over the
catalog, descriptions cut to 150 characters, with a "none of these" option: 3 shuffled orders, or 1
when there are more than 120 entries. The Choice probabilities are averaged per option and confirm the
scores. Otherwise the small model alone picks, as before.

- Nothing fits (the small model is not called, status `none`): the best P is below 0.5, or "none of
  these" is at least as likely as every skill in the Choice answer.
- Otherwise the small model also picks. A skill is confirmed by Jev when its P >= 0.7 and its Choice
  probability >= 0.05 (without a usable Choice answer: P >= 0.85). Final names: confirmed ones, or picked
  by the small model with Jev P >= 0.5; ordered by Jev P, at most `maxSkills`.
- Jev unavailable (error, timeout, non-2xx, unreadable or incomplete scores): the small model's list,
  path `jev-fallback`. A missing or malformed Choice answer is not an error; it only drops the Choice
  check. Small model unavailable: Jev's confirmed names.
- `jev`: Jev alone names its confirmed skills; the small model is called only if Jev is unavailable
  (and in `dry`, to compare). `haiku`: the small model alone, nothing goes to Jev.
- `dry` runs both always and records Jev's confirmed names, the small model's names, the final names
  and whether the two sets are the same, so the thresholds can be tuned from data.

Why: on a small synthetic set of 30 labeled prompts the scores kept recall, but Jev alone at P >= 0.85
was only 58% precise; the Choice question confirms the right ones. Every skill prompt's best P was
>= 0.91 and 6 of 8 no-skill prompts were below 0.5, hence the 0.5 cutoff (was 0.3). The request now
carries the catalog up to 4 times, so Jev input tokens per prompt grow.

Skills whose name is all digits are not supported for Jev: they are left out of its request.

`jevPaths` is a comma-separated list of directory prefixes (`~` allowed). Empty means Jev may be used
anywhere; otherwise Jev is used only when the working directory is equal to or under one of them
(compared on path boundaries, after `..` segments are resolved). A non-blank value with no usable
entry means nowhere. Setting it is recommended; see Privacy.

## Codex and OpenCode

Install steps are in [INSTALL.md](../../INSTALL.md); what differs and why is in
[docs/COMPATIBILITY.md](../../docs/COMPATIBILITY.md).

- Options are the same names as below in `~/.config/iuliandita-mods/skill-pick.json` (string
  values). Nothing is read from a repository.
- Codex: the catalog is read from the `SKILL.md` files in `.agents/skills` (working directory up
  to your home), `~/.agents/skills`, `$CODEX_HOME/skills`, `/etc/codex/skills` and the skills of
  installed plugins. The small model is called with your `ANTHROPIC_API_KEY` (or
  `ANTHROPIC_BASE_URL`); without a key nothing is picked.
- OpenCode: the catalog is the host's skill list and the host's own model answers.
- No use records or agreement figures on either host: neither exposes a skill-load event to a
  plugin the way Claude's `Skill` tool call does.
- Stats: `node <plugin>/bin/skill-pick.mjs summary`, `last` or `clear`.

## Options

- `mode`: `off`, `dry` or `on` (default `dry`).
- `model`: the picker model (default `haiku`).
- `minChars`: shortest prompt that is judged (default 25).
- `maxSkills`: most skills named per prompt, 1 to 5 (default 5); the model picks how many, up to this ceiling.
- `picker`: `auto`, `haiku` or `jev` (default `auto`).
- `jevPaths`: directory prefixes where Jev may be used (default empty, anywhere).

## Log and command

The plugin keeps the last 300 records. A pick record is `{ time, hash, length, picks, latency, input
tokens, output tokens, cache-read tokens, cache-write tokens, mode, catalog size, status }` with status `ok`, `none`,
`error` or `no-listing`, plus `path` (`haiku`, `jev`, `cascade` or `jev-fallback`), Jev input and output tokens,
Jev latency and, in `dry` with both answers, `agree` and the two name lists. A use record `{ time, skill, hit }` is made when the main model loads a skill
with the Skill tool; `hit` says whether it was among the last prompt's picks (a `plugin:` prefix is
ignored). The Skill call itself is never changed. The prompt text is never stored; the hash is a
non-cryptographic 53-bit value.

- `/skill-pick`: mode, model, pick counts by status, average picks per ok prompt, top 5 picked
  skills, median and p90 latency, summed tokens with cache-read tokens, and agreement (skills the
  main model loaded and how many were picked), records per path, Jev median latency, Jev and small
  model agreement in `dry`, and summed Jev tokens.
- `/skill-pick last`: the last 5 pick records.
- `/skill-pick clear`: empties the log.

## Limits

The picker cannot know what the conversation already established, so a follow-up prompt may get no
picks or odd ones. Each judged prompt is one small-model call; the catalog is sent as a cached block,
so with the cache warm the cost is the prompt plus the reply, and the log counts tokens (including
cache reads and writes).

## Egress and secrets

`anthropic` and `third-party:typesafe`. The prompt and the skill listing go to the same provider through
the session's own client. With `TYPESAFE_API_KEY` set, in `auto` and `jev` the prompt and the skill
names and descriptions also go to api.typesafe.ai, a third party, when the path gate passes, in every
mode including `dry`. Avoid
that with `picker` = `haiku`, or limit it with `jevPaths`. The key is read from the environment, sent
only as the request's bearer header, and never logged or stored. Without a key nothing goes there.

In `on` mode the picker sees the prompt as typed, before any other mod rewrites it; in `dry` mode it sees the text after the mods beneath this one have run. `secret-box` has no
prompt-submit hook (it scrubs the stored transcript, tool calls and the request to the main model), so
a secret pasted into the chat is replaced for the main model but still reaches the small model and,
with `TYPESAFE_API_KEY` set, api.typesafe.ai, in every mode including `dry`. Keep secrets out of
prompts (use the placeholders), or set `mode` to `off`.

## Install

```
claude plugin marketplace add iuliandita/mods
claude plugin install skill-pick@iuliandita-mods
```
