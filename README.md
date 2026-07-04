# maxx

A build-companion statusline for Claude Code — and a `/maxx` usage card.

The statusline shows your **real** limits (session + weekly quota, straight from
Claude's rate-limit data — the same numbers as `/usage`), how hot you're running,
and a **coach**: a calm, Naval-esque product nudge drawn from what your session is
actually doing ("have you thought about who this is for?", "ship the smallest thing
that runs, then test it", "same command 3× — change the approach, not the input").

```
╭──────────────────────────────────────────────────────────────────╮
│ ▛▜ │ ● session ███████░░░░ 30% 1h20m │ ▸ Is this about finding    │
│ ▙▟ │   weekly  ██████░░░░░ 63% 2d    │   more people, or enriching │
│    │   temp    cool                  │   the ones you have?        │
│    │   Opus · main · sprint 22m      │                             │
│    │   $9 · ctx 18%       thanks for using /maxx                   │
╰──────────────────────────────────────────────────────────────────╯
```

## Install (plugin)

```
/plugin marketplace add goodindustries/Maxx
/plugin install maxx@maxx
```

This wires the `/maxx` skill and the coach hook. The statusline bar is a compiled
renderer — see `tokenmaxx/install.sh` to wire it into `statusLine` in your
`settings.json`.

## `/maxx`

```
/maxx            # usage card: total tokens, tokens/day, cache-hit, streak
/maxx json       # raw stats payload
/maxx optimize   # where your tokens went + ranked $ fixes
```

`/maxx` reads only token/usage metadata — never prompt or message content. The
coach (statusline) is separate: it reads recent transcript actions and, with your
consent, redacted prompt text, to give live build guidance.

## Layout

- `tokenmaxx/` — the plugin (`SKILL.md`, `tracker.mjs`, `brain.mjs`, `optimize.mjs`,
  `renderer/` Go statusline, `install.sh`).
- `.claude-plugin/marketplace.json` — the marketplace catalog.

## License

MIT — see [LICENSE](LICENSE).
