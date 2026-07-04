#!/usr/bin/env bash
# maxx installer — wires the statusline + /maxx skill into Claude Code.
#   ./install.sh          copy files into ~/.claude (real install)
#   ./install.sh --link   symlink instead (dev: repo edits stay live)
# Idempotent. Backs up settings.json. Pure Node — no python, no compiled binary.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE="$HOME/.claude"
SKILL="$CLAUDE/skills/maxx"
ENDPOINT="${MAXX_ENDPOINT:-https://api.meetmaxx.co}"
MODE="${1:-copy}"

command -v node >/dev/null || { echo "maxx needs node on PATH." >&2; exit 1; }
mkdir -p "$SKILL" "$HOME/.tokenmaxx"

# place a file: link or copy, skipping when src and dst are already the same
place() {
  [ "$1" -ef "$2" ] 2>/dev/null && return 0
  rm -f "$2"
  if [ "$MODE" = "--link" ]; then ln -s "$1" "$2"; else cp "$1" "$2"; fi
}
place "$SRC/SKILL.md"     "$SKILL/SKILL.md"
place "$SRC/render.mjs"   "$SKILL/render.mjs"
place "$SRC/tracker.mjs"  "$SKILL/tracker.mjs"
place "$SRC/optimize.mjs" "$SKILL/optimize.mjs"
place "$SRC/brain.mjs"    "$SKILL/brain.mjs"
place "$SRC/limit.mjs"    "$SKILL/limit.mjs"

# wire the statusLine (node render.mjs) + the coach Stop hook into settings.json.
[ -f "$CLAUDE/settings.json" ] && cp "$CLAUDE/settings.json" "$CLAUDE/settings.json.bak-maxx"
RENDER="node $SKILL/render.mjs" BRAIN="node $SKILL/brain.mjs" \
node - "$CLAUDE/settings.json" <<'JS'
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
const p = process.argv[2];
let d = {}; try { d = JSON.parse(readFileSync(p, "utf8")); } catch {}
d.statusLine = { type: "command", command: process.env.RENDER, padding: 0, refreshInterval: 1 };
const stop = ((d.hooks ??= {}).Stop ??= []);
if (!stop.some((h) => JSON.stringify(h).includes(process.env.BRAIN)))
  stop.push({ hooks: [{ type: "command", command: process.env.BRAIN }] });
mkdirSync(dirname(p), { recursive: true });
writeFileSync(p, JSON.stringify(d, null, 2));
JS

# seed config (don't clobber existing keys)
MAXX_EP="$ENDPOINT" node - <<'JS'
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const p = join(homedir(), ".tokenmaxx", "config.json");
let c = {}; try { c = JSON.parse(readFileSync(p, "utf8")); } catch {}
c.endpoint ??= process.env.MAXX_EP;
(c.ticker ??= {}).speed ??= 1;
writeFileSync(p, JSON.stringify(c, null, 2));
JS

echo "maxx installed ($MODE)."
echo "  statusline -> node $SKILL/render.mjs"
echo "  skill      -> $SKILL   (/maxx)"
echo "  endpoint   -> $ENDPOINT"
echo "Start a new Claude Code session to see the bar."
