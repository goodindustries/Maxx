# maxx

**You're deep in an agent session. Flowing. Building. Then — *bam* — "you've hit your limit." Everything stops. You never saw it coming.**

maxx is the fuel gauge that keeps Codex and Claude Code users from getting blindsided. It shows the limits the agent actually reports, when they reset, how much local context you are carrying, and where your tokens went.

On Claude Code, maxx has its original animated two-rail status line:

![maxx statusline, session in cushion](assets/maxx-live.gif)

*…and when you're burning too fast, it goes red before you run out:*

![maxx statusline, both tracks over](assets/maxx-demo.gif)

Codex uses its native footer for the always-on gauge and adds a richer `$maxx:usage` card. Codex does not currently expose Claude's arbitrary executable status-line renderer, so maxx does not fake it.

## Codex setup

Install the marketplace and plugin:

```bash
codex plugin marketplace add goodindustries/Maxx
codex plugin add maxx@maxx
```

Start a new Codex task, then ask maxx to configure the native footer:

```text
$maxx:usage Set up my Codex status line.
```

The setup is idempotent, preserves unrelated Codex config, and keeps the original at `~/.codex/config.toml.bak-maxx`.

Use maxx any time:

```text
$maxx:usage Show my fuel gauge.
$maxx:usage Show my raw JSON.
$maxx:usage Optimize this session.
```

The card combines current account limits from your local Codex process with metadata-only local history. Synthetic example:

```text
  ⚡ maxx · codex
  ───────────────────────────────────────────────────────────
  primary    ██░░░░░░░░░░░░░░░░  12% used · 5h · resets in 2h 14m
  ───────────────────────────────────────────────────────────
  lifetime tokens   48.2M  (local rollouts)
  streak            4d   (longest 11d)
  local cache-hit   81.4%
  local sessions    27   ·   turns 312
  ───────────────────────────────────────────────────────────
  current context   ███░░░░░░░░░░░░░░░  16% · 41.2K / 258.4K
```

Rate-limit windows are dynamic. maxx shows the durations Codex returns instead of assuming every account has the same five-hour or weekly limits. If live account usage is unavailable, the card falls back cleanly to local rollout metadata and points you to Codex's `/usage` command.

## Claude Code setup

In Claude Code:

```text
/plugin marketplace add goodindustries/Maxx
/plugin install maxx@maxx
```

Then turn on the custom bar from your terminal:

```bash
git clone https://github.com/goodindustries/Maxx.git && Maxx/tokenmaxx/install.sh
```

Restart Claude Code. The bar needs Node on your `PATH`.

Type `/maxx` any time:

- `/maxx` — total tokens, tokens/day, cache-hit rate, and streak
- `/maxx optimize` — where your tokens went and ways to use them better

## How to read it

The persistent gauges show the usage windows reported by your agent.

- **Green** — you have runway.
- **Red** — your current pace is heading toward the wall before reset.
- **Reset** — when that window becomes available again.
- **Context** — how full the current model context is; this is separate from the account rate limit.

Claude's custom rails also show signed token cushion/overage and visibly recover as usage ages out. Codex's native footer shows authoritative limit and context fields; `$maxx:usage` supplies the richer history and context report on demand.

## Your stuff stays yours

maxx has no analytics service and sends no data to maxx or another third party.

- Claude Code parsing stays entirely on your computer unless you explicitly opt into the legacy leaderboard path.
- Codex live limits are requested from your already-authenticated local `codex app-server`; the fallback reads local rollout metadata.
- The Codex parser consumes session IDs, timestamps, model names, turn IDs, token counts, context-window sizes, rate-limit fields, and session working-directory metadata.
- It does not retain or emit prompts, assistant messages, reasoning, tool inputs, commands, or tool outputs. Working-directory metadata is used to select the invoking repo, and the optimizer labels the card with that project folder name.

Codex keeps a short-lived derived stats cache under the plugin data directory when available, otherwise `$CODEX_HOME/maxx`, so repeat cards are fast. Source rollouts remain read-only.

## Codex implementation notes

The Codex plugin lives in `plugins/maxx` and is published through `.agents/plugins/marketplace.json`.

- `usage.mjs` performs the local app-server handshake for current account usage, with a timeout and metadata-only fallback.
- `tracker.mjs` parses `$CODEX_HOME/sessions/**/*.jsonl`. It knows that cached input is already included in Codex input totals and reasoning output is already included in output totals, so neither is double-counted.
- `optimize.mjs` reports context runway and cache reuse without inventing per-token dollar costs for subscription usage.
- `setup.mjs` configures Codex's native `tui.status_line` fields and preserves the rest of `config.toml`.

The rollout format is not a documented stable API, so the parser is isolated, fixture-tested, and fails closed on unknown or malformed records. Current account limits come from Codex itself whenever that adapter is available.

## Claude Code implementation notes

Claude tokens are use-it-or-lose-it. The session budget is a rolling five-hour window that refills continuously. Tokens that age out are wasted rather than saved, so its sustainable full-use rate is `cap ÷ 300` per minute.

Fast live query:

```bash
node ~/.claude/skills/maxx/tracker.mjs session
node ~/.claude/skills/maxx/tracker.mjs session raw
```

The second form returns machine-readable session usage, burn, pace, and reset timing. Token figures are limit-weighted so cache reads contribute less pressure than fresh input.

Claude data flow:

- `render.mjs` receives live rate-limit percentages and reset times, then writes `~/.tokenmaxx/rl.json`.
- `limit.mjs` maintains rolling token buckets in `~/.tokenmaxx/window.json` using incremental transcript tails and periodic reconciliation.
- `tracker.mjs` renders the local history card and fast session query.
- `brain.mjs` runs local tool-action heuristics for the optional build companion.

## Development

Requires Node 18 or newer.

```bash
npm test
```

The Codex suite covers token subset semantics, malformed records, privacy exclusions, dynamic limit windows, account-protocol handshakes, optimizer guidance, and idempotent config setup.

## License

MIT — free to use. See [LICENSE](LICENSE).
