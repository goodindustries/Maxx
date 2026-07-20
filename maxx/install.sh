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
place "$SRC/gate.mjs"     "$SKILL/gate.mjs"
place "$SRC/fenix.mjs"    "$SKILL/fenix.mjs"
mkdir -p "$CLAUDE/skills/fenix"
place "$SRC/FENIX-SKILL.md" "$CLAUDE/skills/fenix/SKILL.md"

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
// hard budget gate: deny expensive spawns when the central tally says over/stale.
// Toggle/overturn: node <skill>/gate.mjs --on|--off|--overturn "reason" (overturns are recorded).
d.hooks = d.hooks || {};
d.hooks.PreToolUse = (d.hooks.PreToolUse || []).filter((h) => !JSON.stringify(h).includes("gate.mjs"));
d.hooks.PreToolUse.push({
  matcher: "Agent|Task|Workflow|ScheduleWakeup|CronCreate",
  hooks: [{ type: "command", command: `node ${process.env.SKILLDIR}/gate.mjs`, timeout: 10 }],
});
// fenix rebirth: on session start, inject (and consume) a pending .fenix/handoff.md
// from the cwd — the other half of /fenix (write handoff → /clear → rise here).
d.hooks.SessionStart = (d.hooks.SessionStart || []).filter((h) => !JSON.stringify(h).includes("fenix.mjs"));
d.hooks.SessionStart.push({
  hooks: [{ type: "command", command: `node ${process.env.SKILLDIR}/fenix.mjs --wake`, timeout: 10 }],
});
mkdirSync(dirname(p), { recursive: true });
writeFileSync(p, JSON.stringify(d, null, 2));
JS

echo "maxx installed ($MODE)."
echo "  statusline -> node $SKILL/render.mjs"
echo "  skill      -> $SKILL   (/maxx)"
echo "Start a new Claude Code session to see the bar."

# Web-claimed handle → zero-step CLI link. The signup form prints:
#   curl -fsSL https://meetmaxx.co/install | MAXX_HANDLE=<h> MAXX_SECRET=<k> bash
# which lands here: write the credentials into ~/.maxx/config.json (merging, never
# clobbering an EXISTING different handle) and start the live shipper.
if [ -n "${MAXX_HANDLE:-}" ] && [ -n "${MAXX_SECRET:-}" ]; then
  LINKED=$(MAXX_HANDLE="$MAXX_HANDLE" MAXX_SECRET="$MAXX_SECRET" node - <<'JS'
const { readFileSync, writeFileSync } = require("fs");
const p = process.env.HOME + "/.maxx/config.json";
let c = {}; try { c = JSON.parse(readFileSync(p, "utf8")); } catch {}
const h = process.env.MAXX_HANDLE, k = process.env.MAXX_SECRET;
if (c.handle && c.handle !== "unknown" && c.handle !== h) { console.log("KEPT:" + c.handle); process.exit(0); }
writeFileSync(p, JSON.stringify({ ...c, handle: h, secret: k, logsUrl: c.logsUrl || "https://api.meetmaxx.co" }, null, 2));
console.log("LINKED:" + h);
JS
)
  case "$LINKED" in
    LINKED:*)
      H="${LINKED#LINKED:}"
      echo ""
      echo "maxx: linked to @$H — this machine now ships to your tally."
      node "$SKILL/emit.mjs" --install-agent || true
      node "$SKILL/emit.mjs" --send >/dev/null 2>&1 || true
      echo ""
      echo "  one more paste — claude.ai → Settings → Connectors → Add custom connector → name Maxx:"
      echo "    https://api.meetmaxx.co/mcp?handle=$H&k=$MAXX_SECRET"
      echo ""
      echo "  check your setup (private link — has your secret):"
      echo "    https://meetmaxx.co/u/$H?k=$MAXX_SECRET"
      echo ""
      echo "  binge-watch your tokens → https://meetmaxx.co/u/$H"
      ;;
    KEPT:*)
      echo ""
      echo "maxx: this machine is already linked to @${LINKED#KEPT:} — NOT overwriting."
      echo "  to relink: edit ~/.maxx/config.json (handle/secret), then node $SKILL/emit.mjs --install-agent"
      ;;
  esac
else
  # Zero-decision onboarding: no env link and no existing handle → claim one automatically
  # from the Claude login (email local part; -uuid suffix if taken). Picking a name is the
  # OPTIONAL step, not the gate — the fastest path to "binge-watch your tokens" is one paste.
  EXISTING=$(node -e 'try{const c=require(process.env.HOME+"/.maxx/config.json");process.stdout.write(c.handle&&c.handle!=="unknown"?c.handle:"")}catch{}' 2>/dev/null || true)
  if [ -n "$EXISTING" ]; then
    echo ""
    echo "maxx: already linked to @$EXISTING · card → https://meetmaxx.co/u/$EXISTING"
  elif node "$SKILL/emit.mjs" --signup; then
    node "$SKILL/emit.mjs" --install-agent || true
    node "$SKILL/emit.mjs" --send >/dev/null 2>&1 || true
    NEWH=$(node -e 'try{process.stdout.write(require(process.env.HOME+"/.maxx/config.json").handle||"")}catch{}' 2>/dev/null || true)
    [ -n "$NEWH" ] && echo "  binge-watch your tokens → https://meetmaxx.co/u/$NEWH   (want a different name? node $SKILL/emit.mjs --signup <handle>)"
  else
    echo ""
    echo "Optional — central budget tally (cloud + all machines, one number):"
    echo "  node $SKILL/emit.mjs --signup                 # derives your handle from your Claude login"
    echo "  node $SKILL/emit.mjs --install-agent          # live-ship usage at login"
  fi
fi
