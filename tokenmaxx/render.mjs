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
const GREEN  = hsl(146, 0.64, 0.32); // forest / kelly = safe
const AMBER  = hsl(36, 0.84, 0.44);  // deep amber = elevated
const RED    = hsl(352, 0.64, 0.42); // scarlet / burgundy = danger

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

// compact token count: 22.3M, 1.5B, 400K
function tk(n) {
  n = Math.max(0, Math.round(n));
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return Math.round(n / 1e3) + "K";
  return String(n);
}

// zone = a function of time left: project your burn to reset (used ÷ elapsed). Under the pace
// line → safe, on it → elevated, headed past the wall → danger. Colors the meter + the number.
function zoneCol(u, e) {
  const proj = u / Math.max(e, 0.02); // projected fullness at reset if you hold this pace
  return u >= 0.9 || proj >= 1.25 ? RED : proj >= 0.9 ? AMBER : GREEN;
}
// budget timeline: fill = where you are, ╎ = the pace line (where you should be by now), rest =
// runway. Fill is GREEN up to the line (spend that's on schedule) and hot past it (the overshoot
// eating your danger zone) — so the red length IS how far over you are. Idle recovers it: fill
// retreats as tokens age out and the line slides right, until you're back under it, all green.
function meter(u, e, w) {
  u = Math.max(0, Math.min(1, u)); e = Math.max(0, Math.min(1, e));
  const fill = Math.round(u * w), mark = Math.min(w - 1, Math.max(0, Math.round(e * w)));
  const hot = zoneCol(u, e);
  // gloss: lift the fill toward white in a soft band peaking ~45% along, so the bar reads as a
  // lit tube instead of a flat slab (edges stay saturated, middle catches the light).
  const gloss = (base, i) => {
    const pos = fill > 1 ? i / (fill - 1) : 0;
    return mix(base, 0.28 * Math.max(0, 1 - Math.abs(pos - 0.45) * 2));
  };
  let s = fg(BORDER, "▕");
  for (let i = 0; i < w; i++) {
    if (i === mark) s += fg(INK, "╎");
    else if (i < fill) s += fg(gloss(i < mark ? GREEN : hot, i), "█");
    else s += fg(TRACK, "█");
  }
  return s + fg(BORDER, "▏");
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
  try { if (haveQuota) writeFileSync(path.join(HOME, ".tokenmaxx", "rl.json"), JSON.stringify({ quota, week, ts: Date.now() })); } catch {}
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
  let tok5 = null, cap5 = null, tok7 = null, cap7 = null;
  if (win && Array.isArray(win.buckets) && win.buckets.length) {
    const now = Date.now();
    const sum = (ms) => { const c = now - ms; let s = 0; for (const b of win.buckets) if (b[0] > c) s += b[1]; return s; };
    tok5 = sum(5 * 3600 * 1000); cap5 = win.cap5;
    tok7 = sum(7 * 24 * 3600 * 1000); cap7 = win.cap7;
  }

  const usd = (p.cost || {}).total_cost_usd || 0;
  const fam = modelFamily((p.model || {}).display_name);
  const branch = gitBranch((p.workspace || {}).project_dir || "");

  const sp = readJSON(sprintPath);
  const { left, start: sprintStart } = sprintTimer(sp);
  try { writeFileSync(sprintPath, JSON.stringify(sp)); } catch {}

  const mine = localSessions();          // your concurrent sessions
  const onlineN = st.pres_people || 0;   // global count from the brain's presence fetch
  const who = Array.isArray(st.pres_who) ? st.pres_who : []; // others' handles (not you)

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
  const pm = paceMove();

  // narrow terminal: one compact line — session used + the move + coach (coach fills the rest).
  if (cols < 88) {
    let l = fg(DIM, "session ") + fg(qcol, qv);
    if (pm) l += fg(DIM, "  ") + fg(pm.col, trunc(pm.text, 24));
    const [ct, cc] = coachLine(coachSt, ctxPct, sprintStart);
    const budget = Math.max(8, cols - dispWidth(l) - 4);
    l += fg(DIM, "  ") + fg(cc, trunc(ct, budget));
    process.stdout.write(padLine(l, cols) + "\n");
    return;
  }

  // ── quiet rail: borderless, airy, lowercase, calm. no frame — every line is just the dark
  //    panel bg, indented, so it reads as one soft band, not a box.
  const PAD = 4;
  const W = Math.max(40, cols - PAD * 2);
  const mw = Math.max(24, Math.min(Math.round(W * 0.60), W - 44)); // wide meter — more cells = finer recovery to watch
  const row = (s) => padLine(blank(PAD) + s, cols); // one banded line, left-indented

  // a wall's row: label · meter · tokens-left (bright) · ahead/behind pace (live) · fresh badge
  const meterContent = (label, u, e, tok, cap, uv, isSession) => {
    let s = fg(DIM, label) + meter(u, e, mw) + fg(DIM, "  ");
    if (tok != null && cap) {
      s += fg(INK, tk(Math.max(0, cap - tok))) + fg(DIM, " left");
      const delta = tok - e * cap; // + = over the pace line (hot); − = a cushion under it (good)
      if (Math.abs(delta) > cap * 0.008) {
        const over = delta > 0;
        s += fg(DIM, "   ") + (over
          ? fg(zoneCol(u, e), `${tk(delta)} over`)
          : fg(DIM, `${tk(-delta)} cushion`)); // under pace = banked buffer, not "behind"
      }
    } else s += fg(zoneCol(u, e), uv);
    if (isSession && freshReset) s += fg(DIM, "   ") + fg(BRAND, "↺ just reset");
    return s;
  };

  // one calm meta line, lowercase, airy dot separators
  let metaRow = fg(DIM, fam.toLowerCase() + (branch ? "  ·  " + trunc(branch, 34) : "")
    + `  ·  $${Math.round(usd)}  ·  ctx ${Math.floor(ctxPct)}%  ·  cache `) + fg(cacheCol, cacheV);

  // coach line: italic, periwinkle, lowercase. when a wall's hot the move takes it over; /maxx (or
  // presence) sits quietly at the right.
  let [ctext, ccol] = coachLine(coachSt, ctxPct, sprintStart);
  if (hcol === GREEN && ccol === AMBER) ccol = BRAND;
  if (pm) { ctext = pm.phrase; ccol = pm.col; }
  let foot = "/maxx";
  if (who.length) foot = `vibing with ${who.slice(0, 2).join(", ")}${who.length > 2 ? ` +${who.length - 2}` : ""}`;
  else if (onlineN > 1) foot = `vibing with ${onlineN - 1} online`;
  const footStr = fg(DIM, foot);
  const coachStr = ital(ccol, trunc(ctext.toLowerCase(), W - dispWidth(footStr) - 3));
  const coachRow = coachStr + blank(Math.max(3, W - dispWidth(coachStr) - dispWidth(footStr))) + footStr;

  const out = [
    row(""),
    row(meterContent("session  ", q5, e5, tok5, cap5, qv, true)),
    row(""), // air between the rails so they don't read as one blob
    row(meterContent("weekly   ", w7, e7, tok7, cap7, wv, false)),
    row(""),
    row(metaRow),
    row(coachRow),
    row(""),
  ];
  process.stdout.write(out.join("\n") + "\n");
}
main();
