#!/usr/bin/env bash
# Install the tokenmaxx skill into ~/.claude/skills.
# Symlinks this directory so repo edits stay live. Pass --copy to hard-copy instead.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$HOME/.claude/skills/tokenmaxx"
MODE="${1:-symlink}"

mkdir -p "$HOME/.claude/skills"

if [ -e "$DEST" ] || [ -L "$DEST" ]; then
  echo "removing existing $DEST"
  rm -rf "$DEST"
fi

if [ "$MODE" = "--copy" ]; then
  cp -R "$SRC" "$DEST"
  echo "copied tokenmaxx skill → $DEST"
else
  ln -s "$SRC" "$DEST"
  echo "linked tokenmaxx skill → $DEST"
fi

# --- statusline: live context gauge + flair nudges ---
SL="$HOME/.claude/statusline.py"
[ -e "$SL" ] || [ -L "$SL" ] && rm -f "$SL"
if [ "$MODE" = "--copy" ]; then
  cp "$SRC/statusline.py" "$SL"; echo "copied statusline → $SL"
else
  ln -s "$SRC/statusline.py" "$SL"; echo "linked statusline → $SL"
fi
echo
echo "to activate the statusline, add this to ~/.claude/settings.json:"
echo '  "statusLine": { "type": "command", "command": "python3 '"$SL"'", "padding": 0 }'
echo
echo "run /tokenmaxx in Claude Code (restart the session if it doesn't appear)."
