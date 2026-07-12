# maxx

**You're deep in a Claude Code session. Flowing. Building. Then — *bam* — "you've hit your limit." Everything stops. You never saw it coming.**

maxx is the fuel gauge that makes sure it never happens again. A quiet little bar at the bottom of Claude Code showing exactly how much you've got left — this session *and* this week — so you're never blindsided.

![maxx statusline, session in cushion](assets/maxx-live.gif)

*…and when you're burning too fast, it goes red **before** you run out:*

![maxx statusline, both tracks over](assets/maxx-demo.gif)

## How to read it

Two bars: your **session** (refills every 5 hours) and your **week**.

- **Green** — you're good, plenty in the tank.
- **Red** — you're spending faster than the clock. Ease up, or you'll hit the wall.

The number on the right is how far **ahead** or **behind** you are, in plain tokens (`+112k cushion` / `−225k over`). Best part: when you stop to think, you *watch it recover* — the bar refills as time passes. No more guessing.

## Setup

**1. Add maxx** — in Claude Code:

```
/plugin marketplace add goodindustries/Maxx
/plugin install maxx@maxx
```

**2. Turn on the bar** — one line in your terminal (Claude Code can't switch the bottom bar on itself, so this does it):

```
git clone https://github.com/goodindustries/Maxx.git && Maxx/tokenmaxx/install.sh
```

Restart Claude Code — the bar's there. (Needs [Node](https://nodejs.org).)

## Your stuff stays yours

maxx runs entirely on your computer. **Nothing leaves the box** — not your code, not your prompts, not your chats. It only reads the same usage numbers Claude already shows you and adds them up. That's it. (There's an optional leaderboard — off unless you turn it on.)

## Want your numbers?

Type **`/maxx`** any time:

- **`/maxx`** — your usage card: total tokens, per day, your streak
- **`/maxx optimize`** — where your tokens went, and easy ways to spend less

## For agents — how the bar thinks

An agent working in this session can read exactly where it stands. The mental model:

**Tokens are use-it-or-lose-it.** Your session budget is a *rolling 5-hour window* that
refills continuously. Tokens you don't spend before they age out are **wasted, not saved** —
so "behind pace" means *under*-using, not over-using. The sustainable full-use rate is
`cap ÷ 300` per minute (the whole 5h budget spread evenly).

**The statusline (`render.mjs`).** Two meters — **session** (5h) and **week** — plus a meta line.
- Meter colour is *projection*: green = on track, amber/red = at this pace you'll empty the tank
  before it resets (the classic "don't sprint into the wall").
- The **`5m` field** is the pace signal: net tokens over the last 5 min, as `±NNNk word`, coloured
  by pace. `+` = burning (using budget), `−` = gaining (capacity aging back in while idle).
  - `+NNNk burn` **green** — burning at or above pace (fully using the budget / catching up)
  - `+NNNk burn` **amber** — spending, but *under* pace — still leaving tokens to expire
  - `−NNNk gain` **red** — idle; capacity is aging back in unused = losing ground fastest
- Each meter carries a slow **glint** that glides across the spent region (a full pass every
  ~7–24s, scaled to length). The two bars run offset phases so they never sweep in lockstep; as
  usage grows the sweep covers more of the line and the whole bar reads as alive.

**Fast query (no full scan).** To read the live session state, run:

```
node ~/.claude/skills/maxx/tracker.mjs session       # human-readable
node ~/.claude/skills/maxx/tracker.mjs session raw    # JSON, for agents
```

`session raw` returns, in ~0.3s (incremental tail, not an 8s history scan):

```json
{ "used": 11534512, "cap": 82389371, "left": 70854859, "pct": 0.14,
  "burn5": 813191, "needPerMin": 274631, "nowPerMin": 162638,
  "behind": true, "resetInMins": 41 }
```

- `left` — unused budget right now (wasted if idle).
- `needPerMin` vs `nowPerMin` — the sustainable rate vs your recent rate. `behind: true` = under-using.
- `resetInMins` — minutes until Claude's authoritative 5h reset.

All token figures are **limit-weighted** (cache-reads count ~0.1×, matching how Claude meters the
cap), so they're limit-relevant burn, not raw token counts.

**Data plumbing.** `render.mjs` (the statusline) writes the live rate-limit %s + reset times to
`~/.tokenmaxx/rl.json`. `limit.mjs` keeps `~/.tokenmaxx/window.json` (the rolling-token buckets +
anchored caps) fresh: a background pass every ~5s tails only newly-appended transcript bytes
(~0.25s), with a full reconcile every ~5 min. Everything is local; usage/token metadata only.

## License

MIT — free to use. See [LICENSE](LICENSE).
