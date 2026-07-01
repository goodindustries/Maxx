#!/usr/bin/env python3
"""Claude Code statusline: model · project · live context gauge · cost · flair.
Reads the statusline JSON on stdin; computes current context occupancy from the
transcript's last usage entry. Colors: green <300K, amber 300-600K, red >600K.
Flair slot = time/session-aware nudges (touch grass, call mom, late night)."""
import sys, json, os, datetime

def c(code, s): return f"\x1b[{code}m{s}\x1b[0m"
def k(n): return f"{n/1_000_000:.2f}M" if n >= 1_000_000 else f"{n/1000:.0f}K"

def pick_flair(ctx, dur_h, now):
    """Return (color, text) or None. Cheap/local only. Rotates every ~30s when
    several apply, so it holds steady instead of flickering each render."""
    pool = []
    if 1 <= now.hour < 5:            pool.append(("35", "🌙 it's late — tokens keep till morning"))
    if dur_h >= 3:                   pool.append(("32", "🌱 3h deep — go touch grass"))
    if now.weekday() == 6:           pool.append(("36", "📞 it's Sunday — call your mom"))
    if now.weekday() == 4 and now.hour >= 16: pool.append(("33", "🍺 it's Friday evening"))
    if not pool: return None
    bucket = int(now.timestamp()) // 30
    return pool[bucket % len(pool)]

def main():
    try: data = json.load(sys.stdin)
    except Exception: print(""); return

    m = data.get("model") or {}
    model = m.get("display_name") or m.get("id", "?")
    ws = data.get("workspace") or {}
    proj = os.path.basename(ws.get("project_dir") or ws.get("current_dir") or data.get("cwd") or "")
    cost = data.get("cost") or {}
    usd = cost.get("total_cost_usd")
    la, lr = cost.get("total_lines_added"), cost.get("total_lines_removed")
    dur_h = (cost.get("total_duration_ms") or 0) / 3_600_000
    tpath = data.get("transcript_path")
    MAX = 200_000 if "haiku" in str(m.get("id", "")).lower() else 1_000_000

    ctx = 0
    if tpath and os.path.exists(tpath):
        try:
            with open(tpath, "rb") as f:
                f.seek(0, 2); size = f.tell(); f.seek(max(0, size - 400_000))
                chunk = f.read().decode("utf-8", "ignore")
            for line in reversed(chunk.splitlines()):
                if '"usage"' not in line: continue
                u = (json.loads(line).get("message") or {}).get("usage")
                if u:
                    ctx = (u.get("input_tokens", 0) or 0) + (u.get("cache_read_input_tokens", 0) or 0) \
                          + (u.get("cache_creation_input_tokens", 0) or 0)
                    break
        except Exception: pass

    pct = min(ctx / MAX, 1.0)
    if ctx >= 600_000:   col, tag = "31;1", " ⚠ /compact"
    elif ctx >= 300_000: col, tag = "33", ""
    else:                col, tag = "32", ""
    bar = "█" * round(pct * 10) + "░" * (10 - round(pct * 10))

    segs = [c("36", model)]
    if proj: segs.append(c("35", proj))
    segs.append(c(col, f"ctx {k(ctx)}/{k(MAX)} {bar}{tag}"))
    if usd is not None: segs.append(c("90", f"${usd:.2f}"))
    if la or lr: segs.append(c("90", f"+{la or 0}/-{lr or 0}"))
    fl = pick_flair(ctx, dur_h, datetime.datetime.now())
    if fl: segs.append(c(fl[0], fl[1]))
    print("  ".join(segs))

if __name__ == "__main__":
    main()
