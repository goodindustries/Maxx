#!/usr/bin/env node
/**
 * maxx watch — live terminal tail of the central budget tally.
 *
 * Polls the deployed tally (api.meetmaxx.co) and renders, refreshing in place:
 *   - the running account-wide total (all surfaces summed),
 *   - each surface's live contribution,
 *   - a tail of the most recent emits as they land,
 *   - all measured against your /usage anchor (the % + remaining the statusline shows).
 *
 * One command:  node ~/Classified/Maxx/maxx/watch.mjs
 * Reads ~/.maxx/config.json for handle + secret + logsUrl. Ctrl-C to stop.
 *   --once   print one frame and exit (for piping)
 *   --every N   refresh seconds (default 2)
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const cfg = (() => { try { return JSON.parse(readFileSync(path.join(homedir(), ".maxx", "config.json"), "utf8")); } catch { return {}; } })();
const HANDLE = cfg.handle || "unknown";
const SECRET = cfg.secret || "";
const BASE = (process.env.MAXX_LOGS_URL || cfg.logsUrl || "https://api.meetmaxx.co").replace(/\/$/, "");
const args = process.argv.slice(2);
const ONCE = args.includes("--once");
const EVERY = (() => { const i = args.indexOf("--every"); return i >= 0 ? Number(args[i + 1]) || 2 : 2; })();

const C = { dim: "\x1b[2m", rst: "\x1b[0m", b: "\x1b[1m", grn: "\x1b[32m", yel: "\x1b[33m", red: "\x1b[31m", cyn: "\x1b[36m", mag: "\x1b[35m" };
const fmt = (n) => { n = Number(n) || 0; const a = Math.abs(n); return (n < 0 ? "-" : "") + (a >= 1e9 ? (a / 1e9).toFixed(2) + "B" : a >= 1e6 ? (a / 1e6).toFixed(1) + "M" : a >= 1e3 ? Math.round(a / 1e3) + "k" : String(Math.round(a))); };
const pct = (f) => (f == null ? "—" : Math.round(f * 100) + "%");
const ago = (iso) => { const s = (Date.now() - Date.parse(iso)) / 1000; return s < 60 ? Math.round(s) + "s" : s < 3600 ? Math.round(s / 60) + "m" : Math.round(s / 3600) + "h"; };
const dur = (sec) => { if (!sec || sec < 0) return "—"; const h = sec / 3600; return h < 48 ? Math.round(h) + "h" : Math.round(h / 24) + "d"; };
const bar = (frac, w = 22) => { const f = Math.max(0, Math.min(1, frac || 0)); const on = Math.round(f * w); const col = f >= 0.95 ? C.red : f >= 0.8 ? C.yel : C.grn; return col + "█".repeat(on) + C.dim + "░".repeat(w - on) + C.rst; };

async function get(pathq) {
  const u = `${BASE}${pathq}${pathq.includes("?") ? "&" : "?"}k=${encodeURIComponent(SECRET)}`;
  const res = await fetch(u, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${res.status} ${pathq}`);
  return res.json();
}

let lastCount = null;
async function frame() {
  let b, feed;
  try { [b, feed] = await Promise.all([get(`/api/u/${HANDLE}/budget`), get(`/api/u/${HANDLE}/feed?n=14`)]); }
  catch (e) { return `${C.red}maxx watch — cannot reach ${BASE}: ${e.message}${C.rst}\n`; }

  const now = new Date().toLocaleTimeString();
  const anchorTag = b.fresh ? `${C.grn}anchor ${b.anchor_age_sec != null ? Math.round(b.anchor_age_sec / 60) + "m" : "?"} ago · fresh${C.rst}`
    : `${C.red}anchor ${b.anchor_age_sec != null ? Math.round(b.anchor_age_sec / 60) + "m" : "?"} ago · STALE${C.rst}`;
  const vColor = b.verdict === "ok" ? C.grn : C.red;
  const L = [];
  L.push(`${C.b}${C.mag} ⩗ MAXX LIVE${C.rst}  ${C.dim}·${C.rst} ${HANDLE}  ${C.dim}·${C.rst} ${now}  ${C.dim}·${C.rst} ${BASE.replace(/^https?:\/\//, "")}   ${anchorTag}`);
  L.push(C.dim + "─".repeat(74) + C.rst);
  // vs /usage anchor
  L.push(` ${C.b}WEEK${C.rst}   ${bar(b.week)}  ${C.b}${pct(b.week)}${C.rst} used  ${C.dim}·${C.rst}  ${C.cyn}${fmt(b.weekly_left_tokens)} left${C.rst}  ${C.dim}·${C.rst}  reset ${dur(b.week_reset ? b.week_reset - Date.now() / 1000 : 0)}  ${C.dim}·${C.rst}  verdict ${vColor}${b.verdict}${C.rst}`);
  L.push(` ${C.b}5h  ${C.rst}   ${bar(b.quota)}  ${C.b}${pct(b.quota)}${C.rst} used  ${C.dim}·${C.rst}  safe: ${C.cyn}${fmt(b.session_to_spend)}${C.rst}${b.session_burst != null ? `${C.dim} · burst ${C.rst}${fmt(b.session_burst)}${C.dim} to 5h wall${C.rst}` : ""}`);
  L.push(` ${C.dim}running total: ${fmt(b.week_billed)} billed this week · ${fmt(b.five_billed)} in 5h · summed across all surfaces${C.rst}`);
  L.push(C.dim + "─".repeat(74) + C.rst);
  // surfaces
  L.push(` ${C.b}SURFACES${C.rst} ${C.dim}(5h billed)${C.rst}`);
  const surfaces = (b.surfaces || []).slice(0, 8);
  if (!surfaces.length) L.push(`   ${C.dim}(none active in 5h)${C.rst}`);
  for (const s of surfaces) {
    const isCloud = s.surface.startsWith("cloud:");
    L.push(`   ${(isCloud ? C.mag : C.cyn)}${s.surface.padEnd(28)}${C.rst} ${fmt(s.billed_5h).padStart(8)}`);
  }
  L.push(C.dim + "─".repeat(74) + C.rst);
  // live feed
  const isNew = lastCount != null && feed.count > lastCount;
  L.push(` ${C.b}LIVE EMITS${C.rst} ${C.dim}(newest first · total events ${feed.count})${C.rst}${isNew ? `  ${C.grn}▲ +${feed.count - lastCount} new${C.rst}` : ""}`);
  for (const e of (feed.events || []).slice(0, 12)) {
    const cloud = e.surface.startsWith("cloud:");
    const models = Object.keys(e.by_model || {}).join("+");
    const who = [e.project, e.name].filter(Boolean).join(" — ").slice(0, 30);
    L.push(`   ${C.dim}${ago(e.ts).padStart(4)} ago${C.rst}  ${(cloud ? C.mag : C.cyn)}${e.surface.slice(0, 16).padEnd(16)}${C.rst}  ${C.grn}+${fmt(e.billed).padStart(7)}${C.rst}  ${who}${models ? `${C.dim} (${models})${C.rst}` : ""}`);
  }
  lastCount = feed.count;
  L.push("");
  L.push(`${C.dim} tally anchored to your /usage — WEEK % here should match the statusline. Ctrl-C to stop.${C.rst}`);
  return L.join("\n") + "\n";
}

if (ONCE) { process.stdout.write(await frame()); process.exit(0); }
process.stdout.write("\x1b[?25l"); // hide cursor
const render = async () => { const f = await frame(); process.stdout.write("\x1b[2J\x1b[H" + f); };
process.on("SIGINT", () => { process.stdout.write("\x1b[?25h\n"); process.exit(0); });
await render();
setInterval(render, EVERY * 1000);
