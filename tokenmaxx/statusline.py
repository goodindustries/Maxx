#!/usr/bin/env python3
"""Claude Code statusline (tokenmaxx) — responsive: cockpit · coach · ticker.

Adapts to terminal width (COLUMNS, set by Claude Code v2.1.153+):
  >=130  3 lines, full cockpit, scrolling ticker + nyan
  90-130 3 lines, cockpit sheds low-priority segs, ticker fits width
  60-90  2 lines, gauge+cost+model, then one rotating discovery item
  <60    1 line, gauge + cost + warning-if-firing

Priority = left-to-right, so a hard truncation sheds the least important first.
  NEED (always): context gauge · active coach warning · cost
  WANT (as room allows): model · rank · ticker(discovery/nyan) · project · live · lines

  - gauge reads context_window from stdin (used_percentage), falls back to the
    transcript tail. color: green <60%, amber 60-80%, red >80% + /compact nag.
  - the ticker scrolls one step per render; it flows while Claude works, rests idle.
  - network banners are opt-in, read from ~/.tokenmaxx/discovery.json (cache), and
    NEVER block the render path.

Run modes:
  (stdin JSON)   render the statusline
  --scan         rescan ~/.claude/projects, refresh the all-time token cache, exit
  --demo [N] [W] print N animated frames at width W (default 12, COLUMNS) with mock data
"""
import sys, json, os, datetime, time, subprocess, glob, shutil, urllib.request

PROJECTS = os.path.expanduser("~/.claude/projects")
CACHE = os.path.expanduser("~/.claude/.tokenmaxx-cache.json")
TM_CONFIG = os.path.expanduser("~/.tokenmaxx/config.json")
DISCOVERY = os.path.expanduser("~/.tokenmaxx/discovery.json")

def c(code, s): return f"\x1b[{code}m{s}\x1b[0m"
def k(n): return f"{n/1_000_000:.2f}M" if n >= 1_000_000 else f"{n/1000:.0f}K"
def big(n):
    if n >= 1e12: return f"{n/1e12:.2f}T"
    if n >= 1e9:  return f"{n/1e9:.1f}B"
    if n >= 1e6:  return f"{n/1e6:.0f}M"
    return f"{n/1e3:.0f}K"

# ─── display width (emoji/CJK render 2 cols; getting this wrong = wrapping) ─────
def _wide(o):
    return (0x1100 <= o <= 0x115F or 0x2329 <= o <= 0x232A or 0x2E80 <= o <= 0x303E
            or 0x3041 <= o <= 0x33FF or 0x3400 <= o <= 0x4DBF or 0x4E00 <= o <= 0x9FFF
            or 0xA000 <= o <= 0xA4CF or 0xAC00 <= o <= 0xD7A3 or 0xF900 <= o <= 0xFAFF
            or 0xFE30 <= o <= 0xFE4F or 0xFF00 <= o <= 0xFF60 or 0xFFE0 <= o <= 0xFFE6
            or 0x1F000 <= o <= 0x1FAFF or 0x2600 <= o <= 0x27BF or 0x2B00 <= o <= 0x2BFF
            or 0x1F1E6 <= o <= 0x1F1FF)
def char_width(ch):
    o = ord(ch)
    if o == 0 or 0x300 <= o <= 0x36F or o == 0xFE0F or o == 0x200D: return 0  # combining/VS16/ZWJ
    return 2 if _wide(o) else 1
def disp_width(s):
    return sum(char_width(ch) for ch in s)

# ─── all-time token cache (background-refreshed, never blocks render) ───────────
def do_scan():
    total = 0
    for f in glob.glob(os.path.join(PROJECTS, "**", "*.jsonl"), recursive=True):
        try: fh = open(f)
        except Exception: continue
        for line in fh:
            if '"usage"' not in line: continue
            try: u = (json.loads(line).get("message") or {}).get("usage") or {}
            except Exception: continue
            total += (u.get("input_tokens", 0) or 0) + (u.get("output_tokens", 0) or 0) \
                   + (u.get("cache_read_input_tokens", 0) or 0) + (u.get("cache_creation_input_tokens", 0) or 0)
    tmp = CACHE + ".tmp"
    json.dump({"all_time_tokens": total, "ts": int(time.time())}, open(tmp, "w"))
    os.replace(tmp, CACHE)

def load_cache():
    try:
        d = json.load(open(CACHE)); return d.get("all_time_tokens", 0), d.get("ts", 0)
    except Exception: return 0, 0

def maybe_refresh(ts):
    if time.time() - ts > 900:
        try:
            subprocess.Popen([sys.executable, os.path.abspath(__file__), "--scan"],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             stdin=subprocess.DEVNULL, start_new_session=True)
        except Exception: pass

def load_tm_config():
    try: return json.load(open(TM_CONFIG)) or {}
    except Exception: return {}

# ─── width ─────────────────────────────────────────────────────────────────────
def term_width(cfg):
    # COLUMNS overstates the usable area — Claude Code clips the last few cols and
    # adds its own "…". Reserve a margin so our lines fit inside the real box.
    tk = cfg.get("ticker", {})
    margin = tk.get("margin", 4)
    raw = 0
    try: raw = int(os.environ.get("COLUMNS", "0"))
    except Exception: raw = 0
    if raw <= 10:
        w = tk.get("width")
        if isinstance(w, int) and w > 10: raw = w
    if raw <= 10:
        try: raw = shutil.get_terminal_size((100, 24)).columns
        except Exception: raw = 100
    if raw <= 10: raw = 100
    return max(20, raw - margin)

# ─── cockpit data ──────────────────────────────────────────────────────────────
def rank_seg():
    try:
        lp = (load_tm_config().get("lastPush")) or {}
        rank = lp.get("rank")
        if not rank: return None
        s = f"⚡#{rank}" + (f"/{lp['total']}" if lp.get("total") else "")
        if lp.get("streak"): s += f" · {lp['streak']}d"
        return s
    except Exception:
        return None

def live_sessions():
    now = time.time(); n = 0
    for f in glob.glob(os.path.join(PROJECTS, "**", "*.jsonl"), recursive=True):
        try:
            if now - os.path.getmtime(f) < 300: n += 1
        except Exception: pass
    return n

def read_last_usage(tpath):
    """Tail the transcript for the most recent usage record → recent cache-hit +
    a ctx fallback (used only when stdin lacks context_window)."""
    out = {"ctx": 0, "cache_hit": None}
    if not (tpath and os.path.exists(tpath)):
        return out
    try:
        with open(tpath, "rb") as f:
            f.seek(0, 2); size = f.tell(); f.seek(max(0, size - 400_000))
            chunk = f.read().decode("utf-8", "ignore")
        for line in reversed(chunk.splitlines()):
            if '"usage"' not in line: continue
            u = (json.loads(line).get("message") or {}).get("usage")
            if not u: continue
            inp = u.get("input_tokens", 0) or 0
            cr  = u.get("cache_read_input_tokens", 0) or 0
            cc  = u.get("cache_creation_input_tokens", 0) or 0
            out["ctx"] = inp + cr + cc
            denom = inp + cr + cc
            out["cache_hit"] = (cr / denom) if denom else None
            break
    except Exception:
        pass
    return out

def gauge(data, ctx_fallback=0):
    """Returns (color, text, pct). Prefer stdin context_window; fall back to tail."""
    cw = data.get("context_window") or {}
    m = data.get("model") or {}
    size = cw.get("context_window_size") or (200_000 if "haiku" in str(m.get("id", "")).lower() else 1_000_000)
    pct = cw.get("used_percentage")
    if pct is None:
        used = usage["ctx"]
        pct = (used / size * 100) if size else 0
    else:
        used = round(size * pct / 100)
    frac = min(pct / 100, 1.0)
    col = "31;1" if pct >= 80 else ("33" if pct >= 60 else "32")
    filled = round(frac * 10)
    bar = "█" * filled + "░" * (10 - filled)
    return col, f"ctx {k(used)}/{k(size)} {bar}", pct

# ─── coach (line 2 / inline) ───────────────────────────────────────────────────
TIPS = [
    "💡 /compact when the gauge goes amber",
    "💡 keep stable context up top — that's what caches",
    "🧼 tokenmaxx: cleaner runs, not bigger burns",
    "💡 Haiku for grunt work, Opus for the hard reasoning",
]

def build_coach(pct, cache_hit):
    """Highest-priority nudge, or None when running clean.
    (color, long_text, urgent, short_text) — short is used on narrow lines."""
    if pct >= 80:
        return ("31;1", "⚠ ctx heavy — /compact to reclaim room", True, "⚠ /compact now")
    if pct >= 60:
        return ("33", "ctx filling up — /compact soon", False, "ctx full soon")
    if cache_hit is not None and cache_hit < 0.30 and pct > 5:
        p = round(cache_hit * 100)
        return ("33", f"cache-hit {p}% — repriming context; keep stable stuff up top", False, f"cache {p}%")
    return None

# ─── ticker (line 3 / rotating item) ───────────────────────────────────────────
DISCOVERY_FALLBACK = [
    "📰 Opus 4.8 + Sonnet 5 top the 2026 coding boards",
    "🔥 trending: ripgrep-mcp · gbrain · tokenmaxx",
    "🧰 try: /compact then reprime to lift cache-hit",
    "🌍 devs in 40+ countries are tokenmaxxing",
]
def discovery_items():
    try:
        raw = json.load(open(DISCOVERY))
        items = [x.get("text") if isinstance(x, dict) else str(x) for x in raw]
        items = [x for x in items if x]
        if items: return items
    except Exception: pass
    return list(DISCOVERY_FALLBACK)

# ─── discovery fetcher (background, gated — never blocks render) ────────────────
# Writes real headlines into ~/.tokenmaxx/discovery.json, which discovery_items()
# already reads. Same pattern as the all-time --scan: the render path only ever
# reads the cached file; the network call happens in a detached process.
HN_URL = "https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=12"

def fetch_discovery(cfg=None):
    url = ((cfg or {}).get("discovery") or {}).get("url") or HN_URL
    req = urllib.request.Request(url, headers={"User-Agent": "tokenmaxx-statusline"})
    with urllib.request.urlopen(req, timeout=6) as r:
        data = json.load(r)
    items = []
    for h in data.get("hits", []):
        t = (h.get("title") or "").strip()
        if not t: continue
        pts = h.get("points") or 0
        if len(t) > 68: t = t[:67] + "…"
        items.append(f"📰 {t} · {pts}pts")
    if items:
        tmp = DISCOVERY + ".tmp"
        json.dump(items[:10], open(tmp, "w"))
        os.replace(tmp, DISCOVERY)

def maybe_fetch_discovery(cfg, ttl=1800):
    """Spawn a detached fetch when the feed is missing or older than ttl (30 min)."""
    if not ((cfg.get("discovery") or {}).get("enabled", True)):
        return
    try:
        if time.time() - os.path.getmtime(DISCOVERY) < ttl:
            return
    except Exception:
        pass  # missing → fetch
    try:
        subprocess.Popen([sys.executable, os.path.abspath(__file__), "--fetch-discovery"],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         stdin=subprocess.DEVNULL, start_new_session=True)
    except Exception:
        pass

def life_items(now, dur_h):
    out = []
    if 1 <= now.hour < 5:                     out.append("🌙 it's late — tokens keep till morning")
    if dur_h >= 3:                            out.append("🌱 3h deep — go touch grass")
    if now.weekday() == 6:                    out.append("📞 it's Sunday — call your mom")
    if now.weekday() == 4 and now.hour >= 16: out.append("🍺 Friday evening — wrap it up")
    return out

def milestone_items(alltime):
    out = []
    if alltime > 0:
        thr = [1e9, 2e9, 5e9, 1e10, 2.5e10, 5e10, 1e11, 2.5e11, 5e11, 1e12]
        crossed = [t for t in thr if alltime >= t]
        if crossed and alltime < crossed[-1] * 1.10:
            out.append(f"🎉 just crossed {big(crossed[-1])} tokens!")
        out.append(f"🏆 {big(alltime)} tokens all-time")
    return out

NYAN = ["🌈▬▬▬(=^･ω･^=)", "🌈═▬▬(=^･ω･^=)", "🌈▬═▬(=^･ω･^=)", "🌈▬▬═(=^･ω･^=)"]
def nyan(offset): return NYAN[offset % len(NYAN)]
RAINBOW = ["31", "33", "32", "36", "34", "35"]

def ticker_items(now, dur_h, alltime, cfg):
    items = []
    items += milestone_items(alltime)
    items += discovery_items()
    items += life_items(now, dur_h)
    items += [str(x) for x in (cfg.get("ticker", {}).get("items") or [])]
    items.append(nyan(int(now.timestamp())))
    return [x for x in items if x]

def marquee(items, width, offset, sep="   ·   "):
    """Display-width-aware scrolling window — never exceeds `width` columns."""
    ring = sep.join(items)
    if disp_width(ring) <= width:
        pad = width - disp_width(ring)
        return ring + " " * max(0, pad)
    chars = list(ring + sep)
    n = len(chars)
    start = offset % n
    out, w, i = "", 0, 0
    while w < width and i < n * 2:
        ch = chars[(start + i) % n]
        cw = char_width(ch)
        if w + cw > width: break
        out += ch; w += cw; i += 1
    return out + " " * (width - w)

# ─── fit helpers ───────────────────────────────────────────────────────────────
def join_fit(parts, cols, sep="  "):
    """parts: (plain, colored) in priority order (front = keep). Include until the
    display width would exceed cols — so truncation sheds the least important."""
    kept, plain_acc = [], ""
    for plain, colored in parts:
        cand = (sep if plain_acc else "") + plain
        if disp_width(plain_acc + cand) > cols: break
        plain_acc += cand; kept.append(colored)
    return sep.join(kept)

def trunc(s, cols):
    if disp_width(s) <= cols: return s
    out, w = "", 0
    for ch in s:
        cw = char_width(ch)
        if w + cw > cols - 1: break
        out += ch; w += cw
    return out + "…"

# ─── throttled slow ops (keep the 1s heartbeat cheap) ──────────────────────────
LIVE_CACHE = os.path.expanduser("~/.tokenmaxx/.live-cache.json")
def cached_live(ttl=5):
    """live_sessions() globs the whole projects dir — throttle it to every `ttl`s so
    the ticker can animate every second without churning the disk."""
    try:
        d = json.load(open(LIVE_CACHE))
        if time.time() - d.get("ts", 0) < ttl:
            return d.get("live", 0)
    except Exception: pass
    n = live_sessions()
    try: json.dump({"live": n, "ts": time.time()}, open(LIVE_CACHE, "w"))
    except Exception: pass
    return n

# ─── test fill: show the full 3-line canvas at the real terminal width ──────────
def fill_lines(cols):
    """A ruler + two filled bands, each exactly `cols` wide, so you can see the
    actual screen real estate we're designing into. Enable via config test_fill."""
    r = ["·"] * cols
    for p in range(0, cols, 10):
        for j, ch in enumerate(str(p)):
            if p + j < cols: r[p + j] = ch
    ruler = "".join(r)
    def band(label, fillch):
        lab = f" {label} · {cols} cols "
        if disp_width(lab) > cols: lab = f" {cols} "
        pad = cols - disp_width(lab)
        left = pad // 2
        return fillch * left + lab + fillch * (pad - left)
    return [c("36", ruler), c("35", band("line 2", "░")), c("33", band("line 3 · ticker", "▓"))]

# ─── assembly ──────────────────────────────────────────────────────────────────
def render(data, alltime, now, offset, cfg):
    cols = term_width(cfg)
    if cfg.get("test_fill"):
        return "\n".join(fill_lines(cols))

    # cache-hit straight from stdin's context_window (no transcript tail) — keeps
    # the 1s heartbeat cheap enough to run every second.
    cu = (data.get("context_window") or {}).get("current_usage") or {}
    ci = (cu.get("input_tokens", 0) or 0) + (cu.get("cache_creation_input_tokens", 0) or 0) + (cu.get("cache_read_input_tokens", 0) or 0)
    cache_hit = ((cu.get("cache_read_input_tokens", 0) or 0) / ci) if ci else None
    gcol, gtext, pct = gauge(data)
    coach = build_coach(pct, cache_hit)

    cost = data.get("cost") or {}
    usd = cost.get("total_cost_usd")
    dur_h = (cost.get("total_duration_ms") or 0) / 3_600_000
    m = data.get("model") or {}
    model = m.get("display_name") or m.get("id", "?")
    ws = data.get("workspace") or {}
    proj = os.path.basename(ws.get("project_dir") or ws.get("current_dir") or "")
    la, lr = cost.get("total_lines_added"), cost.get("total_lines_removed")
    rk = rank_seg()
    live = cached_live()

    # cockpit parts in priority order (needs first → truncation sheds wants)
    parts = [(gtext, c(gcol, gtext))]
    if coach and coach[2]:  # urgent warning beats cost — active danger is a need, rides line 1
        wtxt = coach[3] if cols < 100 else coach[1]  # short form on narrow panes
        parts.append((wtxt, c(coach[0], wtxt)))
    if usd is not None: parts.append((f"${usd:.2f}", c("90", f"${usd:.2f}")))
    parts.append((model, c("36", model)))
    if rk: parts.append((rk, c("33", rk)))
    if proj: parts.append((proj, c("35", proj)))
    if live > 1: parts.append((f"👥 {live} live", c("34", f"👥 {live} live")))
    if la or lr: parts.append((f"+{la or 0}/-{lr or 0}", c("90", f"+{la or 0}/-{lr or 0}")))

    # ── tiny: one line ──
    if cols < 60:
        return join_fit(parts, cols)

    line1 = join_fit(parts, cols)

    # ── narrow: two lines, discovery realm survives as one rotating item ──
    if cols < 90:
        if coach and not coach[2]:
            line2 = c(coach[0], trunc(coach[1], cols))
        else:
            items = ticker_items(now, dur_h, alltime, cfg)
            item = items[offset % len(items)]
            line2 = c(RAINBOW[offset % len(RAINBOW)], trunc(item, cols))
        return line1 + "\n" + line2

    # ── wide: three lines, scrolling ticker ──
    line2 = c(coach[0], coach[1]) if (coach and not coach[2]) else c("90", TIPS[(int(now.timestamp()) // 20) % len(TIPS)])
    items = ticker_items(now, dur_h, alltime, cfg)
    win = marquee(items, max(20, cols - 3), offset)
    line3 = c("90", "⚡ ") + c(RAINBOW[offset % len(RAINBOW)], win)
    return "\n".join([line1, line2, line3])

def main():
    try: data = json.load(sys.stdin)
    except Exception: print(""); return
    cfg = load_tm_config()
    alltime, ts = load_cache(); maybe_refresh(ts)
    maybe_fetch_discovery(cfg)
    now = datetime.datetime.now()
    try: speed = float(cfg.get("ticker", {}).get("speed", 3))  # chars/sec — our knob
    except Exception: speed = 3.0
    offset = int(time.time() * speed)
    print(render(data, alltime, now, offset, cfg))

# ─── demo ──────────────────────────────────────────────────────────────────────
def demo(frames=12, width=None):
    cfg = load_tm_config()
    now = datetime.datetime.now()
    if width: os.environ["COLUMNS"] = str(width)
    cols = term_width(cfg)
    alltime = 16_600_000_000
    for i in range(frames):
        pct = 8 + i * 12  # climb so the gauge + coach escalate across frames
        data = {
            "model": {"display_name": "Opus 4.8 (1M context)", "id": "claude-opus-4-8"},
            "workspace": {"project_dir": "/Users/reify/Classified/Maxx"},
            "cost": {"total_cost_usd": 2.37, "total_lines_added": 812,
                     "total_lines_removed": 240, "total_duration_ms": 3 * 3_600_000},
            "context_window": {"context_window_size": 1_000_000, "used_percentage": min(pct, 99)},
            "transcript_path": None,
        }
        # mock a low cache-hit early so that nudge shows before ctx gets heavy
        usage = {"ctx": 0, "cache_hit": 0.22 if i < 2 else 0.61}
        gcol, gtext, gp = gauge(data, usage)
        print(f"── frame {i+1}  (cols={cols}, ctx={min(pct,99)}%) ".ljust(cols, "─")[:cols])
        # reuse render but with our mock usage by monkeypatching the tail read
        _orig = globals()["read_last_usage"]
        globals()["read_last_usage"] = lambda _t, _u=usage: _u
        try:
            print(render(data, alltime, now, offset=i * 3, cfg=cfg))
        finally:
            globals()["read_last_usage"] = _orig
        print()

if __name__ == "__main__":
    if "--scan" in sys.argv:
        do_scan()
    elif "--fetch-discovery" in sys.argv:
        try: fetch_discovery(load_tm_config())
        except Exception as e: sys.stderr.write(f"tokenmaxx discovery: {e}\n")
    elif "--fill" in sys.argv:
        nums = [int(a) for a in sys.argv if a.isdigit()]
        if nums: os.environ["COLUMNS"] = str(nums[0])
        print("\n".join(fill_lines(term_width(load_tm_config()))))
    elif "--demo" in sys.argv:
        nums = [int(a) for a in sys.argv if a.isdigit()]
        n = nums[0] if len(nums) >= 1 else 12
        w = nums[1] if len(nums) >= 2 else None
        demo(n, w)
    else:
        main()
