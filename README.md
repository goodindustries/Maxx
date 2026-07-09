# maxx

A build-companion statusline for Claude Code — live token-budget meters + a `/maxx` usage card.

The statusline is a **quiet rail** — your session (5h) and weekly (7d) limits as glanceable race
tracks: start (`▐`, 0) on the left, the wall (your limit) on the right (`▌`). Your spend fills from
the left, and the **pace line is where the colour turns** — sage-green while you're behind it (a
lighter band shows your cushion), rose once you're past it. `+112k cushion` / `−225k over` is the
exact gap in tokens, `5m ±` is your burn momentum, `↺ just reset` flags a fresh window. It re-sums
against the live clock every second, so when you rest you watch the budget recover.

![maxx statusline](assets/maxx-demo.gif)

## Privacy — zero egress

maxx runs **entirely on your machine. Nothing leaves the box.**

- The **statusline** reads Claude's local rate-limit data (the same numbers as `/usage`) and your
  `~/.claude/projects` token metadata. It displays only counts / percentages / timings — never
  code, prompt, or message content.
- The **coach** is **local heuristics only** — edit-loop, command-loop, and pace/model nudges. It
  reads tool *actions* from the transcript (never your prompt or assistant text) and makes **no
  network and no LLM calls**.
- `/maxx` reads token/usage **metadata** only.
- The single optional exception is the leaderboard: `maxx push` uploads content-free aggregate
  stats, and it is **off unless you opt in** with `MAXX_ALLOW_PUSH=1`. Nothing uploads automatically.

## Install (plugin)

```
/plugin marketplace add goodindustries/Maxx
/plugin install maxx@maxx
```

This wires the `/maxx` skill and the coach hook. To turn on the statusline bar, run
`tokenmaxx/install.sh` — it points `statusLine` in your `settings.json` at `node render.mjs` and
sets `refreshInterval: 1` (so the budget recovers live while idle). Pure Node, no binary to build
or download.

## `/maxx`

```
/maxx            # usage card: total tokens, tokens/day, cache-hit, streak
/maxx json       # raw stats payload
/maxx optimize   # where your tokens went + ranked $ fixes
```

## Layout

- `tokenmaxx/` — the plugin (`SKILL.md`, `render.mjs` statusline, `brain.mjs` local coach,
  `limit.mjs` rolling-window token engine, `tracker.mjs`/`optimize.mjs` for `/maxx`, `install.sh`).
- `.claude-plugin/marketplace.json` — the marketplace catalog.

## License

MIT — see [LICENSE](LICENSE).
