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
/maxx session    # how much is safe to spend THIS session (roll-session budget, plain language)
/maxx json       # print the raw stats payload (JSON)
/maxx nazi       # hourly posture check: ranked token drains + one lever (for agents)
```

## What to do

1. Locate the bundled tracker. It sits next to this SKILL.md as `tracker.mjs`.
   The canonical installed path is `~/.claude/skills/maxx/tracker.mjs`.

2. Run it:
   - Card:      `node ~/.claude/skills/maxx/tracker.mjs`
   - Session:   `node ~/.claude/skills/maxx/tracker.mjs session`   (when the user says `session`)
   - JSON:      `node ~/.claude/skills/maxx/tracker.mjs --json`
   - Nazi:      `node ~/.claude/skills/maxx/limit.mjs --nazi`   (when the user says `nazi`; add `--json` for the machine form)

   **Pacing model — read before interpreting `session`.** "How much is safe to spend
   this session" is the **roll-session** budget = weekly tokens-LEFT ÷ the 5h windows
   left this week, capped at the raw 5h wall. NOT the raw 5h cap — maxing that every
   window burns the week out days early. It banks: go light and it climbs, overspend
   and it shrinks. `maxx session` delegates to `render.mjs --session` (the only place
   with the weekly rate-limit data). Its fields: `toSpend` / `over` / `spendPerMin` =
   the actionable pace; `capKind` = `weekly-paced` or `5h-cap`; `RAW_5H_*` = the actual
   5h window, exposed separately so nobody mistakes it for the budget. Do NOT pace off
   `RAW_5H_*` — that's the raw wall, not the sustainable budget.

   Pass `--dir PATH` to point at a non-default projects directory.

   `nazi` reads the live status + burn history + your CLAUDE.md tax and prints ranked
   token drains plus the one highest-leverage lever for this hour. An agent can grep
   its `NAZI …` first line. Show the output verbatim.

3. Show the tracker's output to the user verbatim (it is already formatted).
   If they asked for `json`, run with `--json`.

That's it — the script does the parsing and formatting. Do not re-implement the
parse. If the script errors, report the error; don't guess the numbers.

## Live status (agent-readable)

The statusline renderer writes a machine-readable snapshot every render tick to
`~/.tokenmaxx/status.json`. Read that file (or `render.mjs --status`, no stdin
needed) to check pace mid-task.

**`session.cap` is the roll-session budget (weekly-paced), NOT the raw 5h wall.** Pace
off these: `session.toSpend` (safe to spend now, ≥0), `session.over` (past your
share, ≥0), `session.spendPerMin` (even rate for the time left), `session.capKind`
(`weekly-paced` | `5h-cap`), `sessionsLeftInWeek`. The ACTUAL 5h window is exposed
separately as `session.rawCap / rawUsedPct / rawHeadroom` — informational only, do
not pace off it. `burn5m` = gross tokens spent in the last 5 min.

(tracker's `--json` exposes the raw 5h window as `.session5hRaw` — same warning:
raw wall, not the sustainable budget.)

## Notes

- First run scans every session file (a few seconds on a large history).
- `cache-hit` = cache-read tokens ÷ all input-side tokens.
- `streak` = consecutive local-calendar days with activity, ending today/yesterday.
- The JSON payload is the upload format for the (future) maxx leaderboard.
