---
name: tokenmaxx
description: "Show your Claude Code token stats — total tokens, tokens/day, cache-hit rate, and streak — parsed from ~/.claude/projects. Use when the user types /tokenmaxx or asks about their Claude Code usage, token count, cache-hit rate, or streak."
trigger: /tokenmaxx
---

# /tokenmaxx

Parse the local Claude Code session logs (`~/.claude/projects/**/*.jsonl`) into a
shareable usage card: total tokens, tokens/day, cache-hit rate, and streak.

Reads only token/usage metadata — never prompt or message content.

## Usage

```
/tokenmaxx            # print the usage card
/tokenmaxx json       # print the raw stats payload (JSON)
```

## What to do

1. Locate the bundled tracker. It sits next to this SKILL.md as `tracker.mjs`.
   The canonical installed path is `~/.claude/skills/tokenmaxx/tracker.mjs`.

2. Run it:
   - Card:  `node ~/.claude/skills/tokenmaxx/tracker.mjs`
   - JSON:  `node ~/.claude/skills/tokenmaxx/tracker.mjs --json`

   Pass `--dir PATH` to point at a non-default projects directory.

3. Show the tracker's output to the user verbatim (it is already formatted).
   If they asked for `json`, run with `--json`.

That's it — the script does the parsing and formatting. Do not re-implement the
parse. If the script errors, report the error; don't guess the numbers.

## Notes

- First run scans every session file (a few seconds on a large history).
- `cache-hit` = cache-read tokens ÷ all input-side tokens.
- `streak` = consecutive local-calendar days with activity, ending today/yesterday.
- The JSON payload is the upload format for the (future) tokenmaxx leaderboard.
