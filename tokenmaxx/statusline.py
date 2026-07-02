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
import sys, json, os, datetime, time, subprocess, glob, shutil, urllib.request, re, random, colorsys

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

# ─── brand palette — one purple family, mathematically aligned to Claude orange ─
# Claude's orange sits at hue ~18°. Rotate +252° to land on purple (~270°), then
# ramp every shade by lightness at matched chroma. One family, from the light
# painted background up to the accent. Retune by changing _H / the s,l pairs.
def _hsl(h, s, l):
    r, g, b = colorsys.hls_to_rgb((h % 360) / 360.0, l, s)
    return (round(r * 255), round(g * 255), round(b * 255))
_H = 270
BRAND  = _hsl(_H,      0.58, 0.52)   # accent: the M, gauge fill
INK    = _hsl(_H,      0.48, 0.30)   # values (pop)
DIM    = _hsl(_H,      0.22, 0.50)   # labels (recede)
TRACK  = _hsl(_H,      0.30, 0.78)   # gauge shade track
BG     = _hsl(_H,      0.40, 0.93)   # the painted light background
WARN   = _hsl(_H + 18, 0.60, 0.55)   # hotter purple
DANGER = _hsl(_H + 38, 0.66, 0.52)   # magenta alert
# health = a traffic light you read WITHOUT reading: green ok / amber caution / red act
GREEN  = (0x2f, 0xa8, 0x4a)          # we're ok — glance and move on
AMBER  = (0xd6, 0x9e, 0x2e)          # getting close / off your normal
RED    = (0xe0, 0x43, 0x3c)          # act now
# reset FG only (\x1b[39m) so a line-level background persists through segments
def rgb(t, s): return f"\x1b[38;2;{t[0]};{t[1]};{t[2]}m{s}\x1b[39m"
def gbar(frac, w=14):
    frac = max(0.0, min(1.0, frac))
    fill = round(frac * w)
    col = DANGER if frac >= 0.80 else (WARN if frac >= 0.60 else BRAND)
    return rgb(col, "█" * fill) + rgb(TRACK, "░" * (w - fill))  # fill blocks, shaded track

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

_ANSI = re.compile(r'\x1b\[[0-9;]*m')
def paint(s, cols):
    """Lay the line on the light background band, padded to the full width so the
    whole painted section is one solid field."""
    pad = " " * max(0, cols - disp_width(_ANSI.sub('', s)))
    return f"\x1b[48;2;{BG[0]};{BG[1]};{BG[2]}m{s}{pad}\x1b[0m"

def boxed(lines, inner, bevel=True):
    """Frame the painted band in a rounded border box. `bevel` gives it Game Boy
    depth: a soft-lit top/left edge over a deep bottom/right shadow, so the panel
    reads as a raised tile (light source top-left). `inner` = content width."""
    W = inner + 4
    band = lambda s: f"\x1b[48;2;{BG[0]};{BG[1]};{BG[2]}m{s}\x1b[0m"
    hi = _hsl(_H, 0.30, 0.64) if bevel else DIM     # top + left  (catches light)
    sh = _hsl(_H, 0.52, 0.32) if bevel else DIM     # bottom + right (in shadow)
    out = [band(rgb(hi, "╭" + "─" * (W - 2) + "╮"))]
    for l in lines:
        pad = " " * max(0, inner - disp_width(_ANSI.sub('', l)))
        out.append(band(rgb(hi, "│") + " " + l + pad + " " + rgb(sh, "│")))
    out.append(band(rgb(sh, "╰" + "─" * (W - 2) + "╯")))
    return out

# ─── expanded 5-line panel: the wordmark M enclosed full-height on the right ─────
MMARK = ("█   █", "██ ██", "█ █ █", "█   █", "█   █")   # the M, 5 rows, on-cells = █
def m_mark_row(r, phase=0.0, border=False, bcol=None):
    """One row of the full-height M as beveled 3D tiles — each pixel a raised cube
    (lit left face, shadowed right face) — with a slow specular shine sweeping
    diagonally across as `phase` advances each render. Border rows fill off-cells
    with dashes to keep the frame."""
    base = 0.55 - 0.20 * (r / 4.0)                       # tile depth: top rows lighter
    out = ""
    for c, ch in enumerate(MMARK[r]):
        if ch != "█":
            out += rgb(bcol, "──") if border else "  "
            continue
        shine = max(0.0, 1.0 - abs((c - r) - phase) / 1.8)   # moving diagonal light band
        l = base + 0.32 * shine
        lit = _hsl(_H, 0.52, min(0.97, l + 0.18))        # tile top-left face (bright — thicker bevel)
        dk  = _hsl(_H, 0.70, max(0.09, l - 0.26))        # tile bottom-right face (deep shadow)
        out += rgb(lit, "█") + rgb(dk, "█")
    return out

def boxed_M(lines, inner, tick=0):
    """Expanded panel: rounded beveled box, five content rows, with the full-height
    tiled M enclosed on the right. Depth comes from shading: a vertical background
    gradient (lit from above) + beveled M tiles + a slow shine sweeping across the M
    as `tick` advances. Total height is 7 (borders + 5 rows)."""
    lines = (list(lines) + [""] * 5)[:5]
    hi = _hsl(_H, 0.28, 0.66); sh = _hsl(_H, 0.55, 0.30)      # bevel: lit / shadow
    innerW = inner + 13                                        # ' ' + text + ' ' + M(10) + ' '
    phase = ((tick % 28) / 28.0) * 12.0 - 6.0                 # shine sweeps across ~ every 28 renders (slow glint)
    # domed shading: bright highlight lip under the top edge → deep shadow at the
    # base. The non-linear ramp (brighter row 0-1, darker row 5-6) reads as a raised
    # bezel catching light from above; tune the 7 stops to taste.
    RAMP = (0.965, 0.95, 0.925, 0.90, 0.875, 0.85, 0.825)
    def band(s, i):
        b = _hsl(_H, 0.42, RAMP[i])
        return f"\x1b[48;2;{b[0]};{b[1]};{b[2]}m{s}\x1b[0m"
    out = [band(rgb(hi, "╭" + "─" * innerW + "╮"), 0)]
    for i in range(5):
        pad = " " * max(0, inner - disp_width(_ANSI.sub('', lines[i])))
        out.append(band(rgb(hi, "│") + " " + lines[i] + pad + " " + m_mark_row(i, phase) + " " + rgb(sh, "│"), i + 1))
    out.append(band(rgb(sh, "╰" + "─" * innerW + "╯"), 6))
    return out

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

# ─── live state: commands + endpoints write here, the statusline reads it every ──
# tick (~1s), so `/tokenmaxx <thing>` shows up in the bar in real time. This is the
# widget bus. SECURITY: sanitize() strips ANSI/control chars — remote or user
# content must never inject terminal escapes, and we never execute fetched code.
STATE = os.path.expanduser("~/.tokenmaxx/state.json")
FISH = ["><>", "<><", "><(((°>", "<°)))><", "></(((º>"]
def sanitize(s, limit=48):
    s = re.sub(r'\x1b\[[0-9;]*[A-Za-z]', '', str(s))          # strip CSI escapes
    s = "".join(ch for ch in s if ch >= " " and ch != "\x7f")  # drop control chars
    return s[:limit]
def read_state():
    try: return json.load(open(STATE)) or {}
    except Exception: return {}
def set_state(**kw):
    st = read_state(); st.update(kw)
    try:
        os.makedirs(os.path.dirname(STATE), exist_ok=True)
        tmp = STATE + ".tmp"; json.dump(st, open(tmp, "w")); os.replace(tmp, STATE)
    except Exception: pass

TICK_FILE = os.path.expanduser("~/.tokenmaxx/.tick")
def next_offset(step=1):
    """Advance the ticker by `step` columns per render — smooth, refresh-paced,
    instead of jumping by wall-clock elapsed time between refreshes."""
    try: n = int(open(TICK_FILE).read().strip())
    except Exception: n = 0
    n += max(1, int(step))
    try: open(TICK_FILE, "w").write(str(n))
    except Exception: pass
    return n

# ─── compact runway: sample ctx% per turn → velocity → turns to the compact cliff ─
def _ctx_file(key):
    # per-session file (keyed by transcript path) so concurrent sessions/windows
    # don't cross-contaminate each other's ctx history.
    base = re.sub(r'[^A-Za-z0-9_-]', '', os.path.basename(key or "default"))[:40] or "default"
    return os.path.join(os.path.expanduser("~/.tokenmaxx"), ".ctx-" + base)
def sample_ctx(pct, key=None):
    """Record ctx% samples (one per turn, when it moves) for THIS session so the
    coach can project a compact runway. Resets on a sharp drop — a compact or a
    fresh session."""
    path = _ctx_file(key)
    try: hist = json.load(open(path))
    except Exception: hist = []
    if hist and pct < hist[-1][1] - 5:              # big drop → compact / new session
        hist = []
    if not hist or abs(pct - hist[-1][1]) >= 0.5:    # ctx moved → a new turn
        hist.append([time.time(), pct]); hist = hist[-8:]
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            tmp = path + ".tmp"; json.dump(hist, open(tmp, "w")); os.replace(tmp, path)
        except Exception: pass
    return hist

def ctx_runway(hist, cliff=85):
    """Turns to the compact cliff from the recent positive ctx slope, or None if
    there aren't enough samples or context is stable."""
    pts = [p for _, p in hist]
    if len(pts) < 3: return None
    ups = [pts[i] - pts[i - 1] for i in range(1, len(pts)) if pts[i] - pts[i - 1] > 0]
    if not ups: return None
    vel = sum(ups) / len(ups)                        # %/turn
    if vel < 0.1: return None
    return max(0, round((cliff - pts[-1]) / vel))

# ─── companion memory: rolling baselines of YOUR normal (the watchdog knows you) ──
PROFILE = os.path.expanduser("~/.tokenmaxx/profile.json")
def update_baseline(cache_hit, alpha=0.02):
    """EWMA of the user's normal, updated as maxx watches. On-machine, never leaves.
    The point: guide against YOUR baseline, not a generic threshold."""
    if cache_hit is None: return
    try: p = json.load(open(PROFILE))
    except Exception: p = {}
    p["cache"] = p.get("cache", cache_hit) * (1 - alpha) + cache_hit * alpha
    p["n"] = p.get("n", 0) + 1
    try:
        os.makedirs(os.path.dirname(PROFILE), exist_ok=True)
        tmp = PROFILE + ".tmp"; json.dump(p, open(tmp, "w")); os.replace(tmp, PROFILE)
    except Exception: pass
def cache_baseline(min_n=200):
    """Your established normal cache-hit, or None until maxx has watched enough."""
    try:
        p = json.load(open(PROFILE))
        if p.get("n", 0) >= min_n: return p.get("cache")
    except Exception: pass
    return None

# ─── dev-state: branch (free, from .git/HEAD) + dirty count (cached) + path ───────
def repo_root(start):
    """Walk up from `start` to the dir holding .git (dir or worktree file)."""
    d = start
    for _ in range(6):
        if not d: break
        if os.path.exists(os.path.join(d, ".git")): return d
        nd = os.path.dirname(d)
        if nd == d: break
        d = nd
    return None

def git_branch(root):
    """Current branch straight from .git/HEAD — no subprocess. Short sha if detached."""
    try:
        g = os.path.join(root, ".git")
        if os.path.isfile(g):                        # worktree: .git is a 'gitdir:' pointer
            p = open(g).read().strip()
            if p.startswith("gitdir: "): g = p[8:]
        head = open(os.path.join(g, "HEAD")).read().strip()
        if head.startswith("ref: refs/heads/"): return head[len("ref: refs/heads/"):]
        return head[:7] if head else None
    except Exception: return None

def _git_cache(root):
    base = re.sub(r'[^A-Za-z0-9_-]', '', root)[-40:] or "root"
    return os.path.expanduser("~/.tokenmaxx/.git-" + base)
def git_dirty(root, ttl=8):
    """Cached count of dirty files; spawns a detached refresh when stale."""
    count, ts = None, 0
    try:
        d = json.load(open(_git_cache(root))); count = d.get("dirty"); ts = d.get("ts", 0)
    except Exception: pass
    if time.time() - ts > ttl:
        try:
            subprocess.Popen([sys.executable, os.path.abspath(__file__), "--git-scan", root],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             stdin=subprocess.DEVNULL, start_new_session=True)
        except Exception: pass
    return count
def do_git_scan(root):
    try:
        out = subprocess.run(["git", "-C", root, "status", "--porcelain"],
                             capture_output=True, text=True, timeout=5).stdout
        count = sum(1 for l in out.splitlines() if l.strip())
    except Exception: count = None
    try:
        p = _git_cache(root); os.makedirs(os.path.dirname(p), exist_ok=True)
        tmp = p + ".tmp"; json.dump({"dirty": count, "ts": int(time.time())}, open(tmp, "w")); os.replace(tmp, p)
    except Exception: pass

def short_path(p, keep=2):
    """~-relative cwd; if deep, elide to …/last-two so it stays honest and short."""
    if not p: return ""
    p = p.replace(os.path.expanduser("~"), "~")
    segs = [s for s in p.split(os.sep) if s]
    if len(segs) <= keep + 1: return p
    return "…/" + os.sep.join(segs[-keep:])

def path_in_repo(cur, root, proj):
    """Repo-relative cwd (proj/sub…), or the elided ~-path when not in a repo."""
    if root and cur and cur.startswith(root):
        rel = cur[len(root):].strip(os.sep)
        return proj + "/" + rel if rel else proj
    return short_path(cur)

# ─── width ─────────────────────────────────────────────────────────────────────
def _raw_cols(cfg):
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

def box_enabled(cfg):
    v = read_state().get("box")
    if v is None: v = cfg.get("box", True)
    return bool(v)

def expanded_on(cfg):
    v = read_state().get("expanded")
    if v is None: v = cfg.get("expanded", True)
    return bool(v)

def tight_on(cfg):
    v = read_state().get("tight")
    if v is None: v = cfg.get("tight", False)
    return bool(v)

def layout(cfg):
    """(mode, inner_width). mode: 'tight' (one health line), 'expanded' (5-line M
    panel), 'box' (compact framed), or 'bare'. Tight wins when opted in."""
    w = _raw_cols(cfg)
    if tight_on(cfg):
        return "tight", w
    if not box_enabled(cfg):
        return "bare", w
    if expanded_on(cfg) and w >= 80:
        return "expanded", max(40, w - 15)     # reserve border+pad+M+gap
    return "box", max(16, w - 4)

def term_width(cfg):
    return layout(cfg)[1]

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
    """Returns (plain, colored, pct). Dim label, ink value, terracotta bar."""
    cw = data.get("context_window") or {}
    m = data.get("model") or {}
    size = cw.get("context_window_size") or (200_000 if "haiku" in str(m.get("id", "")).lower() else 1_000_000)
    pct = cw.get("used_percentage")
    if pct is None:
        used = ctx_fallback
        pct = (used / size * 100) if size else 0
    else:
        used = round(size * pct / 100)
    us, sz = k(used), k(size)
    plain = f"ctx {us}/{sz} " + "█" * 14
    colored = rgb(DIM, "ctx ") + rgb(INK, us) + rgb(DIM, "/" + sz) + " " + gbar(pct / 100)
    return plain, colored, pct

# ─── coach (line 2 / inline) ───────────────────────────────────────────────────
TIPS = [
    "/compact when the gauge turns amber",
    "keep stable context up top — that's what caches",
    "cleaner runs, not bigger burns",
    "Haiku for grunt work, Opus for hard reasoning",
]
def coach_col(level):
    return {"danger": DANGER, "warn": WARN, "info": BRAND, "good": DIM}.get(level, WARN)

def health(coach, runway, cache_hit=None, cache_base=None):
    """A traffic light: (dot, color, text). GREEN = ok (nothing to read — glance and
    move on). AMBER/RED only when it matters, and then it names the ONE thing. The
    compact number appears when it's close, never as something to hunt for."""
    if coach and coach[2]:                                    # RED — act now
        return "●", RED, coach[3]
    if runway is not None and runway <= 10:                   # AMBER — cliff getting close
        return "●", AMBER, f"compact in ~{runway}"
    if cache_base is not None and cache_hit is not None and cache_hit < cache_base - 0.15:
        return "●", AMBER, "cache below your usual"           # AMBER — off YOUR normal
    if coach and coach[0] == "warn":                          # AMBER — other caution
        return "●", AMBER, coach[3]
    return "●", GREEN, "ok"                                   # GREEN — we're good

def tight_line(coach, runway, cache_hit, cache_base, gbranch, gdirty, usd, cols):
    """The health-first single line: ● ok · branch · $ — a green glance, not data."""
    glyph, col, ans = health(coach, runway, cache_hit, cache_base)
    segs = [rgb(col, glyph + " ") + rgb(INK if col != GREEN else DIM, ans)]
    if gbranch:
        segs.append(rgb(DIM, gbranch) + (rgb(WARN, f" ±{gdirty}") if gdirty else ""))
    if usd is not None:
        segs.append(rgb(DIM, "$") + rgb(INK, f"{usd:.0f}" if usd >= 10 else f"{usd:.2f}"))
    return trunc(rgb(DIM, "  ·  ").join(segs), cols)

def build_coach(pct, cache_hit, usd=None, dur_h=0, model="", runway=None):
    """The efficiency coach: highest-priority nudge from the signals the bar sees.
    (level, long_text, urgent, short_text) — level in {danger,warn,info,good}.
    Grounded in the real token levers: compact timing, cache-hits, model routing.
    `runway` = projected turns to the compact cliff (None if unknown/stable)."""
    p = round(cache_hit * 100) if cache_hit is not None else None
    burn = (usd / dur_h) if (usd and dur_h and dur_h > 0) else None   # $/hr
    is_opus = "opus" in str(model).lower()

    # 1. context — time-critical. Auto-compact near the top is costly + lossy;
    #    compacting at a clean boundary is cheaper and keeps quality. When we can
    #    project a runway, tell them exactly how many turns they have.
    if pct >= 85:
        return ("danger", "context near auto-compact — /compact now at a clean point", True, "/compact now")
    if pct >= 65:
        if runway is not None and runway <= 12:
            plural = "" if runway == 1 else "s"
            return ("warn", f"~{runway} turn{plural} to the compact cliff — /compact at your next task boundary",
                    False, f"compact ~{runway}t")
        return ("warn", "context filling — /compact at the next task boundary", False, f"ctx {int(pct)}%")

    # 2. cache-hit — the biggest cost lever. Cache reads are ~10x cheaper than
    #    fresh input; a low rate means the prefix is churning or the session idled.
    if p is not None and pct > 5:
        if cache_hit < 0.50:
            return ("warn", f"cache-hit {p}% — warm cache reads ~10x cheaper; avoid 5-min idle gaps", False, f"cache {p}%")
        if cache_hit < 0.70:
            return ("info", f"cache-hit {p}% — keep stable context up top to lift it", False, f"cache {p}%")

    # 3. burn rate + model routing — Opus is ~5x Sonnet, ~15x Haiku per token.
    if burn is not None and burn >= 12 and is_opus:
        return ("info", f"${burn:.0f}/hr on Opus — send grunt work to Haiku, keep Opus for hard reasoning", False, f"${burn:.0f}/hr")

    # 4. running clean — reinforce good behaviour instead of only nagging.
    if p is not None and cache_hit >= 0.85 and pct < 55:
        return ("good", f"cache-hit {p}% · running clean", False, "clean")
    return None

# ─── ticker (line 3 / rotating item) ───────────────────────────────────────────
DISCOVERY_FALLBACK = [
    "Opus 4.8 + Sonnet 5 top the 2026 coding boards",
    "trending: ripgrep-mcp · gbrain · maxx",
    "try: /compact then reprime to lift cache-hit",
    "devs in 40+ countries are maxxing",
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
        items.append(f"{t} · {pts}pts")
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

# ─── today endpoint poll (the live data channel: network → state.json → bar) ────
TODAY_MARK = os.path.expanduser("~/.tokenmaxx/.today-fetch")
def maybe_fetch_today(cfg, ttl=60):
    ep = (cfg.get("endpoint") or "").rstrip("/")
    if not ep: return
    try:
        if time.time() - os.path.getmtime(TODAY_MARK) < ttl: return
    except Exception: pass
    try:
        subprocess.Popen([sys.executable, os.path.abspath(__file__), "--fetch-today"],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         stdin=subprocess.DEVNULL, start_new_session=True)
    except Exception: pass

def fetch_today(cfg):
    ep = (cfg.get("endpoint") or "").rstrip("/")
    if not ep: return
    req = urllib.request.Request(ep + "/today", headers={"User-Agent": "tokenmaxx"})
    with urllib.request.urlopen(req, timeout=6) as r:
        d = json.load(r)
    set_state(widget=sanitize(d.get("widget") or ""), banner=sanitize(d.get("banner") or ""))
    try: open(TODAY_MARK, "w").write(str(time.time()))
    except Exception: pass

def life_items(now, dur_h):
    out = []
    if 1 <= now.hour < 5:                     out.append("it's late — tokens keep till morning")
    if dur_h >= 3:                            out.append("3h deep — go touch grass")
    if now.weekday() == 6:                    out.append("it's Sunday — call your mom")
    if now.weekday() == 4 and now.hour >= 16: out.append("Friday evening — wrap it up")
    return out

def milestone_items(alltime):
    out = []
    if alltime > 0:
        thr = [1e9, 2e9, 5e9, 1e10, 2.5e10, 5e10, 1e11, 2.5e11, 5e11, 1e12]
        crossed = [t for t in thr if alltime >= t]
        if crossed and alltime < crossed[-1] * 1.10:
            out.append(f"just crossed {big(crossed[-1])} tokens")
        out.append(f"{big(alltime)} tokens all-time")
    return out

NYAN = ["≈≈≈(=^.^=)", "≈≈=(=^.^=)", "≈=≈(=^.^=)", "=≈≈(=^.^=)"]
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

# ─── presence: the campfire strip (SIMULATED crowd — swap for a real feed later) ─
# YOLO mode: fabricated live count + activity so we can feel the "you're not alone"
# design. A real presence backend replaces presence()/presence_activity() by reading
# a cached presence.json, same pattern as discovery. Nothing here is real yet.
AV_ROSTER = [("JM", 203), ("MI", 75), ("SM", 140), ("LK", 71), ("AR", 179), ("RE", 168)]
ACTIVITY = [
    "sam unblocked a nasty bug 🎉", "jordan shipped a Discord bot", "mia hit a 30-day streak 🔥",
    "alex cleared 1M tokens today", "priya's cache-hit hit 92%", "a dev in Tokyo just went live",
    "reo refactored the whole pipeline", "lin and sam paired for 3h",
]
def avatar(init, color):
    plain = f" {init} "
    return (plain, f"\x1b[48;5;{color};38;5;231m{plain}\x1b[0m")  # bg color, near-white initials

def presence(now):
    t = int(now.timestamp())
    count = 328 + (t // 11) % 42          # drifts up over time — "many coming in"
    k = 3 + (t // 5) % 3                   # show 3-5 avatars
    return count, AV_ROSTER[:k]

def presence_activity(now):
    t = int(now.timestamp()); n = len(ACTIVITY)
    return [f"↗ {ACTIVITY[(t // 7 + i) % n]}" for i in range(3)]

def campfire_strip(now, cols):
    count, avs = presence(now)
    act = presence_activity(now)[0]
    warm = "38;5;173"
    parts = [("🔥 ", c(warm, "🔥 "))]
    for init, col in avs:
        parts.append(avatar(init, col))
    parts.append((f" you + {count} others live", c(warm, f" you + {count} others live")))
    parts.append((f"  ·  {act}", c("38;5;180", f"  ·  {act}")))
    return join_fit(parts, cols, sep="")

# ─── Maxx the dog (3-line mascot; ASCII-only so it renders in any font) ─────────
DOG_FACES = {
    "idle":  [" /^-^\\ ", "( o o )", " \\_u_/ "],
    "alert": [" /^!^\\ ", "( O O )", " \\_o_/ "],
    "happy": [" /^-^\\ ", "( ^ ^ )", " \\_v_/ "],
}
def dog(mood="idle", name="Maxx", tail=""):
    f = DOG_FACES.get(mood, DOG_FACES["idle"])
    l1 = rgb(BRAND, f[0])
    l2 = rgb(BRAND, f[1]) + "   " + rgb(INK, name) + (("   " + rgb(DIM, tail)) if tail else "")
    l3 = rgb(BRAND, f[2])
    return "\n".join([l1, l2, l3])

# ─── the M — Maxx's brand mark, down the left of the last 2 rows ────────────────
# Style is itself a widget: pick locally (config "mark") or push it from the
# endpoint (state "mark"). All render in any font; make new M's from ascii, block,
# box, whatever — swap freely.
MARKS = {
    "blocky": ["█▄░▄█", "█░▀░█"],   # double_blocky — THE brand mark (block + light shade)
    "box":    ["┃╲╱┃", "┃  ┃"],
    "ascii":  ["|\\/|", "|  |"],
    "block":  ["█▄█", "█ █"],
    "peaks":  ["/\\/\\", " || "],
}
def mark(cfg):
    name = sanitize(read_state().get("mark") or "") or cfg.get("mark") or "blocky"
    return MARKS.get(name, MARKS["blocky"])

def shade_row(row, r, R, style):
    """Color each glyph of an M row by a light-source gradient (the 'shader'), in
    the brand purple family. 'toplit' lights from above; 'sheen' is a TL→BR
    diagonal; 'emboss' brightens the edges. Keeps the painted band (fg reset only)."""
    C = len(row); out = ""
    for c, ch in enumerate(row):
        if ch == " ": out += " "; continue
        if style == "sheen":    t = ((r / max(1, R - 1)) + (c / max(1, C - 1))) / 2
        elif style == "emboss": t = abs(c - (C - 1) / 2) / max(1e-9, (C - 1) / 2)
        else:                   t = r / max(1, R - 1)          # toplit
        col = _hsl(_H, 0.30, 0.74 + 0.05 * (1 - t)) if ch == "░" else _hsl(_H, 0.58, 0.62 - 0.24 * t)
        out += rgb(col, ch)
    return out

def framed_mark(cfg, mk):
    """Wrap the M in a container so it reads as a mark, not loose blocks. Returns
    (line2, line3, plain_width). Frame: 'rails' (default) brand bars hug the M;
    'chip' knockout M on a filled brand tile; 'none' bare. The M glyphs are
    gradient-shaded (mark_shade: toplit/sheen/emboss, or 'flat' for solid brand)."""
    frame = sanitize(read_state().get("mark_frame") or "") or cfg.get("mark_frame") or "rails"
    shade = sanitize(read_state().get("mark_shade") or "") or cfg.get("mark_shade") or "toplit"
    R = len(mk)
    body = [rgb(BRAND, mk[r]) if shade == "flat" else shade_row(mk[r], r, R, shade)
            for r in range(R)]
    if frame == "none":
        return body[0], body[1], disp_width(mk[0])
    if frame == "chip":
        # brand tile + light knockout M (shading n/a); restore band bg so paint() holds
        def chip(r):
            return (f"\x1b[48;2;{BRAND[0]};{BRAND[1]};{BRAND[2]}m"
                    f"\x1b[38;2;{BG[0]};{BG[1]};{BG[2]}m {r} "
                    f"\x1b[48;2;{BG[0]};{BG[1]};{BG[2]}m\x1b[39m")
        return chip(mk[0]), chip(mk[1]), disp_width(f" {mk[0]} ")
    rail = rgb(BRAND, "▐"); railR = rgb(BRAND, "▌")
    return (rail + body[0] + railR, rail + body[1] + railR, disp_width("▐" + mk[0] + "▌"))

# ─── figlet wordmark (vendored pyfiglet; lazy — never loaded on the render path) ─
_FIGLET = None
def figlet(text, font="smshadow"):
    """Render a wordmark via the vendored pyfiglet (self-contained, no pip), or
    None if unavailable. Imported lazily so the every-tick bar never pays for it."""
    global _FIGLET
    if _FIGLET is None:
        _FIGLET = False
        here = os.path.dirname(os.path.abspath(__file__))
        for cand in (os.path.join(here, "vendor"),
                     os.path.expanduser("~/.tokenmaxx/vendor"),
                     os.path.expanduser("~/.claude/skills/maxx/vendor")):
            if os.path.isdir(cand):
                if cand not in sys.path: sys.path.insert(0, cand)
                try:
                    import pyfiglet; _FIGLET = pyfiglet
                except Exception: _FIGLET = False
                break
    if not _FIGLET: return None
    try: return _FIGLET.figlet_format(text, font=font).rstrip("\n")
    except Exception: return None

# ─── assembly ──────────────────────────────────────────────────────────────────
def render(data, alltime, now, offset, cfg, mark_left=True, force_wide=False, runway=None, tight=False, cache_base=None):
    cols = term_width(cfg)
    if cfg.get("test_fill"):
        return "\n".join(fill_lines(cols))

    # cache-hit straight from stdin's context_window (no transcript tail) — keeps
    # the 1s heartbeat cheap enough to run every second.
    cu = (data.get("context_window") or {}).get("current_usage") or {}
    ci = (cu.get("input_tokens", 0) or 0) + (cu.get("cache_creation_input_tokens", 0) or 0) + (cu.get("cache_read_input_tokens", 0) or 0)
    cache_hit = ((cu.get("cache_read_input_tokens", 0) or 0) / ci) if ci else None
    gplain, gcolored, pct = gauge(data)

    cost = data.get("cost") or {}
    usd = cost.get("total_cost_usd")
    dur_h = (cost.get("total_duration_ms") or 0) / 3_600_000
    m = data.get("model") or {}
    model = m.get("display_name") or m.get("id", "?")
    coach = build_coach(pct, cache_hit, usd, dur_h, model, runway)   # efficiency coach: ctx + cache + burn + runway
    ws = data.get("workspace") or {}
    proj_dir = ws.get("project_dir") or ws.get("current_dir") or ""
    proj = os.path.basename(proj_dir)
    # dev-state (cheap): branch from .git/HEAD, dirty count from a cached git status
    root = repo_root(proj_dir)
    gbranch = git_branch(root) if root else None
    gdirty = git_dirty(root) if root else None
    if tight:                                     # health-first single line — the answer, not data
        return tight_line(coach, runway, cache_hit, cache_base, gbranch, gdirty, usd, cols)
    # health dot leads the cockpit — the green glance. Numbers follow, not the other way.
    hdot, hcol, _ = health(coach, runway, cache_hit, cache_base)
    # cockpit parts, priority order (needs first → truncation sheds the rest).
    # One palette: dim labels, ink values, brand = the accent. No emoji.
    parts = [("●", rgb(hcol, "●")), (gplain, gcolored)]
    if coach and coach[2]:  # urgent warning beats cost — active danger rides line 1
        wtxt = coach[3] if cols < 100 else coach[1]
        parts.append((wtxt, rgb(coach_col(coach[0]), wtxt)))
    if usd is not None: parts.append((f"${usd:.2f}", rgb(DIM, "$") + rgb(INK, f"{usd:.2f}")))
    parts.append((model, rgb(DIM, model)))
    if proj: parts.append((proj, rgb(BRAND, proj)))
    if gbranch:  # branch ±dirty — dev-state so the user never asks Claude "what branch"
        dtxt = f" ±{gdirty}" if gdirty else ""
        parts.append((gbranch + dtxt, rgb(DIM, gbranch) + (rgb(WARN, dtxt) if gdirty else "")))
    widget = sanitize(read_state().get("fish") or read_state().get("widget") or "")
    if widget: parts.append((widget, rgb(BRAND, widget)))  # the live widget slot

    # ── tiny: one line ──
    if cols < 60 and not force_wide:
        return join_fit(parts, cols)

    line1 = join_fit(parts, cols)

    presence_on = (cfg.get("presence") or {}).get("enabled", True)

    # ── narrow: two lines, campfire strip is the hero (urgent coach already on line 1) ──
    if cols < 90 and not force_wide:
        if presence_on:
            line2 = campfire_strip(now, cols)
        elif coach and not coach[2]:
            line2 = rgb(coach_col(coach[0]), trunc(coach[1], cols))
        else:
            items = ticker_items(now, dur_h, alltime, cfg)
            line2 = rgb(DIM, trunc(items[offset % len(items)], cols))
        return line1 + "\n" + line2

    # ── expanded: five content rows; the M is drawn full-height on the right ──
    # Surgical/hybrid: r1 cockpit+branch · r2 coach · r3 dev+token state · r4 the one
    # flair slot · r5 tip. Every fixed row saves the user a turn (dev-state or coach).
    if not mark_left:
        w = cols
        r2 = (rgb(coach_col(coach[0]), trunc(coach[1], w)) if (coach and not coach[2])
              else rgb(DIM, trunc("cleaner runs, not bigger burns", w)))
        # r3: path · token state — the "don't ask Claude" row (branch±dirty is on r1)
        bits = []
        sp = path_in_repo(ws.get("current_dir") or proj_dir, root, proj)
        if sp: bits.append(sp)
        p = f"{round(cache_hit * 100)}%" if cache_hit is not None else "—"
        bits.append(f"cache {p}")
        bits.append(f"{big(alltime)} all-time")
        r3 = rgb(DIM, trunc(" · ".join(bits), w))
        # r4: the single flair slot (rotating discovery / presence)
        di = ticker_items(now, dur_h, alltime, cfg)
        if presence_on: di = presence_activity(now) + di
        r4 = rgb(DIM, marquee(di, max(10, w), offset))
        # r5: rotating optimization tip
        r5 = rgb(DIM, trunc(TIPS[(int(now.timestamp()) // 20) % len(TIPS)], w))
        return "\n".join([line1, r2, r3, r4, r5])

    # ── wide: cockpit up top, the M brand mark down the left of the last 2 rows ──
    mk = mark(cfg)
    mL2, mL3, mkw_plain = framed_mark(cfg, mk)
    mkw = mkw_plain + 1                        # framed mark width + one space
    body_w = max(10, cols - mkw)
    coach_on_2 = False
    if presence_on:
        body2 = campfire_strip(now, body_w)
    elif coach and not coach[2]:
        body2 = rgb(coach_col(coach[0]), trunc(coach[1], body_w)); coach_on_2 = True
    else:
        body2 = rgb(DIM, trunc(TIPS[(int(now.timestamp()) // 20) % len(TIPS)], body_w))
    line2 = mL2 + " " + body2
    items = ticker_items(now, dur_h, alltime, cfg)
    if presence_on:
        items = presence_activity(now) + items          # mix live activity into the realm
    if coach and not coach[2] and not coach_on_2:
        items = [coach[1]] + items                       # nudge in the ticker only if not on row 2
    win = marquee(items, max(10, body_w), offset)
    line3 = mL3 + " " + rgb(DIM, win)
    return "\n".join([line1, line2, line3])

def main():
    try: data = json.load(sys.stdin)
    except Exception: print(""); return
    cfg = load_tm_config()
    alltime, ts = load_cache(); maybe_refresh(ts)
    maybe_fetch_discovery(cfg)
    maybe_fetch_today(cfg)
    now = datetime.datetime.now()
    try: step = int(cfg.get("ticker", {}).get("speed", 1))  # columns per render (1 = smoothest)
    except Exception: step = 1
    offset = next_offset(step)
    # sample ctx% + cache (real path only — demo never calls main) → runway + baseline
    cw = data.get("context_window") or {}
    pct_now = cw.get("used_percentage")
    runway = ctx_runway(sample_ctx(pct_now, data.get("transcript_path"))) if pct_now is not None else None
    cu = cw.get("current_usage") or {}
    ci = (cu.get("input_tokens", 0) or 0) + (cu.get("cache_creation_input_tokens", 0) or 0) + (cu.get("cache_read_input_tokens", 0) or 0)
    ch = ((cu.get("cache_read_input_tokens", 0) or 0) / ci) if ci else None
    update_baseline(ch)                                          # the companion learns your normal
    cbase = cache_baseline()
    mode, cols = layout(cfg)
    if mode == "tight":                                          # one health-first line
        out = render(data, alltime, now, offset, cfg, tight=True, runway=runway, cache_base=cbase)
        print(paint(out, cols))
    elif mode == "expanded":                                     # 5-line panel, M full-height right
        out = render(data, alltime, now, offset, cfg, mark_left=False, force_wide=True, runway=runway, cache_base=cbase)
        print("\n".join(boxed_M(out.split("\n"), cols, tick=offset)))   # offset drives the shine sweep
    elif mode == "box":                                          # compact framed panel
        out = render(data, alltime, now, offset, cfg, runway=runway, cache_base=cbase)
        bevel = read_state().get("box_bevel")
        if bevel is None: bevel = cfg.get("box_bevel", True)
        print("\n".join(boxed(out.split("\n"), cols, bool(bevel))))
    else:                                                        # bare painted band
        out = render(data, alltime, now, offset, cfg, runway=runway, cache_base=cbase)
        print("\n".join(paint(l, cols) for l in out.split("\n")))

# ─── the reveal — spinning isometric M splash (one-shot: /maxx + session start) ──
# Four figlet angles (isometric1..4) cycled = the M tumbling in 3D. One-shot only —
# NEVER on the render path (11 rows won't fit the bar; the live M stays static).
_SPIN_FONTS = ("isometric1", "isometric2", "isometric3", "isometric4")

def spin_frames():
    """The M's four rotation angles, normalized to one (H, W) box. None if the
    vendored figlet is unavailable — caller falls back to the static block mark."""
    arts = []
    for f in _SPIN_FONTS:
        a = figlet("M", f)
        if not a: return None
        rows = a.split("\n")
        while rows and not rows[0].strip():  rows.pop(0)
        while rows and not rows[-1].strip(): rows.pop()
        arts.append(rows)
    H = max(len(a) for a in arts)
    W = max((max((len(r) for r in a), default=0) for a in arts), default=0)
    return [[r.ljust(W) for r in (a + [""] * (H - len(a)))] for a in arts], H, W

def reveal(cfg, spins=2, fps=6):
    """Print the spinning-M splash: tumble the isometric M in brand purple, settle,
    then M A X X + all-time tokens. Animates on a TTY; prints a still when piped."""
    def emit(rows):  # each row full-width + clear-to-eol so shorter frames don't ghost
        return "".join(rgb(BRAND, r) + "\x1b[K\n" for r in rows)
    fr = spin_frames()
    alltime, _ = load_cache()
    if not fr:                                   # no figlet → static block mark
        sys.stdout.write(emit(MARKS["blocky"])); print(); return
    frames, H, W = fr
    word = "  ".join("MAXX")
    tag  = f"{big(alltime)} tokens" if alltime else "your Claude Code cockpit"
    pad  = " " * max(0, (W - disp_width(word)) // 2)
    if not sys.stdout.isatty():                  # piped → still frame + wordmark
        sys.stdout.write(emit(frames[0]))
        print(pad + rgb(BRAND, word)); print(pad + rgb(DIM, tag)); return
    seq = frames * max(1, spins)
    delay = 1.0 / max(1, fps)
    sys.stdout.write("\x1b[?25l")                # hide cursor
    try:
        for i, rows in enumerate(seq):
            if i: sys.stdout.write(f"\x1b[{H}F")  # cursor up to top of the box
            sys.stdout.write(emit(rows)); sys.stdout.flush()
            time.sleep(delay)
        sys.stdout.write(f"\x1b[{H}F" + emit(frames[0]))   # settle on angle 1
    except KeyboardInterrupt:
        pass
    finally:
        sys.stdout.write("\x1b[?25h"); sys.stdout.flush()  # show cursor
    print(pad + rgb(BRAND, word)); print(pad + rgb(DIM, tag))

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
    elif "--git-scan" in sys.argv:
        i = sys.argv.index("--git-scan")
        if i + 1 < len(sys.argv): do_git_scan(sys.argv[i + 1])
    elif "--fetch-discovery" in sys.argv:
        try: fetch_discovery(load_tm_config())
        except Exception as e: sys.stderr.write(f"tokenmaxx discovery: {e}\n")
    elif "--fetch-today" in sys.argv:
        try: fetch_today(load_tm_config())
        except Exception as e: sys.stderr.write(f"tokenmaxx today: {e}\n")
    elif "--fill" in sys.argv:
        nums = [int(a) for a in sys.argv if a.isdigit()]
        if nums: os.environ["COLUMNS"] = str(nums[0])
        print("\n".join(fill_lines(term_width(load_tm_config()))))
    elif "--dog" in sys.argv:
        mood = "idle"
        for m in ("idle", "alert", "happy"):
            if m in sys.argv: mood = m
        print(dog(mood, tail="woof"))
    elif "--reveal" in sys.argv:
        nums = [int(a) for a in sys.argv if a.isdigit()]
        spins = nums[0] if len(nums) >= 1 else 2
        fps   = nums[1] if len(nums) >= 2 else 6
        reveal(load_tm_config(), spins=spins, fps=fps)
    elif "--banner" in sys.argv:
        i = sys.argv.index("--banner"); rest = sys.argv[i + 1:]
        font = rest[0] if rest else "smshadow"
        text = " ".join(rest[1:]) if len(rest) > 1 else "MAXX"
        out = figlet(text, font)
        print(out if out is not None else f"(figlet unavailable / font '{font}' not vendored)")
    elif "fish" in sys.argv:
        f = random.choice(FISH)
        set_state(fish=f)
        print(f"today's fish: {f}  (now live in your statusline)")
    elif "widget" in sys.argv:
        # `widget "text"` — set an arbitrary live widget (proves the endpoint path)
        i = sys.argv.index("widget")
        set_state(widget=sanitize(sys.argv[i + 1]) if i + 1 < len(sys.argv) else "")
        print("widget set (live next tick)")
    elif "clear" in sys.argv:
        set_state(fish="", widget=""); print("widgets cleared")
    elif "--demo" in sys.argv:
        nums = [int(a) for a in sys.argv if a.isdigit()]
        n = nums[0] if len(nums) >= 1 else 12
        w = nums[1] if len(nums) >= 2 else None
        demo(n, w)
    else:
        main()
