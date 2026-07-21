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
/maxx turn       # what the LAST TURN cost: tokens + api calls (+ subagent burn), this session
/maxx fenix      # burn down, rise with context: handoff → /clear → auto-resume (alias: /fenix)
/maxx session    # session tokens: how much to burn this rolling 5h window (plain language)
/maxx json       # print the raw stats payload (JSON)
/maxx nazi       # hourly posture check: ranked token drains + one lever (for agents)
/maxx agents     # WHO is burning: per-root-session token attribution, named (for agents)
```

## What to do

1. Locate the bundled tracker. It sits next to this SKILL.md as `tracker.mjs`.
   The canonical installed path is `~/.claude/skills/maxx/tracker.mjs`.

2. Run it:
   - Card:      `node ~/.claude/skills/maxx/tracker.mjs`
   - Turn:      `node ~/.claude/skills/maxx/tracker.mjs turn`   (when the user says `turn` / "what did that cost"; `--json` for machine form. Print the two lines verbatim in your reply so the receipt lands in the transcript.)
   - Fenix:     when the user says `fenix`, follow `~/.claude/skills/fenix/SKILL.md` (write `.fenix/handoff.md`, then the human /clears — or `node ~/.claude/skills/maxx/fenix.mjs --rise` for an unattended headless continuation). fenix is a maxx subroute; /fenix is the same flow.
   - Session:   `node ~/.claude/skills/maxx/tracker.mjs session`   (when the user says `session`)
   - JSON:      `node ~/.claude/skills/maxx/tracker.mjs --json`
   - Nazi:      `node ~/.claude/skills/maxx/limit.mjs --nazi`   (when the user says `nazi`; add `--json` for the machine form)
   - Agents:    `node ~/.claude/skills/maxx/agents.mjs`   (when the user says `agents`; `--children` to expand live descendants, `--mins N` window, `--json` machine form)

   `agents` answers "what's using all the tokens" with names, not a count. Every
   session log nests: a root session at `<project>/<ROOT>.jsonl` owns everything
   under `<project>/<ROOT>/subagents/**` (subagent spawns AND workflow fan-outs).
   A 300-agent workflow is ONE root's burn. agents.mjs rolls all descendants up to
   their root, labels it with the human title (customTitle > aiTitle > agentName)
   and git branch, ranks by billed tokens over the window, and flags 🔴 anything
   with a turn in the last 5 min (live = still bleeding; idle = done, no action).
   Agent-readable: the FIRST stdout line is a single `MAXX_AGENTS window=… billed=…
   roots=… live_roots=… top=[…]` record — an agent can grep just that. `--json`
   gives the full per-root breakdown (own / subagents / workflow split, live
   children). Show the human the card verbatim.

   **Token budget — read before interpreting `session`.** "Session safe" = weekly
   tokens-LEFT ÷ the 5h windows left this week, capped at the raw 5h wall — the number
   to PLAN work against. NOT the raw 5h cap (`burst`), which you can physically reach but
   which burns the week out days early. Future windows keep giving fair shares, so an
   overspend now is recovered later — you don't claw it back this window. `net` = the
   sustainable weekly pace (weekly-left ÷ time-to-reset) minus recent burn: + under pace,
   − over. `maxx session` delegates to `render.mjs --session`
   (the only place with the weekly rate-limit data). Its fields: `toSpend` (= tokens good
   to burn) / `over` / `spendPerMin` = the actionable numbers; `capKind` = `weekly-paced`
   or `5h-cap`; `RAW_5H_*` = Anthropic's actual fixed 5h wall, exposed separately so
   nobody mistakes it for the budget. Do NOT pace off `RAW_5H_*` — that's the hard wall.

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
`~/.maxx/status.json`. Read that file (or `render.mjs --status`, no stdin
needed) to check pace mid-task.

**`session.cap` is the session token budget (weekly-paced), NOT the raw 5h wall.** Pace
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
- maxx is fully on-box: it reads local logs only and sends nothing anywhere.
