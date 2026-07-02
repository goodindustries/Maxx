#!/usr/bin/env bash
# maxx installer — wires the statusline + /maxx skill into Claude Code.
#   ./install.sh          copy files into ~/.claude (real install)
#   ./install.sh --link   symlink instead (dev: repo edits stay live)
# Idempotent. Backs up settings.json. Needs python3 (statusline) + node (skill).
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE="$HOME/.claude"
SKILL="$CLAUDE/skills/maxx"
ENDPOINT="${MAXX_ENDPOINT:-https://api.meetmaxx.co}"
MODE="${1:-copy}"

command -v python3 >/dev/null || { echo "maxx needs python3 on PATH." >&2; exit 1; }
mkdir -p "$SKILL" "$HOME/.tokenmaxx"

# place a file: link or copy, skipping when src and dst are already the same
place() {
  [ "$1" -ef "$2" ] 2>/dev/null && return 0
  rm -f "$2"
  if [ "$MODE" = "--link" ]; then ln -s "$1" "$2"; else cp "$1" "$2"; fi
}
place "$SRC/statusline.py" "$CLAUDE/statusline.py"
place "$SRC/statusline.py" "$SKILL/statusline.py"
place "$SRC/SKILL.md"      "$SKILL/SKILL.md"
place "$SRC/tracker.mjs"   "$SKILL/tracker.mjs"
place "$SRC/optimize.mjs"  "$SKILL/optimize.mjs"
place "$SRC/brain.mjs"     "$SKILL/brain.mjs"
place "$SRC/limit.mjs"     "$SKILL/limit.mjs"

# vendored figlet (self-contained wordmarks — no pip, no network)
if [ -d "$SRC/vendor" ]; then
  rm -rf "$HOME/.tokenmaxx/vendor"
  cp -R "$SRC/vendor" "$HOME/.tokenmaxx/vendor"
fi

# wire the statusLine into settings.json (backup first)
[ -f "$CLAUDE/settings.json" ] && cp "$CLAUDE/settings.json" "$CLAUDE/settings.json.bak-maxx"
python3 - "$CLAUDE/settings.json" <<'PY'
import json, os, sys
p = sys.argv[1]; d = {}
try: d = json.load(open(p))
except Exception: pass
d["statusLine"] = {"type": "command",
                   "command": "python3 " + os.path.expanduser("~/.claude/statusline.py"),
                   "padding": 0, "refreshInterval": 1}
# the brain: a Stop hook fires it each turn to watch the back-and-forth (merge-safe)
brain = "node " + os.path.expanduser("~/.claude/skills/maxx/brain.mjs")
stop = d.setdefault("hooks", {}).setdefault("Stop", [])
if not any(brain in json.dumps(h) for h in stop):
    stop.append({"hooks": [{"type": "command", "command": brain}]})
os.makedirs(os.path.dirname(p), exist_ok=True)
json.dump(d, open(p, "w"), indent=2)
PY

# seed config (don't clobber existing keys)
python3 - "$ENDPOINT" <<'PY'
import json, os, sys
p = os.path.expanduser("~/.tokenmaxx/config.json"); c = {}
try: c = json.load(open(p))
except Exception: pass
c.setdefault("endpoint", sys.argv[1])
c.setdefault("ticker", {}).setdefault("speed", 1)
json.dump(c, open(p, "w"), indent=2)
PY

echo "maxx installed ($MODE)."
echo "  statusline -> $CLAUDE/statusline.py"
echo "  skill      -> $SKILL   (/maxx)"
echo "  endpoint   -> $ENDPOINT"
echo "Start a new Claude Code session to see the bar."
