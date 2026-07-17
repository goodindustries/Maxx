#!/usr/bin/env node
/**
 * maxx statusline renderer — the LOOK, in Node (no binary, no build step).
 *
 * Reads Claude Code's stdin JSON (rate_limits.five_hour/seven_day = the real
 * session/weekly walls, same numbers as /usage) + ~/.maxx/state.json the brain
 * writes (advice / intent / presence), then paints a clean two-pane cockpit:
 * quota + model on the left, a coach thought on the right, presence at the edges.
 *
 * Ships as plain Node because the rest of maxx already needs Node (the /maxx skill
 * and the coach hook) — nothing extra to install, nothing to compile. A tiny ANSI
 * compositor stands in for lipgloss.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
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
// intensity shade along a fill: frac 0 = lightest (near white), 0.5 = the base color, 1 = darkest (near
// black). Lets a bar deepen from its base toward its leading edge, so more fill reads as more intense.
function shade(hex, frac) {
  frac = Math.max(0, Math.min(1, frac));
  return frac < 0.5 ? mix(hex, (0.5 - frac) * 0.7, "#ffffff") : mix(hex, (frac - 0.5) * 0.2, "#000000");
}
// Apple's Terminal.app has no 24-bit color (verified on Sequoia: 38;2 renders as black/garbage,
// even though shells there often export COLORTERM=truecolor). Downconvert to the xterm-256 cube
// for it; every other mainstream terminal (iTerm2/Ghostty/Warp/Alacritty/kitty/VS Code) gets 24-bit.
const USE_256 = process.env.TERM_PROGRAM === "Apple_Terminal";
function to256([r, g, b]) {
  // grayscale ramp (232-255) when the channels are close — keeps the lilac track from banding weirdly
  if (Math.max(r, g, b) - Math.min(r, g, b) < 12) {
    const v = Math.round((r + g + b) / 3);
    if (v < 8) return 16;
    if (v > 238) return 231;
    return 232 + Math.round((v - 8) / 10);
  }
  const q = (v) => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.round((v - 35) / 40)));
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}
const sgrFg = (c) => (USE_256 ? `38;5;${to256(c)}` : `38;2;${c[0]};${c[1]};${c[2]}`);
const sgrBg = (c) => (USE_256 ? `48;5;${to256(c)}` : `48;2;${c[0]};${c[1]};${c[2]}`);
function esc(fgHex, bgHex, s) {
  return `\x1b[${sgrFg(rgb(fgHex))};${sgrBg(rgb(bgHex))}m${s}\x1b[0m`;
}
const fg = (c, s) => esc(c, BG, s);
// italic variant (adds SGR 3) — for the calm coach line; degrades gracefully if unsupported
function ital(fgHex, s) {
  return `\x1b[3;${sgrFg(rgb(fgHex))};${sgrBg(rgb(BG))}m${s}\x1b[0m`;
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
  if (!st || !st.session) return "maxx — no usage data yet. Open Claude Code so the statusline can write ~/.maxx/status.json, then retry.";
  const s = st.session, w = st.weekly || {};
  const toSpend = s.toSpend != null ? s.toSpend : Math.max(0, (s.cap || 0) - (s.used || 0));
  const over = s.over != null ? s.over : Math.max(0, (s.used || 0) - (s.cap || 0));
  // even burn = the budget spread over a ROLLING 5h (300 min). Anchored to the rolling window, not the
  // time-to-fixed-reset — so it never divides by zero (the old "~0/min" bug at the reset boundary).
  const perMin = toSpend > 0 ? Math.round(toSpend / 300) : 0;
  const sess = st.sessionsLeftInWeek;
  // short, glanceable magnitudes: 18.2M, 457M, 61k. The raw counts stay in the machine line above.
  const abbr = (n) => { n = Math.round(Math.abs(n || 0)); return n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : "" + n; };
  const row = (label, val, ctx) => `  ${label.padEnd(11)}${String(val).padEnd(14)}${ctx}`;
  const out = [];
  // machine line: session.cap is realMax (weekly-paced), NOT the 5h wall — RAW_* are the real 5h window.
  out.push(`SPEND_THIS_SESSION=${toSpend} SPEND_PER_MIN=${perMin} OVER=${over} SESSION_RESETS_IN=${s.resetIn || "?"} SESSION_RESETS_IN_MIN=${s.minLeft ?? "?"} CAP_KIND=${s.capKind || "?"} RAW_5H_CAP=${s.rawCap ?? "?"} RAW_5H_USED_PCT=${s.rawUsedPct ?? "?"} RAW_5H_LEFT=${s.rawHeadroom ?? "?"} WEEKLY_LEFT=${w.headroom || 0} WEEKLY_RESETS_IN=${w.resetIn || "?"} SESSIONS_LEFT_WEEK=${sess ?? "?"}`);
  out.push("");
  out.push("maxx · this session");
  out.push("");
  if (over <= 0) {
    out.push(row("budget", abbr(toSpend), "to spend this rolling 5h window"));
    out.push(row("even burn", "~" + abbr(perMin) + "/min", "spreads it evenly"));
  } else {
    out.push(row("over", abbr(over), "past your share — ease off, the tank refuels as usage ages out"));
  }
  out.push(row("week", abbr(w.headroom || 0) + " left", `· ${sess ?? "?"} windows left · resets in ${w.resetIn || "?"}`));
  out.push(row("5h wall", (s.rawUsedPct ?? "?") + "% used", `· ${abbr(s.rawHeadroom || 0)} until Anthropic's hard lockout`));
  out.push("");
  out.push("  Budget = your weekly tokens ÷ the 5h windows left this week. Stay under it and the");
  out.push("  week lasts; max the raw 5h wall instead and you're locked out in days. Idle and the");
  out.push("  tank refuels as old usage ages out — bank by chilling.");
  return out.join("\n");
}

// zone = a function of time left: project your burn to reset (used ÷ elapsed). Under the pace
// line → safe, on it → elevated, headed past the wall → danger. Colors the meter + the number.
function zoneCol(u, e) {
  const proj = u / Math.max(e, 0.02); // projected fullness at reset if you hold this pace
  return u >= 0.9 || proj >= 1.25 ? RED : proj >= 0.9 ? AMBER : GREEN;
}

// FUEL gauge — the bar is what's LEFT, not what's spent. Full budget = full tank; spending drains it
// (green shrinks from the right), and for the roll-session the rolling window REFILLS it as old usage
// ages out — so banking visibly GAINS fuel. A pace tick marks the fuel you'd have at even burn: tank
// past the tick = ahead/banked (green), short of it = burning too fast (amber → red near empty).
function fuelMeter(fuelFrac, e, w) {
  fuelFrac = Math.max(0, Math.min(1, fuelFrac));
  const fuelN = Math.round(fuelFrac * w);
  const paceFuel = Math.max(0, Math.min(1, 1 - e));            // fuel remaining if spending at even burn
  const paceN = Math.min(w - 1, Math.round(paceFuel * w));
  const ratio = paceFuel > 0.02 ? fuelFrac / paceFuel : 1;    // >1 = more fuel than pace (banked)
  const col = (fuelFrac < 0.1 || ratio < 0.5) ? RED : ratio < 0.85 ? AMBER : GREEN;
  let s = fg(START, "▐"); // full-tank end
  for (let i = 0; i < w; i++) {
    const cell = i < fuelN ? shade(col, fuelN > 1 ? i / (fuelN - 1) : 0.5) : null;
    if (i === paceN) s += cell ? esc("#ffffff", cell, "╎")           // in the fill: thin white line on the fuel color
                              : fg(BORDER, "╎");                     // in the drained zone: the thin marker
    else s += cell ? fg(cell, "█") : fg(TRACK, "█");
  }
  return s + fg(WALL, "▌"); // empty end
}

// NET bar — one directional fill for your STANDING (signed fuel = realMax − rolling usage). NEGATIVE
// (over your paced share) grows RED in from the RIGHT edge, right→left, longer the more over. As the
// rolling window ages out (or you ease off) the deficit shrinks and the red RECEDES — live, per second.
// Cross into POSITIVE (banked fuel) and GREEN grows from the LEFT, left→right. Scale = realMax (the
// session budget), so a full tank's worth of over/under = a full bar; smaller = a proportional sliver.
function netBar(standing, greenScale, redScale, w) {
  // green (banking) scales to your PACED share; red (over) scales to the HARD 5h wall — so full red means
  // lockout is imminent, not merely "past your soft pace". Just over pace → a light-red sliver creeping in.
  const frac = standing >= 0
    ? Math.min(1, standing / Math.max(greenScale, 1))
    : Math.min(1, -standing / Math.max(redScale, 1));
  const n = Math.round(frac * w);
  let out = fg(START, "▐"); // same framing as the week fuel tank
  // gradient gauged to the FULL width (not the fill length), so the light→dark spread runs across the
  // whole span: a short fill stays light, only a fill reaching the far edge hits full dark. Both fills
  // are lightest at their anchor edge and deepen toward the leading edge (green→right, red→left/wall).
  const W1 = Math.max(1, w - 1);
  for (let i = 0; i < w; i++) {
    const red = standing < 0 && i >= w - n;  // red deficit anchored at the RIGHT
    const green = standing > 0 && i < n;      // green banked fuel anchored at the LEFT
    out += red ? fg(shade(RED, (w - 1 - i) / W1), "█")
      : green ? fg(shade(GREEN, i / W1), "█")
      : fg(TRACK, "█"); // solid track = same weight as the week tank
  }
  return out + fg(WALL, "▌");
}

// ─── sidecar state ─────────────────────────────────────────────────────────────
const HOME = homedir();
const readJSON = (p, d = {}) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return d; } };
const statePath = path.join(HOME, ".maxx", "state.json");
const sprintPath = path.join(HOME, ".maxx", "sprint.json");
const sessionsCache = path.join(HOME, ".maxx", ".sessions");

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
    const st = readJSON(path.join(HOME, ".maxx", "status.json"), null);
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
  // stdin sometimes arrives without rate_limits (or with five_hour only). Zeroing out then is
  // catastrophic for the week row: elapsed→0 pins the pace tick to the far right and the fill
  // unpins from /usage — a self-contradicting gauge. Fall back to the recently cached %s and
  // reset times instead; only a LIVE rate_limits payload may refresh that cache (no laundering
  // stale values with a fresh timestamp).
  const liveRL = !!(rl.five_hour || rl.seven_day);
  const rlCache = readJSON(path.join(HOME, ".maxx", "rl.json"), null);
  const cacheFresh = rlCache && rlCache.ts && Date.now() - rlCache.ts < 30 * 60 * 1000;
  // Concurrent sessions on one account see different rate-limit snapshots: one lags a whole
  // window behind (its 5h block rolled), or lags within the window (used% behind). Alternating
  // writes to the shared cache made every gauge flap and every cap anchor balloon. Merge rule:
  // the LATER resets_at wins (newest window); within the same window used% is monotonic, so
  // take the MAX. A session with no stdin payload rides the fresh cache entirely.
  const mergeWall = (live, cPct, cReset) => {
    const havePrev = cacheFresh && cReset > 0;
    if (!live) return havePrev ? { pct: cPct || 0, reset: cReset } : null;
    const lPct = (live.used_percentage || 0) / 100, lReset = live.resets_at || 0;
    if (havePrev && cReset > lReset) return { pct: cPct || 0, reset: cReset };
    if (havePrev && cReset === lReset) return { pct: Math.max(lPct, cPct || 0), reset: lReset };
    return { pct: lPct, reset: lReset };
  };
  const wall5 = mergeWall(rl.five_hour, rlCache && rlCache.quota, rlCache && rlCache.fiveResetAt);
  const wall7 = mergeWall(rl.seven_day, rlCache && rlCache.week, rlCache && rlCache.weekResetAt);
  if (wall5) rl.five_hour = { used_percentage: wall5.pct * 100, resets_at: wall5.reset };
  if (wall7) rl.seven_day = { used_percentage: wall7.pct * 100, resets_at: wall7.reset };
  const haveQuota = !!rl.five_hour, haveWeek = !!rl.seven_day;
  const quota = wall5 ? wall5.pct : 0;
  const week = wall7 ? wall7.pct : 0;

  // hand the authoritative %s to limit.mjs (the brain reruns it) so it can anchor token caps.
  // stash seven_day.resets_at too: limit.mjs (no stdin of its own) needs it to cut the weekly
  // sum at the real window start instead of a blind rolling 7d — see weekLo below.
  try { if (liveRL && haveQuota) writeFileSync(path.join(HOME, ".maxx", "rl.json"), JSON.stringify({ quota, week, fiveResetAt: rl.five_hour.resets_at || 0, weekResetAt: haveWeek ? rl.seven_day.resets_at : 0, ts: Date.now() })); } catch {}
  // session-reset flag: the 5h wall's resets_at jumps forward when a fresh block starts. Track
  // the last one; when it leaps (>5min later), the window just cleared — flag it for ~5 min.
  const marksPath = path.join(HOME, ".maxx", "marks.json");
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
  const win = readJSON(path.join(HOME, ".maxx", "window.json"), null);
  let tok5 = null, tok5roll = null, cap5 = null, tok7 = null, cap7 = null, burn5 = null, burn60 = 0, refuelPerMin = 0;
  if (win && Array.isArray(win.buckets) && win.buckets.length) {
    const now = Date.now();
    const sum = (ms) => { const c = now - ms; let s = 0; for (const b of win.buckets) if (b[0] > c) s += b[1]; return s; };
    const sumFrom = (lo) => { let s = 0; for (const b of win.buckets) if (b[0] > lo) s += b[1]; return s; };
    // SMOOTH rolling window (age-weighted decay): every bucket's weight fades LINEARLY from 1 (just now)
    // to 0 (5h old), so all recent spend is continuously decaying — not a hard cutoff that only drops the
    // trailing bucket. `now` advances every render (~1s), so the weighted sum shrinks a little each second
    // and the fuel tank refills smoothly per second while you idle, at ~(last-5h spend)/5h per second.
    // A spend fully "returns" 5h after it happened; idling just lets the decay run. This is the roll-
    // session's own pacing clock, not Anthropic's hard 5h wall (that stays in the raw* fields).
    const decaySum = (winMs) => { let s = 0; for (const b of win.buckets) { const age = now - b[0]; if (age >= winMs) continue; s += b[1] * (1 - age / winMs); } return s; };
    // session: sum from the real window start (resets_at − 5h), same as weekly below — NOT a blind
    // rolling 5h. So the instant the wall resets (resets_at leaps +5h), pre-reset burn stops counting
    // and the bar drops to ~0 immediately, instead of decaying stale over the next 5 hours.
    const FIVE = 5 * 3600 * 1000;
    const fiveLo = Math.max(now - FIVE, haveQuota ? rl.five_hour.resets_at * 1000 - FIVE : 0);
    tok5 = sumFrom(fiveLo); cap5 = win.cap5;
    // ROLLING 5h window for the roll-session fuel: sum the trailing 5h regardless of Anthropic's fixed
    // reset boundary. Old buckets age out the back continuously, so idling REFILLS the tank (bank by
    // chilling) instead of waiting for a cliff at resets_at. This is the roll-session's own clock; the
    // hard Anthropic 5h wall stays exposed via the raw* fields (quota).
    tok5roll = decaySum(FIVE);
    // refuel = how fast the rolling tank refills (in-window burn decays over 300 min) → the "progress"
    // trend below is refuel − live burn: + = standing improving (recovering/banking), − = losing ground.
    refuelPerMin = Math.round(sum(FIVE) / 300);
    // weekly: sum from Anthropic's actual window start (resets_at − 7d), not a blind now − 7d, so a
    // pre-reset burst stops counting the instant the wall zeroed. max() = never loosen past the
    // rolling window, so a stale/absent resets_at falls back to old behavior (never counts more).
    const WK = 7 * 24 * 3600 * 1000;
    const weekLo = Math.max(now - WK, haveWeek ? rl.seven_day.resets_at * 1000 - WK : 0);
    tok7 = sumFrom(weekLo); cap7 = win.cap7;
    // gross tokens burned in the last 5 min (always ≥ 0). This is the live "are you actually using
    // the session" signal — coloured against the maximize pace, and shown as "idle" when it's ~0.
    burn5 = sum(5 * 60 * 1000);
    // live per-min burn, age-weighted (glides down each render as a spike ages out) — feeds the trend.
    burn60 = Math.round(decaySum(60 * 1000) * 2);
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
  const capsPath = path.join(HOME, ".maxx", "caps.json");
  const caps = readJSON(capsPath, {});
  const anchorCap = (have, pct, tok, prevPct, prevCap, brainCap) => {
    if (have && pct > 0.02 && tok != null) {
      if (prevCap && prevPct != null && Math.abs(prevPct - pct) < 0.005) return prevCap; // wall % steady → hold
      // wall ticked → re-anchor, but EMA-smooth the jump (½ old, ½ new). The cap is an estimate (tok is
      // cache-inflated, so tok/pct can leap on a tick); blending keeps roll-session from lurching on noise
      // while still tracking the real magnitude over a few ticks. First-ever anchor: take it straight.
      return prevCap ? Math.round(0.5 * prevCap + 0.5 * (tok / pct)) : Math.round(tok / pct);
    }
    return prevCap || brainCap || 0; // below the 2% floor (or no stdin) → keep the last good cap
  };
  const cap5s = anchorCap(haveQuota, quota, tok5, caps.q5, caps.cap5, cap5);
  const cap7s = anchorCap(haveWeek, week, tok7, caps.q7, caps.cap7, cap7);
  // did the cap just re-anchor (first anchor OR the wall % ticked ≥0.5pt)? If so we re-snapshot the
  // bucket sum as the new "anchor tok" — the live delta below is measured from there, so it resets to
  // ~0 at every tick and can never accumulate into the old 2× drift.
  const didAnchor = (have, pct, tok, prevPct, prevCap) =>
    have && pct > 0.02 && tok != null && !(prevCap && prevPct != null && Math.abs(prevPct - pct) < 0.005);
  const tok5a = didAnchor(haveQuota, quota, tok5, caps.q5, caps.cap5) ? tok5 : (caps.tok5a ?? (tok5 ?? 0));
  const tok7a = didAnchor(haveWeek, week, tok7, caps.q7, caps.cap7) ? tok7 : (caps.tok7a ?? (tok7 ?? 0));
  try { writeFileSync(capsPath, JSON.stringify({ q5: haveQuota ? quota : caps.q5, cap5: cap5s, tok5a, q7: haveWeek ? week : caps.q7, cap7: cap7s, tok7a })); } catch {}
  // LIVE used = authoritative base + scaled burn since the last %-tick. The base (wall% × cap) is
  // Anthropic's truth — what /usage shows. On top we add the tokens burned since the anchor, but the raw
  // bucket delta over-counts (cache reads at full weight), so we scale it by the deflation factor we can
  // MEASURE right now: f = base ÷ tok = how many Anthropic-charged tokens per maxx-counted token over the
  // window. That makes "left" tick down every render as you spend (≈1s cadence) while staying pinned to
  // the real % — and f→0 as the gap widens, so the live add is bounded (worst case ~2× base, never the
  // old unbounded drift). Falls back to the raw bucket sum only with no wall data (offline).
  const liveUsed = (have, pct, capS, tok, toka) => {
    if (!have || !capS) return tok != null ? Math.round(tok) : 0;
    const base = pct * capS;
    const f = Math.max(0, Math.min(1, tok > 0 ? base / tok : 1)); // measured deflation, clamped
    const delta = tok != null ? tok - (toka ?? tok) : 0;          // burn since the last %-tick
    return Math.max(0, Math.min(capS, Math.round(base + f * delta)));
  };
  // roll-session usage = the ROLLING 5h bucket sum (recovers as old buckets age out → fuel refills when
  // you idle). Falls back to the fixed-block pinned value when buckets are missing. Weekly stays PINNED to
  // Anthropic's seven_day % (the weekly bar must match /usage). Both in the same (maxx) token units as the
  // caps, so the fuel fractions below are honest ratios even though the absolute magnitudes are estimates.
  const used5 = tok5roll != null ? Math.round(tok5roll) : liveUsed(haveQuota, quota, cap5s, tok5, tok5a);
  const used7 = liveUsed(haveWeek, week, cap7s, tok7, tok7a);
  // ROLL-SESSION — one sentence: weekly tokens LEFT ÷ the 5h windows left this week = tokens good to use
  // this session. Spend up to it and the week lasts; max Anthropic's raw 5h wall instead and you're out in
  // days. It BANKS: it's LIVE, so as you spend, weekly-left drops and it ticks down (~1:1); when you go
  // light, windows-left counts down with the clock and it ticks UP — frugal now = more later, no ledger.
  // Capped at the hard 5h wall (can't spend past it); falls back to the raw 5h cap with no weekly data.
  // The cap-smoothing above keeps this from jittering on estimate noise — it moves for spend + time only.
  const nowS0 = Date.now() / 1000;
  const weekLeftSec = haveWeek ? Math.max(0, rl.seven_day.resets_at - nowS0) : 0;
  const sessionsLeft = Math.max(1, weekLeftSec / (5 * 3600));         // 5h windows until the weekly resets
  const realMax = haveWeek && cap7s
    ? Math.min(cap5s || Infinity, Math.round(Math.max(0, cap7s - used7) / sessionsLeft))
    : cap5s;
  // session bar is now the REAL session: used against realMax, not the raw 5h wall.
  const q5 = realMax ? Math.min(1, used5 / realMax) : (haveQuota ? quota : 0);
  // week FILL pins straight to Anthropic's % — cap estimates scale the token numbers only, so
  // anchor noise (unit changes, stale caps) can never bend the bar away from /usage.
  const w7 = haveWeek ? week : (cap7s ? Math.min(1, used7 / cap7s) : 0);
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
  //    needPerMin — as plain fields, so an agent can read ~/.maxx/status.json (or
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
  // ── hard-to-misread contract for consumers. A downstream "governor" read session.cap as the raw
  //    5h wall and concluded "plenty of headroom, run flat-out" — the opposite of the truth. So make
  //    the meaning explicit: session.cap IS realMax (the weekly-paced budget, NOT the 5h wall).
  //    toSpend/over/spendPerMin are the actionable pace numbers. raw* are the ACTUAL 5h window, for a
  //    consumer that genuinely wants "% of the 5h window" instead of misreading the paced one.
  sStat.toSpend = Math.max(0, realMax - used5);                     // safe to spend this session (≥ 0)
  sStat.bank = Math.round((cap7s || 0) * e7 - used7);               // + banked vs even-pace, − spent-ahead (the roll)
  sStat.over = Math.max(0, used5 - realMax);                        // past your sustainable share (≥ 0)
  sStat.name = "roll-session";                                     // brand: weekly-left ÷ windows-left, banks when light
  sStat.capKind = sStat.weeklyPaced ? "weekly-paced" : "5h-cap";   // what set session.cap / realMax
  sStat.sessionResetsInMin = sStat.minLeft;                         // minutes until the 5h wall resets
  sStat.spendPerMin = sStat.toSpend > 0 && sStat.minLeft > 0 ? Math.round(sStat.toSpend / sStat.minLeft) : 0;
  // raw* = Anthropic's ACTUAL fixed 5h wall (from quota), NOT the rolling roll-session usage above. Pinned
  // to the five_hour % so it matches /usage; the roll-session uses its own rolling window.
  const rawUsedFixed = Math.round((haveQuota ? quota : 0) * (cap5s || 0));
  sStat.rawCap = cap5s || 0;                                        // Anthropic's real 5h token cap
  sStat.rawUsed = rawUsedFixed;
  sStat.rawUsedPct = haveQuota ? Math.round(quota * 1000) / 10 : 0; // % of the ACTUAL fixed 5h window (= /usage)
  sStat.rawHeadroom = Math.max(0, (cap5s || 0) - rawUsedFixed);     // tokens left before the 5h wall
  const status = {
    ts: Date.now(), model: fam, ctxPct: Math.round(ctxPct), cachePct: Math.round(cache * 100),
    costUsd: Math.round(usd * 100) / 100, sessions: mine,
    // session.cap = realMax (weekly-derived sustainable budget), NOT Anthropic's raw 5h cap.
    session: sStat, weekly: wStat,
    sessionsLeftInWeek: Math.round(sessionsLeft * 10) / 10, // 5h windows remaining until the weekly resets
    burn5m: burn5 != null ? Math.round(burn5) : null,       // gross tokens spent in the last 5 min (≥ 0)
  };
  try { writeFileSync(path.join(HOME, ".maxx", "status.json"), JSON.stringify(status)); } catch {}
  if (wantStatus) { process.stdout.write(JSON.stringify(status, null, 2) + "\n"); return; }

  // refresh window.json (the rolling-token cache limit.mjs owns; the bar + the governor read it). The
  // statusline ticks every ~1s, so gate the rescan: incremental tail every 5s (cheap, keeps burn near-
  // live even mid-turn), authoritative --full every 5 min to reconcile any drift. Detached + unref'd so
  // it never blocks a render. This lived in brain.mjs (a Stop hook); moved here so the data stays fresh
  // WHILE the agent works, not only at turn end — which is what an unattended overnight governor needs.
  const dueFor = (mark, ms) => { try { return Date.now() - Number(readFileSync(mark, "utf8")) > ms; } catch { return true; } };
  const markNow = (mark) => { try { writeFileSync(mark, String(Date.now())); } catch {} };
  const scanMark = path.join(HOME, ".maxx", ".limit-scan"), fullMark = path.join(HOME, ".maxx", ".limit-full");
  if (dueFor(scanMark, 5000)) {
    markNow(scanMark);
    const full = dueFor(fullMark, 5 * 60 * 1000); if (full) markNow(fullMark);
    try {
      spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "limit.mjs"), ...(full ? ["--full"] : [])],
            { detached: true, stdio: "ignore" }).unref();
    } catch {}
  }

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
  const mw = Math.max(20, Math.min(Math.round(W * 0.4), 64, W - 46));
  const row = (s) => padLine(blank(PAD) + s, cols); // one banded line, left-indented
  const fits = (s, add) => dispWidth(s) + dispWidth(add) <= W; // only append if the row can hold it

  // ODOMETER — every shown number counts toward its target by AT MOST ±1 (in display units, k) per
  // render: the ones digit rolls before the tens, values NEVER jump. Slow to calibrate after a big move,
  // by design. First sight snaps (no count-up from 0). State persists per-key in odo.json across renders.
  const odoPath = path.join(HOME, ".maxx", "odo.json");
  const odo = readJSON(odoPath, {});
  const step1 = (key, targetK) => {
    const k = (sid || "s") + ":" + key; // per-session → concurrent panes each step on their OWN repaints
    const t = Math.round(targetK);
    const p = Number.isFinite(odo[k]) ? odo[k] : t;
    const gap = t - p;
    // ±1 per frame for the odometer roll on normal moves; FAST catch-up on a big swing so a huge jump
    // doesn't take minutes (which made the number lie vs the instant bar). >40k gap → close ~1/3 per frame.
    const d = Math.abs(gap) <= 1 ? gap : Math.abs(gap) > 40 ? Math.round(gap * 0.34) : Math.sign(gap);
    const nxt = p + d;
    odo[k] = nxt;
    return nxt;
  };
  const kstr = (kv) => Math.round(Math.abs(kv)).toLocaleString("en-US") + "k"; // signed value already in k

  // a wall's row, plain-language. SESSION: "X to spend" — your sustainable allowance for THIS window
  // (realMax − used); counts down as you burn, climbs back after a break. Negative → "over — ease
  // off" (you're starting to eat future weeks). WEEKLY: "X left" — the reserve. + time left.
  const meterContent = (label, u, e, uv, isSession, stat) => {
    // SESSION bar IS the directional standing fill (one bar: green-from-left when banked, red-from-right
    // when over). WEEK keeps the fuel tank (bar = weekly reserve LEFT, draining as you spend).
    const standing = isSession && stat && stat.cap ? Math.round(stat.cap - stat.used) : 0;
    // red scales to the hard 5h wall: over-room = rawCap − realMax (paced share → lockout). Falls back to
    // the paced share when there's no soft buffer (realMax already == the raw wall).
    const overRoom = isSession && stat ? Math.max(1, (stat.rawCap || stat.cap || 0) - (stat.cap || 0)) : 1;
    let s = fg(DIM, label) + (isSession && stat && stat.cap
      ? netBar(standing, stat.cap, overRoom, mw)
      : fuelMeter(1 - u, e, mw));
    if (stat && stat.cap) {
      if (isSession) {
        // signed standing: banked → "+Xk" (ink), over → "−Xk" (red). The sign IS the meaning — no "over"
        // word. Odometer-counted (fast-jump on big swings, else ±1k) — bar snaps, number rolls to catch up.
        const standK = step1("sess", standing / 1000);
        const over_ = standK < 0;
        const d = fg(DIM, "  ") + fg(over_ ? zoneCol(u, e) : INK, (over_ ? "−" : "+") + kstr(standK));
        if (fits(s, d)) s += d;
        // trailing rate: the SIGN and COLOR follow your STANDING, not the raw rate — a positive cushion
        // must never read as "minus". Banked → green "+Xk/min"; over → red "−Xk/min". (refuel goes to ~0
        // when you're deep in the black, so a rate-signed arrow would flip to ↓ on any activity — wrong.)
        const prog = refuelPerMin - burn60;
        if (Math.abs(prog) >= 500) {
          const pos = standK > 0; // match the DISPLAYED sign (odometer standK), so number + rate never disagree
          const pr = fg(DIM, "  ·  ") + fg(pos ? GREEN : RED, (pos ? "+" : "−") + tkf(prog) + "/min");
          if (fits(s, pr)) s += pr;
        }
      } else {
        // WEEK = the reserve. LEFT = tokens remaining. bank = standing vs even-burn (cap7 × elapsed −
        // used7): + banked (green, ahead of pace) / − over (red, burning too fast). burn = drain rate.
        // LEFT + OVER in k (thousands), comma-grouped — same odometer scale as the session line, and the
        // low k-digits are exposed (vs compact "93.2M" which hid them). LEFT scrolls as you spend; OVER
        // drifts ~0.6k/sec on its own as the week's elapsed-time creeps, so its k digit ticks live too.
        const leftK = step1("wkleft", stat.headroom / 1000);
        const d = fg(DIM, "  ") + fg(INK, kstr(leftK)) + fg(DIM, " left"); if (fits(s, d)) s += d;
        if (cap7s) {
          const bankK = step1("wkbank", (cap7s * e7 - used7) / 1000);
          const b = bankK >= 0
            ? fg(DIM, "  ·  ") + fg(GREEN, "+" + kstr(bankK) + " banked")
            : fg(DIM, "  ·  ") + fg(RED, "−" + kstr(bankK) + " over");
          if (fits(s, b)) s += b;
        }
        if (stat.resetIn) { const d = fg(DIM, "  ·  ") + fg(DIM, stat.resetIn); if (fits(s, d)) s += d; }
      }
    } else if (uv) { const d = fg(DIM, "  ") + fg(wcol, uv) + fg(DIM, " used"); if (fits(s, d)) s += d; } // no cap → raw %
    return s;
  };

  // one calm meta line, lowercase, airy dot separators. ctx + cache carry contextual color.
  const ctxCol = ctxPct >= 85 ? RED : ctxPct >= 65 ? AMBER : DIM;
  let metaRow = fg(DIM, fam.toLowerCase() + (branch ? "  ·  " + trunc(branch, 34) : "") + `  ·  $${Math.round(usd)}  ·  ctx `)
    + fg(ctxCol, `${Math.floor(ctxPct)}%`) + fg(DIM, "  ·  cache ") + fg(cacheCol, cacheV);

  // coach pulled for now — the meters + cushion/over carry it. keep /maxx as a quiet sign-off at
  // the right of the stats line.
  const footStr = fg(DIM, "/maxx");
  const metaFull = dispWidth(metaRow) + 3 + dispWidth(footStr) <= W
    ? metaRow + blank(W - dispWidth(metaRow) - dispWidth(footStr)) + footStr
    : metaRow;

  const out = [
    // "session" — the rolling-5h fuel tank (weekly-left ÷ windows-left, capped at the raw 5h wall; banks
    // when you go light). "week" — the weekly reserve. Labels padded to equal width so the bars align.
    row(meterContent("session  ", q5, e5, qv, true, sStat)),
    row(""), // one air line so the two rails don't fuse into one blob
    row(meterContent("week     ", w7, e7, wv, false, wStat)),
    row(metaFull),
  ];
  try { writeFileSync(odoPath, JSON.stringify(odo)); } catch {} // persist the odometer counters for next render
  process.stdout.write(out.join("\n") + "\n");
}
main();
