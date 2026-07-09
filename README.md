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

## License

MIT — free to use. See [LICENSE](LICENSE).
