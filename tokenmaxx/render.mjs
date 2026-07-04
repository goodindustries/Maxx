#!/usr/bin/env node
/**
 * maxx statusline renderer — the LOOK, in Node (no binary, no build step).
 *
 * Reads Claude Code's stdin JSON (rate_limits.five_hour/seven_day = the real
 * session/weekly walls, same numbers as /usage) + ~/.tokenmaxx/state.json the brain
 * writes (advice / intent / presence), then paints the cockpit: M mark │ gauges │ coach.
 *
 * Ships as plain Node because the rest of maxx already needs Node (the /maxx skill
 * and the coach hook) — so there's nothing extra to install, and nothing to compile
 * or cross-build. A tiny ANSI compositor stands in for lipgloss.
 */
import { readFileSync, writeFileSync } from "node:fs";
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
function hex2hsl(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return { h: h * 360, s, l };
}
function shade(hex, dl) { const { h, s, l } = hex2hsl(hex); return hsl2hex(h, s, Math.max(0, Math.min(1, l + dl))); }

const hsl = hsl2hex;
const BRAND = hsl(270, 0.58, 0.52);
const DIM   = hsl(270, 0.30, 0.50);
const TRACK = hsl(270, 0.35, 0.80);
const BG    = hsl(270, 0.55, 0.88);
const GREEN = "#2fa84a";
const AMBER = "#d69e2e";
const RED   = "#e0433c";
const BORDER = hsl(270, 0.5, 0.42);

// ─── ANSI: every glyph carries the panel bg so the band stays unbroken ─────────
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
function esc(fgHex, bgHex, s) {
  const [fr, fgg, fb] = rgb(fgHex), [br, bgg, bb] = rgb(bgHex);
  return `\x1b[38;2;${fr};${fgg};${fb};48;2;${br};${bgg};${bb}m${s}\x1b[0m`;
}
const fg = (c, s) => esc(c, BG, s);
const fg2 = (fc, bc, s) => esc(fc, bc, s); // for a gauge's partial cell (rail behind)

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

// ─── the beveled M: top-lit gradient + a diagonal shine that sweeps with phase ──
const mPattern = ["█   █", "██ ██", "█ █ █", "█   █", "█   █"];
function mMarkRows(phase) {
  return mPattern.map((row, r) => [...row].map((ch, c) => {
    if (ch !== "█") return fg(BG, " ");
    const base = 0.66 - 0.26 * (r / 4);
    const shine = Math.max(0, 1 - Math.abs((c - r) - phase) / 1.5);
    const l = Math.min(0.98, base + 0.30 * shine);
    return fg(hsl(270, 0.64, l), "█");
  }).join(""));
}

// ─── gauge: smooth sub-cell gradient rail (the lipgloss/true-color payoff) ──────
const eighths = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
function gauge(frac, width, col) {
  frac = Math.max(0, Math.min(1, frac));
  const units = frac * width;
  const whole = Math.floor(units);
  const grad = (i) => shade(col, -0.14 + 0.24 * (width > 1 ? i / (width - 1) : 0));
  let out = "";
  for (let i = 0; i < whole; i++) out += fg(grad(i), "█");
  let used = whole;
  if (whole < width) {
    const e = Math.round((units - whole) * 8);
    if (e > 0) { out += fg2(grad(whole), TRACK, eighths[e]); used++; }
  }
  if (used < width) out += fg(TRACK, "█".repeat(width - used));
  return out;
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

// ─── sidecar state ─────────────────────────────────────────────────────────────
const HOME = homedir();
const readJSON = (p, d = {}) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return d; } };
const statePath = path.join(HOME, ".tokenmaxx", "state.json");
const sprintPath = path.join(HOME, ".tokenmaxx", "sprint.json");

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
  let cols = parseInt(process.env.COLUMNS || "130", 10) || 130;

  const st = readJSON(statePath);
  const cw_ = p.context_window || {};
  const ctxPct = cw_.used_percentage || 0;
  const cu = cw_.current_usage || {};
  const total = (cu.input_tokens || 0) + (cu.cache_read_input_tokens || 0) + (cu.cache_creation_input_tokens || 0);
  const cache = total > 0 ? (cu.cache_read_input_tokens || 0) / total : 0;

  const rl = p.rate_limits || {};
  const haveQuota = !!rl.five_hour, haveWeek = !!rl.seven_day;
  const quota = haveQuota ? (rl.five_hour.used_percentage || 0) / 100 : 0;
  const week = haveWeek ? (rl.seven_day.used_percentage || 0) / 100 : 0;
  const qReset = haveQuota ? rl.five_hour.resets_at : 0;
  const wReset = haveWeek ? rl.seven_day.resets_at : 0;

  const usd = (p.cost || {}).total_cost_usd || 0;
  const fam = modelFamily((p.model || {}).display_name);
  const branch = gitBranch((p.workspace || {}).project_dir || "");

  const sp = readJSON(sprintPath);
  const { left, start: sprintStart } = sprintTimer(sp);
  try { writeFileSync(sprintPath, JSON.stringify(sp)); } catch {}

  const col = (v) => (v >= 0.9 ? RED : v >= 0.75 ? AMBER : GREEN);
  const qcol = col(quota), wcol = col(week);
  let tword = "cool", tcol = GREEN;
  if (cache < 0.6) { tword = "hot"; tcol = RED; } else if (cache < 0.85) { tword = "warm"; tcol = AMBER; }
  let hcol = GREEN;
  if (quota >= 0.9 || week >= 0.9) hcol = RED;
  else if (quota >= 0.75 || week >= 0.75 || cache < 0.6) hcol = AMBER;

  // narrow terminal: one compact line
  if (cols < 88) {
    let l = fg(hcol, "●");
    if (haveQuota) l += " " + gauge(quota, 6, qcol) + fg(qcol, ` ${Math.floor(quota * 100)}%`);
    l += fg(DIM, "  ") + fg(tcol, tword);
    const [ct, cc] = coachLine(st, ctxPct, sprintStart);
    l += fg(DIM, "  ") + fg(cc, trunc(ct, cols - 22));
    process.stdout.write(padLine(l, cols) + "\n");
    return;
  }

  let pw = Math.max(55, cols - 3);
  const inner = pw - 4, mW = 5;
  let cw = Math.floor(inner * 42 / 100); cw = Math.max(34, Math.min(64, cw));
  const hw = Math.max(12, inner - mW - cw - 6);
  let gw = cw - 24; gw = Math.max(8, Math.min(26, gw));

  const qv = haveQuota ? `${Math.floor(quota * 100)}%` : "—";
  const wv = haveWeek ? `${Math.floor(week * 100)}%` : "—";
  const qr = resetIn(qReset) ? " " + resetIn(qReset) : "";
  const wr = resetIn(wReset) ? " " + resetIn(wReset) : "";
  const scol = left <= 5 ? AMBER : DIM;
  const bcap = Math.max(12, cw - 18);
  const meta = fam + (branch ? " · " + trunc(branch, bcap) : "");

  const crow = [
    fg(hcol, "● ") + fg(DIM, "session ") + gauge(quota, gw, qcol) + fg(qcol, " " + qv) + fg(DIM, qr),
    fg(DIM, "  weekly  ") + gauge(week, gw, wcol) + fg(wcol, " " + wv) + fg(DIM, wr),
    fg(DIM, "  temp    ") + fg(tcol, tword), // a word, not a gauge: full temp = good, full session = bad
    fg(DIM, "  " + meta) + fg(scol, `  sprint ${left}m`),
    fg(DIM, `  $${Math.round(usd)} · ctx ${Math.floor(ctxPct)}%`),
  ];

  let [ctext, ccol] = coachLine(st, ctxPct, sprintStart);
  if (hcol === GREEN && ccol === AMBER) ccol = BRAND; // cool state → calm, no orange
  const thoughtRows = pane(wrap("▸ " + ctext, hw).map((l) => fg(ccol, l)), hw, 4, "center", "center");
  let foot = "thanks for using /maxx";
  const pp = st.pres_people || 0, pc = st.pres_countries || 0;
  if (pp > 0 && pc > 0) foot = `${pp} maxxing · ${pc} countries · ${foot}`;
  const coachRows = [...thoughtRows, padLine(fg(DIM, trunc(foot, hw)), hw, "right")];

  const phase = (Math.floor(Date.now() / 1000) % 8) - 4;
  const sep = Array(5).fill(fg(DIM, " │ "));
  const row = joinH(
    pane(mMarkRows(phase), mW, 5), sep,
    pane(crow, cw, 5), sep, coachRows,
  );

  // rounded border with the panel bg, padding(0,1)
  const line = (s) => fg(BORDER, "│") + blank(1) + padLine(s, inner) + blank(1) + fg(BORDER, "│");
  const bar = (l, r) => fg(BORDER, l + "─".repeat(inner + 2) + r);
  const out = [bar("╭", "╮"), ...row.map(line), bar("╰", "╯")];
  process.stdout.write(out.join("\n") + "\n");
}
main();
