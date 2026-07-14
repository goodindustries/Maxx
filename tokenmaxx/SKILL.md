---
name: maxx
description: "Show your Claude Code token stats — total tokens, tokens/day, cache-hit rate, and streak — parsed from ~/.claude/projects. Use when the user types /maxx or asks about their Claude Code usage, token count, cache-hit rate, or streak."
trigger: /maxx
---

# /maxx

Parse the local Claude Code session logs (`~/.claude/projects/**/*.jsonl`) into a
shareable usage card: total tokens, tokens/day, cache-hit rate, and streak.

Reads only token/usage metadata — never prompt or message content.

## Usage

```
/maxx            # print the usage card
/maxx json       # print the raw stats payload (JSON)
/maxx optimize   # analyze your latest session: where tokens went + ranked $ fixes
```

## What to do

1. Locate the bundled tracker. It sits next to this SKILL.md as `tracker.mjs`.
   The canonical installed path is `~/.claude/skills/maxx/tracker.mjs`.

2. Run it:
   - Card:      `node ~/.claude/skills/maxx/tracker.mjs`
   - JSON:      `node ~/.claude/skills/maxx/tracker.mjs --json`
   - Optimize:  `node ~/.claude/skills/maxx/optimize.mjs`   (when the user says `optimize`)

   Pass `--dir PATH` to point at a non-default projects directory.

   `optimize` analyzes the most recent session transcript and prints where the
   tokens went plus fixes ranked by dollars saved. Show its output verbatim. It
   reads usage/timing/model metadata only — never prompt or message content.

3. Show the tracker's output to the user verbatim (it is already formatted).
   If they asked for `json`, run with `--json`.

That's it — the script does the parsing and formatting. Do not re-implement the
parse. If the script errors, report the error; don't guess the numbers.

## Live status (agent-readable)

The statusline renderer writes a machine-readable snapshot every render tick to
`~/.tokenmaxx/status.json` — the same numbers the bars paint, as plain fields:
per-window `usedPct / used / cap / headroom / resetIn / secLeft / needPerMin`
(tokens/min to fully use the session by reset) and `burn5m` (gross tokens spent in
the last 5 min). Read that file to check pace mid-task, or run
`node ~/.claude/skills/maxx/render.mjs --status` (prints the JSON; no stdin needed).

## Notes

- First run scans every session file (a few seconds on a large history).
- `cache-hit` = cache-read tokens ÷ all input-side tokens.
- `streak` = consecutive local-calendar days with activity, ending today/yesterday.
- The JSON payload is the upload format for the (future) maxx leaderboard.
