#!/usr/bin/env bash
# maxx installer — wires the statusline + /maxx skill into Claude Code.
#   ./install.sh          copy files into ~/.claude (real install)
#   ./install.sh --link   symlink instead (dev: repo edits stay live)
# Idempotent. Backs up settings.json. Pure Node — no python, no compiled binary.
set -euo pipefail

# ${BASH_SOURCE[0]:-$0} so `set -u` doesn't trip when piped via `curl … | bash` (no source file →
# resolves to the cwd, which won't hold render.mjs → the self-clone path below kicks in).
SRC="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
CLAUDE="$HOME/.claude"
SKILL="$CLAUDE/skills/maxx"
MODE="${1:-copy}"

command -v node >/dev/null || { echo "maxx needs node on PATH." >&2; exit 1; }

# Run standalone via `curl … | bash`? The sibling .mjs files aren't here — fetch the repo and re-exec.
if [ ! -f "$SRC/render.mjs" ]; then
  command -v git >/dev/null || { echo "maxx needs git to self-install (or clone the repo and run maxx/install.sh)." >&2; exit 1; }
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  echo "maxx: fetching…"
  git clone --depth 1 https://github.com/goodindustries/Maxx.git "$TMP/Maxx" >/dev/null 2>&1 || { echo "maxx: clone failed." >&2; exit 1; }
  exec bash "$TMP/Maxx/maxx/install.sh" "$@"
fi

# migrate older installs: the state dir was ~/.tokenmaxx before the rename to ~/.maxx. Keep the streak.
[ -d "$HOME/.tokenmaxx" ] && [ ! -e "$HOME/.maxx" ] && mv "$HOME/.tokenmaxx" "$HOME/.maxx"
mkdir -p "$SKILL" "$HOME/.maxx"

# place a file: link or copy, skipping when src and dst are already the same
place() {
  [ "$1" -ef "$2" ] 2>/dev/null && return 0
  rm -f "$2"
  if [ "$MODE" = "--link" ]; then ln -s "$1" "$2"; else cp "$1" "$2"; fi
}
place "$SRC/SKILL.md"     "$SKILL/SKILL.md"
place "$SRC/render.mjs"   "$SKILL/render.mjs"
place "$SRC/tracker.mjs"  "$SKILL/tracker.mjs"
place "$SRC/limit.mjs"    "$SKILL/limit.mjs"
place "$SRC/agents.mjs"   "$SKILL/agents.mjs"
place "$SRC/emit.mjs"     "$SKILL/emit.mjs"
place "$SRC/watch.mjs"    "$SKILL/watch.mjs"

# wire the statusLine (node render.mjs) into settings.json. render.mjs also refreshes the rolling-token
# window.json on a cadence, so no Stop hook is needed. (Older installs added a brain.mjs Stop hook — we
# remove it here so upgraders aren't left with a dangling hook after brain.mjs was folded away.)
[ -f "$CLAUDE/settings.json" ] && cp "$CLAUDE/settings.json" "$CLAUDE/settings.json.bak-maxx"
RENDER="node $SKILL/render.mjs" SKILLDIR="$SKILL" \
node - "$CLAUDE/settings.json" <<'JS'
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
const p = process.argv[2];
let d = {}; try { d = JSON.parse(readFileSync(p, "utf8")); } catch {}
d.statusLine = { type: "command", command: process.env.RENDER, padding: 0, refreshInterval: 1 };
// drop any legacy maxx Stop hook (brain.mjs, now removed) so it doesn't fail every turn.
if (d.hooks?.Stop) {
  d.hooks.Stop = d.hooks.Stop.filter((h) => !JSON.stringify(h).includes(`${process.env.SKILLDIR}/brain.mjs`));
  if (d.hooks.Stop.length === 0) delete d.hooks.Stop;
}
mkdirSync(dirname(p), { recursive: true });
writeFileSync(p, JSON.stringify(d, null, 2));
JS

echo "maxx installed ($MODE)."
echo "  statusline -> node $SKILL/render.mjs"
echo "  skill      -> $SKILL   (/maxx)"
echo "Start a new Claude Code session to see the bar."
echo ""
echo "Optional — central budget tally (cloud + all machines, one number):"
echo "  node $SKILL/emit.mjs --signup <your-handle>   # claim a handle, get your connector URL"
echo "  node $SKILL/emit.mjs --install-agent          # live-ship usage at login"
