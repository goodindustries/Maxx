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
const GOLD   = hsl(44, 0.74, 0.62);  // warm gold = the travelling shine
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
// tiny deterministic integer hash → [0,1). Used to schedule the gold shine's irregular launches
// (salt feeds one index into several independent random streams). No state, so every render tick
// agrees on where each shine is — that's what keeps the motion continuous while looking random.
const hashN = (n, salt = 0) => {
  let x = Math.imul((n | 0) ^ Math.imul(salt, 0x9e3779b9), 2654435761);
  x = Math.imul(x ^ (x >>> 16), 2246822519);
  x = (x ^ (x >>> 13)) >>> 0;
  return x / 4294967296;
};
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
function meter(u, e, w) {
  u = Math.max(0, Math.min(1, u)); e = Math.max(0, Math.min(1, e));
  const you = u * w, youN = Math.floor(you), part = you - youN; // your position
  const paceN = Math.min(w, Math.max(0, Math.round(e * w)));    // the pace line (cell boundary)
  const hot = zoneCol(u, e);
  const CUSH = hsl(150, 0.22, 0.62); // dusty-sage buffer: clearly lighter than the spent green so the
  // pace line (spent→cushion boundary) reads at a glance, but low saturation + mid lightness so it
  // doesn't glow or vibrate against the purple panel the way a bright mint did.
  // GOLD shine: gold shoots off up the spent fill at irregular intervals, eases to a stop AT the
  // used edge (a natural gravity turn via sin), and falls back. Launch times are a hash of the
  // bounce index — deterministic per render tick so motion stays continuous, yet fires at uneven
  // gaps with ~1/5 skipped for longer lulls. Overlapping launches coexist as separate spots (no
  // jump). Wall-clock phase, so it moves while you're active and freezes when you go idle.
  const GHW = 2.6, GPEAK = 0.5;               // shine half-width (cells) · peak gold
  const BASE = 7000, JIT = 3200, DUR = 4600;  // mean ms between launches · start jitter · bounce duration (slow)
  const now = Date.now(), n0 = Math.floor(now / BASE), centers = [];  // active shine centers this tick (usually 0–1, sometimes 2)
  for (let n = n0 - 2; n <= n0 + 1; n++) {
    if (hashN(n, 2) < 0.2) continue;                                  // ~20% skipped → longer random gaps
    const start = n * BASE + hashN(n, 1) * JIT;                       // jittered launch time
    const dur = DUR * (0.85 + hashN(n, 3) * 0.5);                     // each shine a little faster/slower
    if (now >= start && now < start + dur) {
      const p = (now - start) / dur;                                 // 0..1 through this bounce
      const amp = Math.min(1, Math.min(p, 1 - p) / 0.12);            // fade in/out at the ends → no pop at the base
      centers.push([Math.sin(p * Math.PI) * youN, amp]);            // [center (0→edge→0, eased apex), brightness envelope]
    }
  }
  const tubeAt = (i) => 0.10 * Math.max(0, 1 - Math.abs((youN > 1 ? i / (youN - 1) : 0) - 0.45) * 2); // rounded-tube shading
  const goldAt = (c, i) => { let g = 0; for (const [gc, amp] of centers) g = Math.max(g, GPEAK * amp * Math.max(0, 1 - Math.abs(i - gc) / GHW)); return g > 0.001 ? mix(c, Math.min(0.6, g), GOLD) : c; };
  let s = fg(START, "▐"); // start post (0)
  for (let i = 0; i < w; i++) {
    if (i < youN) s += fg(goldAt(mix(i < paceN ? GREEN : hot, tubeAt(i)), i), "█"); // spent: tube-shaded green + the bouncing gold shine
    else if (i === youN && part > 0.04)                                            // your leading edge (sub-cell)
      s += esc(goldAt(i < paceN ? GREEN : hot, i), i < paceN ? CUSH : TRACK, EIGHTHS[Math.max(1, Math.round(part * 8))]);
    else if (i < paceN) s += fg(CUSH, "█");                                        // cushion band (no shine — it bounced off the edge)
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
  let p = {};
  try { p = JSON.parse(readFileSync(0, "utf8")); } catch {}
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
  try { if (haveQuota) writeFileSync(path.join(HOME, ".tokenmaxx", "rl.json"), JSON.stringify({ quota, week, weekResetAt: haveWeek ? rl.seven_day.resets_at : 0, ts: Date.now() })); } catch {}
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
  let tok5 = null, cap5 = null, tok7 = null, cap7 = null, mom5 = null;
  if (win && Array.isArray(win.buckets) && win.buckets.length) {
    const now = Date.now();
    const sum = (ms) => { const c = now - ms; let s = 0; for (const b of win.buckets) if (b[0] > c) s += b[1]; return s; };
    const sumFrom = (lo) => { let s = 0; for (const b of win.buckets) if (b[0] > lo) s += b[1]; return s; };
    tok5 = sum(5 * 3600 * 1000); cap5 = win.cap5;
    // weekly: sum from Anthropic's actual window start (resets_at − 7d), not a blind now − 7d, so a
    // pre-reset burst stops counting the instant the wall zeroed. max() = never loosen past the
    // rolling window, so a stale/absent resets_at falls back to old behavior (never counts more).
    const WK = 7 * 24 * 3600 * 1000;
    const weekLo = Math.max(now - WK, haveWeek ? rl.seven_day.resets_at * 1000 - WK : 0);
    tok7 = sumFrom(weekLo); cap7 = win.cap7;
    // momentum: net change in the 5h burn over the last 5 min. + = burning, − = recovering
    // (idle → old buckets age out the back). the last window minus the same window 5 min ago.
    const win5 = (end) => { let s = 0; const lo = end - 5 * 3600 * 1000; for (const b of win.buckets) if (b[0] > lo && b[0] <= end) s += b[1]; return s; };
    mom5 = win5(now) - win5(now - 5 * 60 * 1000);
  }

  const usd = (p.cost || {}).total_cost_usd || 0;
  const fam = modelFamily((p.model || {}).display_name);
  const branch = gitBranch((p.workspace || {}).project_dir || "");

  const sp = readJSON(sprintPath);
  const { left, start: sprintStart } = sprintTimer(sp);
  try { writeFileSync(sprintPath, JSON.stringify(sp)); } catch {}

  const mine = localSessions();          // your concurrent sessions (local — mtimes only)

  const col = (v) => (v >= 0.9 ? RED : v >= 0.75 ? AMBER : GREEN);
  // the % shown comes from the SAME source as the token gauge (burned/cap) when we have it,
  // so the number and the gauge always agree and recover together; stdin % is the fallback
  // (and stays the anchor / pace input under the hood).
  const q5 = tok5 != null && cap5 ? tok5 / cap5 : quota;
  const w7 = tok7 != null && cap7 ? tok7 / cap7 : week;
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
  const mw = Math.max(24, Math.min(Math.round(W * 0.62), 90, W - 32));
  const row = (s) => padLine(blank(PAD) + s, cols); // one banded line, left-indented
  const fits = (s, add) => dispWidth(s) + dispWidth(add) <= W; // only append if the row can hold it

  // a wall's row: label · meter · cushion/over pace (live, in thousands) · fresh badge
  const meterContent = (label, u, e, tok, cap, uv, isSession) => {
    let s = fg(DIM, label) + meter(u, e, mw);
    if (tok != null && cap) {
      const room = e * cap - tok; // + = cushion under the pace line (good); − = over it (hot)
      if (Math.abs(room) > 25000) {
        const good = room >= 0;
        const d = fg(DIM, "  ") + fg(good ? DIM : zoneCol(u, e), `${good ? "+" : "−"}${tkf(room)} ${good ? "cushion" : "over"}`);
        if (fits(s, d)) s += d;
      }
    } else if (uv) { const d = fg(DIM, "  ") + fg(zoneCol(u, e), uv); if (fits(s, d)) s += d; } // no window → raw %
    if (isSession && freshReset) { const b = fg(DIM, "  ") + fg(BRAND, "↺ just reset"); if (fits(s, b)) s += b; }
    return s;
  };

  // one calm meta line, lowercase, airy dot separators. ctx + cache carry contextual color.
  const ctxCol = ctxPct >= 85 ? RED : ctxPct >= 65 ? AMBER : DIM;
  let metaRow = fg(DIM, fam.toLowerCase() + (branch ? "  ·  " + trunc(branch, 34) : "") + `  ·  $${Math.round(usd)}  ·  ctx `)
    + fg(ctxCol, `${Math.floor(ctxPct)}%`) + fg(DIM, "  ·  cache ") + fg(cacheCol, cacheV);
  // last-5-min momentum, signed like cushion/over: + = gaining ground (recovering, green), − =
  // losing ground (burning it down). Keep it legible in BOTH states — INK when burning, not the
  // faintest dim, so it doesn't read as missing.
  if (mom5 != null && Math.abs(mom5) > 15000) {
    const gaining = mom5 < 0;
    metaRow += fg(DIM, "  ·  5m ") + fg(gaining ? GREEN : INK, (gaining ? "+" : "−") + tkf(mom5));
  }

  // coach pulled for now — the meters + cushion/over carry it. keep /maxx as a quiet sign-off at
  // the right of the stats line.
  const footStr = fg(DIM, "/maxx");
  const metaFull = dispWidth(metaRow) + 3 + dispWidth(footStr) <= W
    ? metaRow + blank(W - dispWidth(metaRow) - dispWidth(footStr)) + footStr
    : metaRow;

  const out = [
    row(""),
    row(meterContent("session  ", q5, e5, tok5, cap5, qv, true)),
    row(""), // air between the rails so they don't read as one blob
    row(meterContent("weekly   ", w7, e7, tok7, cap7, wv, false)),
    row(""),
    row(metaFull),
    row(""),
  ];
  process.stdout.write(out.join("\n") + "\n");
}
main();
