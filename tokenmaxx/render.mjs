#!/usr/bin/env node
/**
 * maxx statusline renderer — the LOOK, in Node (no binary, no build step).
 *
 * Reads Claude Code's stdin JSON (rate_limits.five_hour/seven_day = the real
 * session/weekly walls, same numbers as /usage) + ~/.tokenmaxx/state.json the brain
 * writes (advice / intent / presence), then paints a clean two-pane cockpit:
 * quota + model on the left, a coach thought on the right, presence at the edges.
 *
 * Ships as plain Node because the rest of maxx already needs Node (the /maxx skill
 * and the coach hook) — nothing extra to install, nothing to compile. A tiny ANSI
 * compositor stands in for lipgloss.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// ─── color: one HSL→hex + an rgb→hsl round-trip for shading ────────────────────
function hsl2hex(h, s, l) {
  h = (((h % 360) + 360) % 360) / 360;
  let r, g, b;
  if (s === 0) { r = g = b = l; }
  else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const k = (t) => { if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p; };
    r = k(h + 1 / 3); g = k(h); b = k(h - 1 / 3);
  }
  const to = (x) => Math.round(x * 255).toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}
const hsl = hsl2hex;
const BG     = hsl(265, 0.62, 0.91); // baby purple panel — light mode
const INK    = hsl(266, 0.46, 0.26); // deep purple primary text
const DIM    = hsl(266, 0.24, 0.52); // muted secondary text
const BRAND  = hsl(264, 0.66, 0.54); // vivid periwinkle accent
const BORDER = hsl(266, 0.36, 0.66); // meter caps / soft frame
const TRACK  = hsl(266, 0.42, 0.82); // the meter's unlit groove — a shade below the panel bg
const GREEN  = hsl(150, 0.48, 0.37); // deep sage = safe (dark spent fill; the glint + dusty cushion read off it)
const AMBER  = hsl(38, 0.66, 0.53);  // soft amber = elevated
const RED    = hsl(354, 0.50, 0.58); // soft rose = danger
const START  = hsl(266, 0.40, 0.44); // the start post (0)
const WALL   = hsl(352, 0.62, 0.30); // the finish post = the limit (deep, darker than the overshoot)

// ─── ANSI: every glyph carries the panel bg so the band stays unbroken ─────────
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
// blend hex toward a target (default white) by t∈[0,1] — used to shade the meter fill so it
// reads as a rounded tube (lit through the middle) instead of a flat slab.
function mix(hex, t, target = "#ffffff") {
  const a = rgb(hex), b = rgb(target);
  return "#" + [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t).toString(16).padStart(2, "0")).join("");
}
function esc(fgHex, bgHex, s) {
  const [fr, fgg, fb] = rgb(fgHex), [br, bgg, bb] = rgb(bgHex);
  return `\x1b[38;2;${fr};${fgg};${fb};48;2;${br};${bgg};${bb}m${s}\x1b[0m`;
}
const fg = (c, s) => esc(c, BG, s);
// italic variant (adds SGR 3) — for the calm coach line; degrades gracefully if unsupported
function ital(fgHex, s) {
  const [fr, fgg, fb] = rgb(fgHex), [br, bgg, bb] = rgb(BG);
  return `\x1b[3;38;2;${fr};${fgg};${fb};48;2;${br};${bgg};${bb}m${s}\x1b[0m`;
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const dispWidth = (s) => [...stripAnsi(s)].length;
function trunc(s, w) {
  const r = [...s];
  if (r.length <= w) return s;
  if (w < 1) return "…";
  return r.slice(0, w - 1).join("") + "…";
}
const blank = (w) => fg(BG, " ".repeat(Math.max(0, w)));
function padLine(s, w, align = "left") {
  const extra = w - dispWidth(s);
  if (extra <= 0) return s;
  if (align === "right") return blank(extra) + s;
  if (align === "center") { const l = Math.floor(extra / 2); return blank(l) + s + blank(extra - l); }
  return s + blank(extra);
}

function resetIn(ts) {
  if (!ts || ts <= 0) return "";
  const d = ts - Date.now() / 1000;
  if (d <= 0) return "now";
  if (d >= 86400) return `${Math.floor(d / 86400)}d`;
  const h = Math.floor(d / 3600);
  if (h > 0) return `${h}h${Math.floor((d % 3600) / 60)}m`;
  return `${Math.floor(d / 60)}m`;
}

// pace: is a wall headed for a lockout, and how bad? You're ahead exactly when %used runs
// past %elapsed (fixed window: resets_at = block start + winSec). This just judges hot +
// severity + how long a catch-up break would be; the actual human MOVE (switch model, close
// spare sessions, warm the cache, take that break) is chosen by the renderer, which can see
// what you're actually doing. 2pt margin so it doesn't flap near even.
function paceOf(rl, winSec, usedFrac) {
  if (!rl || !rl.resets_at) return { ok: false, hot: false };
  const remain = rl.resets_at - Date.now() / 1000;
  const used = usedFrac * 100;
  const elapsed = (100 * (winSec - remain)) / winSec;
  if (elapsed < 1 || used < 2 || remain <= 0) return { ok: true, hot: false }; // too early / idle
  if (used <= elapsed + 2) return { ok: true, hot: false };                    // on pace / banking
  const col = used >= 90 || used >= 2 * elapsed ? RED : AMBER;
  const breakMin = Math.round(((used - elapsed) / 100) * winSec / 60);         // pause this long → clock catches up
  return { ok: true, hot: true, col, breakMin };
}

// fine token count for the live deltas (cushion/over, momentum): always in thousands with comma
// grouping, so you watch usage tick by the thousand at every scale — 56k, 112k, 4,112k, 129,148k.
function tkf(n) {
  return Math.round(Math.abs(n) / 1000).toLocaleString("en-US") + "k";
}
// full token count, comma-grouped — ticks by the single token: 77,732,145
function tkfull(n) {
  return Math.round(Math.abs(n)).toLocaleString("en-US");
}

// `/maxx session` brief — reads the snapshot the statusline writes and answers the one question:
// how much can I spend this session? First line is machine-ingestible (KEY=value); the rest is human.
function sessionBrief(st) {
  if (!st || !st.session) return "maxx — no usage data yet. Open Claude Code so the statusline can write ~/.tokenmaxx/status.json, then retry.";
  const s = st.session, w = st.weekly || {};
  const spend = Math.round((s.cap || 0) - (s.used || 0)); // realMax − used: safe to spend now
  const minLeft = s.minLeft || 0;                          // minutes until THIS session resets
  const perMin = spend > 0 && minLeft > 0 ? Math.round(spend / minLeft) : 0; // even pace for the rest
  const sess = st.sessionsLeftInWeek;
  const out = [];
  out.push(`SPEND_THIS_SESSION=${Math.max(0, spend)} SPEND_PER_MIN=${perMin} OVER=${spend < 0 ? -spend : 0} SESSION_RESETS_IN=${s.resetIn || "?"} WEEKLY_LEFT=${w.headroom || 0} WEEKLY_RESETS_IN=${w.resetIn || "?"} SESSIONS_LEFT_WEEK=${sess ?? "?"}`);
  out.push("");
  out.push("maxx — how much to spend this session");
  out.push("");
  if (spend >= 0) {
    out.push(`  spend up to   ${tkfull(spend)} tokens   before this session resets in ${s.resetIn || "?"}`);
    out.push(`  even pace     ~${perMin.toLocaleString("en-US")} tokens/min   to spread it across the time left`);
  } else {
    out.push(`  ease off  —   ${tkfull(-spend)} tokens OVER your sustainable share   (session resets in ${s.resetIn || "?"})`);
  }
  out.push(`  weekly left   ${tkfull(w.headroom || 0)} tokens   ·   resets in ${w.resetIn || "?"}`);
  out.push(`  ~${sess ?? "?"} five-hour sessions left in the week`);
  out.push("");
  out.push("  This is your weekly budget sliced evenly across the sessions left in the week.");
  out.push("  Maxing Anthropic's raw 5h cap instead would burn the week out days early — so pace");
  out.push("  to this number. Idle a while (or reset the session) and it climbs back up.");
  return out.join("\n");
}

// zone = a function of time left: project your burn to reset (used ÷ elapsed). Under the pace
// line → safe, on it → elevated, headed past the wall → danger. Colors the meter + the number.
function zoneCol(u, e) {
  const proj = u / Math.max(e, 0.02); // projected fullness at reset if you hold this pace
  return u >= 0.9 || proj >= 1.25 ? RED : proj >= 0.9 ? AMBER : GREEN;
}
const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"]; // sub-cell fill: 0..8 eighths
// budget timeline as a race — no marker glyph, the PACE LINE is where the colour changes:
//   [ forest green: what you've spent ] then either
//   · behind pace → [ pale-green cushion band up to the line ][ lavender runway ]   (you're ahead)
//   · past pace   → [ red overshoot band past the line ][ lavender runway ]         (you're over)
// so the cushion / overshoot is a band whose length you read at a glance. Your leading edge is
// drawn to 1/8-cell precision so it still creeps as tokens change.
// maximize=true (the session bar): the goal is to USE the whole window, so being ahead of even-burn
// is good — all spent cells stay green (never the red "overshoot"). The below-pace band stays the
// calm light-green cushion (the "behind" nudge lives in the text + meta line, not an alarm colour).
// maximize=false (weekly): the old pace model — green up to pace, red past it, cushion below.
function meter(u, e, w, seed = 0, maximize = false) {
  u = Math.max(0, Math.min(1, u)); e = Math.max(0, Math.min(1, e));
  const you = u * w, youN = Math.floor(you), part = you - youN; // your position
  const paceN = Math.min(w, Math.max(0, Math.round(e * w)));    // the pace line (cell boundary)
  const hot = zoneCol(u, e);
  const CUSH = hsl(150, 0.22, 0.62); // dusty-sage buffer: clearly lighter than the spent green so the
  // pace line (spent→cushion boundary) reads at a glance, but low saturation + mid lightness so it
  // doesn't glow or vibrate against the purple panel the way a bright mint did.
  // "you are here" pulse: a soft highlight breathing at the leading (spent) edge — it just marks
  // where your usage sits, no busy streaks. Wall-clock phase, so it breathes while you're active
  // and holds still when idle. HEAD = glow half-width in cells; TIP = the pale highlight color.
  const TIP = hsl(150, 0.42, 0.80);           // pale sage highlight = the travelling glint
  const HEAD = 3.2;                           // glow half-width (cells) — wide + soft, so it's pronounced
  const now = Date.now();
  const tubeAt = (i) => 0.10 * Math.max(0, 1 - Math.abs((youN > 1 ? i / (youN - 1) : 0) - 0.45) * 2); // rounded-tube shading
  // a single slow glint gliding across the SPENT region. The full pass is scaled to the region's
  // length so it moves at a steady, calm speed (roughly one cell every few seconds), clamped to a
  // 7–24s pass. The two bars run offset phases (seed 0 = session, 1 = week) so they never sweep in
  // lockstep. As usage grows the spent region lengthens, so the sweep covers more of the line and
  // the whole bar reads as alive. Wall-clock driven → it keeps drifting even while you idle.
  // sweep only the healthy up-to-pace region: when you're OVER (youN past the pace line), the glint
  // stops at pace instead of gliding into the red overshoot — it shouldn't celebrate the overspend.
  // maximize: sweep the whole spent region (all spending is progress); weekly: stop the glint at pace.
  const span = Math.max(1, maximize ? youN : Math.min(youN, paceN));
  const SWEEP_MS = Math.min(24000, Math.max(7000, span * 900));
  const t01 = (((now / SWEEP_MS) + seed * 0.41) % 1 + 1) % 1;   // 0..1 phase, offset per bar
  const center = -HEAD + t01 * (span + 2 * HEAD);               // glides from before 0 to past the edge
  const glowAt = (c, i) => { const g = 0.85 * Math.max(0, 1 - Math.abs(i - center) / HEAD); return g > 0.001 ? mix(c, Math.min(0.85, g), TIP) : c; };
  const below = CUSH;                                 // light-green cushion below the pace line (both bars)
  const spentC = (i) => maximize ? GREEN : (i < paceN ? GREEN : hot); // maximize: spent is always green
  let s = fg(START, "▐"); // start post (0)
  for (let i = 0; i < w; i++) {
    if (i < youN) s += fg(glowAt(mix(spentC(i), tubeAt(i)), i), "█");               // spent: tube-shaded + breathing edge glow
    else if (i === youN && part > 0.04)                                            // your leading edge (sub-cell)
      s += esc(glowAt(spentC(i), i), i < paceN ? below : TRACK, EIGHTHS[Math.max(1, Math.round(part * 8))]);
    else if (i < paceN) s += fg(below, "█");                                       // below pace: cushion (weekly) / shortfall (session)
    else s += fg(TRACK, "█");                                                      // runway beyond the pace line
  }
  return s + fg(WALL, "▌"); // finish post = the limit (the wall you don't want to reach)
}

// ─── sidecar state ─────────────────────────────────────────────────────────────
const HOME = homedir();
const readJSON = (p, d = {}) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return d; } };
const statePath = path.join(HOME, ".tokenmaxx", "state.json");
const sprintPath = path.join(HOME, ".tokenmaxx", "sprint.json");
const sessionsCache = path.join(HOME, ".tokenmaxx", ".sessions");

// sprint timing lives in its OWN file so this 1s renderer and the per-turn brain
// never write the same JSON (state.json is brain-owned; we only read it).
function sprintTimer(sp) {
  const now = Date.now() / 1000;
  let start = sp.sess_start || 0;
  const last = sp.sess_last || 0;
  if (start === 0 || now - last > 300 || now - start >= 1800) start = now;
  sp.sess_start = start; sp.sess_last = now;
  return { left: Math.max(1, Math.round(30 - (now - start) / 60)), start };
}

// YOUR concurrent sessions: transcripts across ~/.claude/projects touched in the last
// 5 min. Throttled (~20s cache) so we don't walk the whole history every render tick.
function localSessions() {
  try { const c = JSON.parse(readFileSync(sessionsCache, "utf8")); if (Date.now() - c.at < 20000) return c.n; } catch {}
  const cutoff = Date.now() - 5 * 60 * 1000;
  let n = 0;
  const walk = (d) => { let es; try { es = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) { const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith(".jsonl")) { try { if (statSync(f).mtimeMs > cutoff) n++; } catch {} } } };
  walk(path.join(HOME, ".claude", "projects"));
  try { writeFileSync(sessionsCache, JSON.stringify({ at: Date.now(), n })); } catch {}
  return n;
}

function tryRead(p) { try { return readFileSync(p, "utf8").trim(); } catch { return null; } }
function gitBranch(dir) {
  for (let d = dir; d && d !== "/"; d = path.dirname(d)) {
    const head = tryRead(path.join(d, ".git", "HEAD"));
    if (head == null) continue;
    if (head.startsWith("ref: refs/heads/")) return head.slice("ref: refs/heads/".length);
    return head.length >= 7 ? head.slice(0, 7) : "";
  }
  return "";
}

function modelFamily(name = "") {
  const l = name.toLowerCase();
  if (l.includes("opus")) return "Opus";
  if (l.includes("haiku")) return "Haiku";
  if (l.includes("sonnet")) return "Sonnet";
  return [...name].slice(0, 8).join("");
}

// coachLine: product/build guidance. brain advice (fresh) > intention > new-sprint > ctx > ship.
function coachLine(st, ctxPct, sprintStart) {
  const adv = st.advice, advTs = st.advice_ts || 0;
  if (adv && Date.now() - advTs < 300_000) return [adv, AMBER]; // advice_ts is ms
  const intent = st.intent, intentStart = st.intent_start || 0;
  if (intent && Math.abs(intentStart - sprintStart) < 1) return ["→ " + intent, BRAND];
  const now = Date.now() / 1000;
  if (now - sprintStart > 0 && now - sprintStart < 180 && !intent) return ["new sprint — what are you shipping?", AMBER];
  if (ctxPct >= 75) return ["context heavy — commit at a clean stop, then /compact", AMBER];
  return ["running clean — ship the smallest thing that works", GREEN];
}

// ─── compositor: panes are arrays of width-w rows; join them side by side ──────
function pane(lines, w, h, valign = "top", halign = "left") {
  let rows = lines.map((l) => padLine(l, w, halign));
  if (rows.length > h) rows = rows.slice(0, h);
  const miss = h - rows.length;
  if (miss > 0) {
    if (valign === "center") { const t = Math.floor(miss / 2); rows = [...Array(t).fill(blank(w)), ...rows, ...Array(miss - t).fill(blank(w))]; }
    else rows = [...rows, ...Array(miss).fill(blank(w))];
  }
  return rows;
}
function joinH(...panes) {
  const h = Math.max(...panes.map((p) => p.length));
  return Array.from({ length: h }, (_, r) => panes.map((p) => p[r] ?? "").join(""));
}
function wrap(text, w) {
  const out = []; let cur = "";
  for (const word of text.split(/\s+/)) {
    if (!cur) cur = word;
    else if (dispWidth(cur) + 1 + dispWidth(word) <= w) cur += " " + word;
    else { out.push(cur); cur = word; }
  }
  if (cur) out.push(cur);
  return out.flatMap((l) => { const r = []; let s = l; while (dispWidth(s) > w) { r.push([...s].slice(0, w).join("")); s = [...s].slice(w).join(""); } r.push(s); return r; });
}

function main() {
  const wantStatus = process.argv.includes("--status");
  const wantSession = process.argv.includes("--session"); // `/maxx session` — how much to spend now
  let p = {}, rawIn = "";
  // don't block on an interactive TTY: `node render.mjs --status` from a shell has no piped JSON,
  // so reading fd 0 would hang forever. Only slurp stdin when it's actually a pipe.
  if (!process.stdin.isTTY) { try { rawIn = readFileSync(0, "utf8"); p = JSON.parse(rawIn); } catch {} }
  // `--status`/`--session` with no stdin (a user or agent calling us directly) → read the last
  // snapshot the live statusline wrote. Nothing fresh to compute without Claude Code's JSON.
  if ((wantStatus || wantSession) && !rawIn.trim()) {
    const st = readJSON(path.join(HOME, ".tokenmaxx", "status.json"), null);
    if (wantSession) { process.stdout.write(sessionBrief(st) + "\n"); return; }
    process.stdout.write((st ? JSON.stringify(st, null, 2) : "{}") + "\n");
    return;
  }
  const cols = parseInt(process.env.COLUMNS || "130", 10) || 130;

  const st = readJSON(statePath);
  // coach is per-session: read this session's slot (never another session's). If we can't tell
  // which session we are, fall back to the legacy global slot. Presence stays global (from st).
  const sid = p.session_id || null;
  const coachSt = sid ? ((st.sessions && st.sessions[sid]) || {}) : st;
  const cw_ = p.context_window || {};
  const ctxPct = cw_.used_percentage || 0;
  const cu = cw_.current_usage || {};
  const total = (cu.input_tokens || 0) + (cu.cache_read_input_tokens || 0) + (cu.cache_creation_input_tokens || 0);
  const cache = total > 0 ? (cu.cache_read_input_tokens || 0) / total : 0;

  const rl = p.rate_limits || {};
  const haveQuota = !!rl.five_hour, haveWeek = !!rl.seven_day;
  const quota = haveQuota ? (rl.five_hour.used_percentage || 0) / 100 : 0;
  const week = haveWeek ? (rl.seven_day.used_percentage || 0) / 100 : 0;

  // hand the authoritative %s to limit.mjs (the brain reruns it) so it can anchor token caps.
  // stash seven_day.resets_at too: limit.mjs (no stdin of its own) needs it to cut the weekly
  // sum at the real window start instead of a blind rolling 7d — see weekLo below.
  try { if (haveQuota) writeFileSync(path.join(HOME, ".tokenmaxx", "rl.json"), JSON.stringify({ quota, week, fiveResetAt: rl.five_hour.resets_at || 0, weekResetAt: haveWeek ? rl.seven_day.resets_at : 0, ts: Date.now() })); } catch {}
  // session-reset flag: the 5h wall's resets_at jumps forward when a fresh block starts. Track
  // the last one; when it leaps (>5min later), the window just cleared — flag it for ~5 min.
  const marksPath = path.join(HOME, ".tokenmaxx", "marks.json");
  const marks = readJSON(marksPath, {});
  let freshReset = false;
  if (haveQuota) {
    const cur = rl.five_hour.resets_at, nowS = Date.now() / 1000;
    let at = marks.sessResetAt || 0;
    if (marks.sessReset && cur > marks.sessReset + 300) at = nowS; // block leapt → just reset
    freshReset = at > 0 && nowS - at < 300;
    try { writeFileSync(marksPath, JSON.stringify({ sessReset: cur, sessResetAt: at })); } catch {}
  }
  // tokens burned in each window, re-summed against the live clock so idle time visibly
  // recovers (old 5-min buckets fall out the back). cap anchored → tok/cap == the real %.
  const win = readJSON(path.join(HOME, ".tokenmaxx", "window.json"), null);
  let tok5 = null, cap5 = null, tok7 = null, cap7 = null, burn5 = null;
  if (win && Array.isArray(win.buckets) && win.buckets.length) {
    const now = Date.now();
    const sum = (ms) => { const c = now - ms; let s = 0; for (const b of win.buckets) if (b[0] > c) s += b[1]; return s; };
    const sumFrom = (lo) => { let s = 0; for (const b of win.buckets) if (b[0] > lo) s += b[1]; return s; };
    // session: sum from the real window start (resets_at − 5h), same as weekly below — NOT a blind
    // rolling 5h. So the instant the wall resets (resets_at leaps +5h), pre-reset burn stops counting
    // and the bar drops to ~0 immediately, instead of decaying stale over the next 5 hours.
    const FIVE = 5 * 3600 * 1000;
    const fiveLo = Math.max(now - FIVE, haveQuota ? rl.five_hour.resets_at * 1000 - FIVE : 0);
    tok5 = sumFrom(fiveLo); cap5 = win.cap5;
    // weekly: sum from Anthropic's actual window start (resets_at − 7d), not a blind now − 7d, so a
    // pre-reset burst stops counting the instant the wall zeroed. max() = never loosen past the
    // rolling window, so a stale/absent resets_at falls back to old behavior (never counts more).
    const WK = 7 * 24 * 3600 * 1000;
    const weekLo = Math.max(now - WK, haveWeek ? rl.seven_day.resets_at * 1000 - WK : 0);
    tok7 = sumFrom(weekLo); cap7 = win.cap7;
    // gross tokens burned in the last 5 min (always ≥ 0). This is the live "are you actually using
    // the session" signal — coloured against the maximize pace, and shown as "idle" when it's ~0.
    burn5 = sum(5 * 60 * 1000);
  }

  const usd = (p.cost || {}).total_cost_usd || 0;
  const fam = modelFamily((p.model || {}).display_name);
  const branch = gitBranch((p.workspace || {}).project_dir || "");

  const sp = readJSON(sprintPath);
  const { left, start: sprintStart } = sprintTimer(sp);
  try { writeFileSync(sprintPath, JSON.stringify(sp)); } catch {}

  const mine = localSessions();          // your concurrent sessions (local — mtimes only)

  const col = (v) => (v >= 0.9 ? RED : v >= 0.75 ? AMBER : GREEN);
  // STABLE token cap per window. We anchor the cap to the wall (tok ÷ wall%) — that's the honest
  // magnitude — but re-anchor ONLY when the wall % actually ticks, holding it steady in between.
  // If we recomputed tok÷quota every render, a flat quota with rising tok would inflate the cap as
  // you burn, so "tokens left" would go UP while spending — backwards. Cached in caps.json so the
  // held value survives across renders (and across a reset, since the cap itself doesn't change).
  const capsPath = path.join(HOME, ".tokenmaxx", "caps.json");
  const caps = readJSON(capsPath, {});
  const anchorCap = (have, pct, tok, prevPct, prevCap, brainCap) => {
    if (have && pct > 0.02 && tok != null) {
      if (prevCap && prevPct != null && Math.abs(prevPct - pct) < 0.005) return prevCap; // wall % steady → hold
      return Math.round(tok / pct);                                                       // first anchor / wall ticked
    }
    return prevCap || brainCap || 0; // below the 2% floor (or no stdin) → keep the last good cap
  };
  const cap5s = anchorCap(haveQuota, quota, tok5, caps.q5, caps.cap5, cap5);
  const cap7s = anchorCap(haveWeek, week, tok7, caps.q7, caps.cap7, cap7);
  try { writeFileSync(capsPath, JSON.stringify({ q5: haveQuota ? quota : caps.q5, cap5: cap5s, q7: haveWeek ? week : caps.q7, cap7: cap7s })); } catch {}
  // used = the FINE bucket sum (moves by the token, so cushion/left tick live); fall back to wall%×cap.
  const used5 = tok5 != null ? tok5 : Math.round((haveQuota ? quota : 0) * cap5s);
  const used7 = tok7 != null ? tok7 : Math.round((haveWeek ? week : 0) * cap7s);
  // THE REAL SESSION budget. Anthropic's 5h cap, if maxed every window, would drain the week fast —
  // so the sustainable per-session budget is the weekly REMAINING sliced across the 5h sessions still
  // left in the week: realMax = (cap7 − used7) / (weekTimeLeft ÷ 5h). Pace the session against THAT.
  // Bounded by the hard 5h wall (can't spend past it), and falls back to the raw 5h cap without week
  // data. As the week runs down, sessionsLeft shrinks → realMax grows if you banked, shrinks if you
  // overspent — a self-correcting sustainable pace.
  const nowS0 = Date.now() / 1000;
  const weekLeftSec = haveWeek ? Math.max(0, rl.seven_day.resets_at - nowS0) : 0;
  const sessionsLeft = Math.max(1, weekLeftSec / (5 * 3600));
  const realMax = haveWeek && cap7s
    ? Math.min(cap5s || Infinity, Math.round(Math.max(0, cap7s - used7) / sessionsLeft))
    : cap5s;
  // session bar is now the REAL session: used against realMax, not the raw 5h wall.
  const q5 = realMax ? Math.min(1, used5 / realMax) : (haveQuota ? quota : 0);
  const w7 = cap7s ? Math.min(1, used7 / cap7s) : (haveWeek ? week : 0);
  const qcol = col(q5), wcol = col(w7);
  // how far into each window you are (the pace line): elapsed = 1 - timeLeft/window.
  const nowS = Date.now() / 1000;
  const e5 = haveQuota ? Math.max(0, Math.min(1, 1 - (rl.five_hour.resets_at - nowS) / (5 * 3600))) : 0;
  const e7 = haveWeek ? Math.max(0, Math.min(1, 1 - (rl.seven_day.resets_at - nowS) / (7 * 24 * 3600))) : 0;
  // cache reuse as a plain %, colored by the same heat thresholds (low reuse = burning
  // fresh tokens). A number, not a mood word, so it can't read as "all's well" next to
  // an off-pace line.
  const cacheV = `${Math.round(cache * 100)}%`;
  let cacheCol = GREEN;
  if (cache < 0.6) cacheCol = RED; else if (cache < 0.85) cacheCol = AMBER;
  let hcol = GREEN;
  if (q5 >= 0.9 || w7 >= 0.9) hcol = RED;
  else if (q5 >= 0.75 || w7 >= 0.75 || cache < 0.6) hcol = AMBER;

  const qv = haveQuota ? `${Math.min(99, Math.floor(q5 * 100))}%` : "—";
  const wv = haveWeek ? `${Math.min(99, Math.floor(w7 * 100))}%` : "—";
  const qr = resetIn(haveQuota ? rl.five_hour.resets_at : 0);
  const wr = resetIn(haveWeek ? rl.seven_day.resets_at : 0);

  // pace per wall: session (5h) and weekly (7d) — will either hit its cap before it resets?
  const p5 = haveQuota ? paceOf(rl.five_hour, 5 * 3600, quota) : { ok: false, hot: false };
  const p7 = haveWeek ? paceOf(rl.seven_day, 7 * 24 * 3600, week) : { ok: false, hot: false };

  // ── derived, machine-readable: every number the bars compute — time left, tokens burned, and
  //    needPerMin — as plain fields, so an agent can read ~/.tokenmaxx/status.json (or
  //    `node render.mjs --status`) instead of scraping ANSI.
  //    needPerMin = the rate that MAXIMIZES throughput: burn all the way to the session cap right as
  //    it resets, since unused session budget just evaporates (the week is maximized by never
  //    leaving a session on the table). = headroom-to-cap ÷ minutes left. Falls to 0 once you're at
  //    the cap — "without going over the session max" — so it never tells you to overshoot.
  function windowStat(tokV, capV, usedFrac, resetAt, winSec) {
    const secLeft = resetAt ? Math.max(0, Math.round(resetAt - nowS)) : 0;
    const minLeft = secLeft / 60;
    const cap = capV || 0;
    const used = tokV != null ? Math.round(tokV) : Math.round(usedFrac * cap);
    const headroom = Math.max(0, cap - used);                    // room left before the session max
    const needPerMin = cap && minLeft > 0 ? Math.round(headroom / minLeft) : 0; // fully use it by reset
    const pacePerMin = cap ? Math.round(cap / (winSec / 60)) : 0; // even burn that lands at 100%
    return { usedPct: Math.round(usedFrac * 1000) / 10, used, cap, headroom, resetAt: resetAt || 0,
             secLeft, minLeft: Math.round(minLeft), resetIn: resetIn(resetAt), needPerMin, pacePerMin };
  }
  const sStat = windowStat(used5, realMax, q5, haveQuota ? rl.five_hour.resets_at : 0, 5 * 3600);
  const wStat = windowStat(used7, cap7s, w7, haveWeek ? rl.seven_day.resets_at : 0, 7 * 24 * 3600);
  // pace gap (points): elapsed − used. + = behind even-burn (under-using), − = ahead. Cap-independent.
  sStat.elapsedPct = Math.round(e5 * 100); sStat.behindPts = Math.round((e5 - q5) * 100);
  wStat.elapsedPct = Math.round(e7 * 100); wStat.behindPts = Math.round((e7 - w7) * 100);
  // is the weekly the binding wall (realMax below the raw 5h cap)? = the session allowance is being
  // held down to protect the week. Kept for agents; no longer a separate tag on the bar.
  sStat.weeklyPaced = !!(haveWeek && cap5s && realMax < cap5s);
  const status = {
    ts: Date.now(), model: fam, ctxPct: Math.round(ctxPct), cachePct: Math.round(cache * 100),
    costUsd: Math.round(usd * 100) / 100, sessions: mine,
    // session.cap = realMax (weekly-derived sustainable budget), NOT Anthropic's raw 5h cap.
    session: sStat, weekly: wStat,
    sessionsLeftInWeek: Math.round(sessionsLeft * 10) / 10, // 5h windows remaining until the weekly resets
    burn5m: burn5 != null ? Math.round(burn5) : null,       // gross tokens spent in the last 5 min (≥ 0)
  };
  try { writeFileSync(path.join(HOME, ".tokenmaxx", "status.json"), JSON.stringify(status)); } catch {}
  if (wantStatus) { process.stdout.write(JSON.stringify(status, null, 2) + "\n"); return; }

  // paceMove: when a wall's hot, the ONE thing the human can actually flip right now — ranked
  // by leverage against what the bar already sees. Opus burns the cap fastest (one keystroke
  // to Sonnet); N parallel sessions burn N×; a cold cache pays full freight; else just step
  // away (the catch-up break) or ease off for the day. null when you'll coast → "on track".
  function paceMove() {
    const sHot = p5.hot, wHot = p7.hot;
    if (!sHot && !wHot) return null;
    const col = (sHot && p5.col === RED) || (wHot && p7.col === RED) ? RED : AMBER;
    const label = sHot && wHot ? "both" : sHot ? "session" : "weekly";
    let lever;
    if (fam === "Opus") lever = "try Sonnet";
    else if (mine > 1) lever = `close ${mine - 1} sess`;
    else if (cache < 0.85) lever = "warm cache";
    else if (sHot && p5.breakMin <= 45) lever = `break ~${Math.max(1, p5.breakMin)}m`;
    else lever = "wrap up"; // no switch left to flip — stop cleanly before the wall
    const heat = col === RED ? "running hot" : "running a little hot";
    return { text: `${label} — ${lever}`, phrase: `${label} ${heat} — ${lever}`, col };
  }
  // narrow terminal: one compact line — the two quotas.
  if (cols < 88) {
    const l = fg(DIM, "session ") + fg(qcol, qv) + fg(DIM, "   weekly ") + fg(wcol, wv);
    process.stdout.write(padLine(l, cols) + "\n");
    return;
  }

  // ── quiet rail: borderless, airy, lowercase, calm. no frame — every line is just the dark
  //    panel bg, indented, so it reads as one soft band, not a box.
  const PAD = 2; // margin pulled left so the bars run wide and the movement is easy to feel
  const W = Math.max(40, cols - PAD * 2 - 2); // -2 = a right safety margin so nothing gets clipped
  // meter width: wide, but CAPPED so it can't swallow the whole line — always leave room for the
  // label before it and the (comma'd, up to ~16-char) cushion/over after it, plus a badge.
  // widen with the terminal: no fixed 90-cell cap (that left half a wide screen empty). Scale to
  // ~0.68 of the rail, leaving ~46 cells for the label + cushion/over + time-left + need/min badges.
  const mw = Math.max(24, Math.min(Math.round(W * 0.68), 160, W - 46));
  const row = (s) => padLine(blank(PAD) + s, cols); // one banded line, left-indented
  const fits = (s, add) => dispWidth(s) + dispWidth(add) <= W; // only append if the row can hold it

  // a wall's row, plain-language. SESSION: "X to spend" — your sustainable allowance for THIS window
  // (realMax − used); counts down as you burn, climbs back after a break. Negative → "over — ease
  // off" (you're starting to eat future weeks). WEEKLY: "X left" — the reserve. + time left.
  const meterContent = (label, u, e, uv, isSession, stat) => {
    let s = fg(DIM, label) + meter(u, e, mw, isSession ? 0 : 1, isSession);
    if (stat && stat.cap) {
      if (isSession) {
        const spend = Math.round(stat.cap - stat.used); // realMax − used: what you can still spend now
        const d = spend >= 0
          ? fg(DIM, "  ") + fg(INK, tkfull(spend)) + fg(DIM, " to spend")
          : fg(DIM, "  ") + fg(zoneCol(u, e), tkfull(-spend) + " over — ease off");
        if (fits(s, d)) s += d;
      } else {
        const d = fg(DIM, "  ") + fg(INK, tkfull(stat.headroom)) + fg(DIM, " left"); if (fits(s, d)) s += d;
      }
    } else if (uv) { const d = fg(DIM, "  ") + fg(wcol, uv) + fg(DIM, " used"); if (fits(s, d)) s += d; } // no cap → raw %
    if (stat && stat.resetIn) { const d = fg(DIM, "  ·  ") + fg(DIM, stat.resetIn); if (fits(s, d)) s += d; }
    if (isSession && freshReset) { const b = fg(DIM, "  ") + fg(BRAND, "↺ just reset"); if (fits(s, b)) s += b; }
    return s;
  };

  // one calm meta line, lowercase, airy dot separators. ctx + cache carry contextual color.
  const ctxCol = ctxPct >= 85 ? RED : ctxPct >= 65 ? AMBER : DIM;
  let metaRow = fg(DIM, fam.toLowerCase() + (branch ? "  ·  " + trunc(branch, 34) : "") + `  ·  $${Math.round(usd)}  ·  ctx `)
    + fg(ctxCol, `${Math.floor(ctxPct)}%`) + fg(DIM, "  ·  cache ") + fg(cacheCol, cacheV);
  // 5m burn: gross tokens spent in the last 5 min, coloured by the maximize pace. To fully use a
  // 5h budget you must burn ≈ cap5/60 every 5 min; less than that leaves tokens to expire.
  //   GREEN  burn ≥ pace  → keeping up / maxing the session
  //   AMBER  0 < burn < pace → spending, but too slow (e.g. "222k burn")
  //   RED    ~idle        → not using it, the session is aging out unused
  if (burn5 != null && cap5) {
    const pace = cap5 / 60, idle = burn5 <= 15000;
    const col = idle ? RED : burn5 >= pace ? GREEN : AMBER;
    metaRow += fg(DIM, "  ·  5m ") + fg(col, idle ? "idle" : tkf(burn5) + " burn");
  }

  // coach pulled for now — the meters + cushion/over carry it. keep /maxx as a quiet sign-off at
  // the right of the stats line.
  const footStr = fg(DIM, "/maxx");
  const metaFull = dispWidth(metaRow) + 3 + dispWidth(footStr) <= W
    ? metaRow + blank(W - dispWidth(metaRow) - dispWidth(footStr)) + footStr
    : metaRow;

  const out = [
    row(meterContent("session  ", q5, e5, qv, true, sStat)),
    row(""), // one air line so the two rails don't fuse into one blob
    row(meterContent("weekly   ", w7, e7, wv, false, wStat)),
    row(metaFull),
  ];
  process.stdout.write(out.join("\n") + "\n");
}
main();
