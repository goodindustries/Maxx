#!/usr/bin/env node
/**
 * maxx rate-limit watchdog — the solo wall that actually hurts.
 *
 * Claude's plan limits are ~5-hour rolling windows. This sums your token usage in
 * the last 5h across ALL sessions, measures your burn rate, and calibrates the cap
 * from YOUR OWN history (the biggest 5h window you've ever sustained ≈ your real
 * ceiling — where you got throttled). No opaque published number, no guess.
 *
 *   node limit.mjs            # write ~/.maxx/window.json (the cache the bar reads)
 *   node limit.mjs --json     # print the report
 *
 * Usage/timing metadata only.
 */
import { createReadStream, writeFileSync, mkdirSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import path from "node:path";

const HOME = homedir();
const PROJECTS = path.join(HOME, ".claude", "projects");
const OUT = path.join(HOME, ".maxx", "window.json");
const CONFIG = path.join(HOME, ".maxx", "config.json");
const RL = path.join(HOME, ".maxx", "rl.json");   // render drops the live %s here to anchor caps
const CURSOR = path.join(HOME, ".maxx", "scan.json"); // per-file byte offsets for the incremental tail
const WINDOW_MS = 5 * 60 * 60 * 1000;     // Claude's ~5-hour limit window
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;  // the 7-day wall
const BUCKET_MS = 30 * 1000;              // 30-sec buckets: fine enough that the momentum + recovery step every ~30s, still cheap to re-sum every render tick

async function files(dir) {
  const out = [];
  async function walk(d) {
    let es; try { es = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) await walk(f);
      else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(f);
    }
  }
  await walk(dir);
  return out;
}

// one transcript line → [ts, weightedTokens] or null. weight by quota pressure: cache-reads
// are cheap (~0.1x) and barely count toward the limit, so a high-cache session shouldn't look
// like it's burning fast. Shared by the full scan and the incremental tail.
function parseLine(line, seen) {
  if (!line || line[0] !== "{") return null;
  let r; try { r = JSON.parse(line); } catch { return null; }
  const u = r?.message?.usage; if (!u) return null;
  const tok = (u.input_tokens || 0) + (u.output_tokens || 0)
            + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) * 0.1;
  if (!tok) return null;
  const id = r.requestId || r.uuid; if (id && seen) { if (seen.has(id)) return null; seen.add(id); }
  const ts = r.timestamp ? Date.parse(r.timestamp) : NaN;
  return Number.isFinite(ts) ? [ts, tok] : null;
}

// collect (ts, tokens) for every billed turn across all sessions — the authoritative full scan.
async function collect() {
  const pts = [];
  const seen = new Set();
  for (const f of await files(PROJECTS)) {
    let rl;
    try { rl = createInterface({ input: createReadStream(f, { encoding: "utf8" }), crlfDelay: Infinity }); }
    catch { continue; }
    for await (const line of rl) { const p = parseLine(line, seen); if (p) pts.push(p); }
  }
  pts.sort((a, b) => a[0] - b[0]);
  return pts;
}

// the incremental tail: read only bytes appended since the last run (per-file byte offsets in
// scan.json). Only the active session file grows, so a refresh reads a few KB, not 11B tokens.
// Returns { pts, offsets } — pts are the new turns since last scan. Partial trailing line (a
// half-written record) is left unconsumed; its offset stays put so next run picks it up whole.
async function collectIncremental(offsets) {
  const pts = [];
  const newOff = { ...offsets };
  const seen = new Set();
  for (const f of await files(PROJECTS)) {
    let size; try { size = statSync(f).size; } catch { continue; }
    let off = offsets[f] || 0;
    if (off > size) off = 0;                 // truncated / rotated → reread whole
    if (off === size) { newOff[f] = size; continue; }
    const len = size - off;
    const buf = Buffer.allocUnsafe(len);
    let fd, got = 0;
    try { fd = openSync(f, "r"); got = readSync(fd, buf, 0, len, off); } catch { continue; }
    finally { if (fd !== undefined) closeSync(fd); }
    const chunk = buf.toString("utf8", 0, got);
    const lastNl = chunk.lastIndexOf("\n");
    if (lastNl < 0) { newOff[f] = off; continue; }          // no complete line yet
    const complete = chunk.slice(0, lastNl);
    newOff[f] = off + Buffer.byteLength(complete, "utf8") + 1; // advance past the last newline
    for (const line of complete.split("\n")) { const p = parseLine(line, seen); if (p) pts.push(p); }
  }
  return { pts, offsets: newOff };
}

// merge new (ts, tok) points into an existing bucket array, re-binning and dropping >7d buckets.
function mergeBuckets(base, pts, now) {
  const cutoff = now - WEEK_MS;
  const m = new Map();
  for (const [t, k] of base) if (t > cutoff) m.set(t, k);
  for (const [ts, tok] of pts) {
    if (ts <= cutoff) continue;
    const b = Math.floor(ts / BUCKET_MS) * BUCKET_MS;
    m.set(b, (m.get(b) || 0) + tok);
  }
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([t, k]) => [t, Math.round(k)]);
}

function readJSON(p, d) { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return d; } }

// biggest token sum over any `win`-ms span in history = your sustained ceiling
function historicalPeak(pts, win = WINDOW_MS) {
  let peak = 0, sum = 0, i = 0;
  for (let j = 0; j < pts.length; j++) {
    sum += pts[j][1];
    while (pts[i][0] < pts[j][0] - win) { sum -= pts[i][1]; i++; }
    if (sum > peak) peak = sum;
  }
  return peak;
}

// ROLL-SESSION — the safe spend for THIS 5h window = weekly-tokens-LEFT ÷ 5h-windows-left, capped at the
// raw 5h wall. THIS is the number a governor gates on: cap an unattended/overnight agent to its sustainable
// per-window share and the week never drains in one burst — yet it can still run all night, and if it banks
// (underspends a window) the share climbs so it can burst later. Everything anchored to Anthropic's %s.
export function rollSession(cap5, cap7, used5, weekUsed, weekResetAt, now) {
  const weekLeftSec = weekResetAt ? Math.max(0, weekResetAt - now / 1000) : 0;
  const sessionsLeft = Math.max(1, weekLeftSec / (5 * 3600));         // 5h windows until the weekly resets
  const weekLeft = Math.max(0, (cap7 || 0) - weekUsed);
  const safe = (cap7 && weekResetAt) ? Math.min(cap5 || Infinity, Math.round(weekLeft / sessionsLeft)) : (cap5 || 0);
  return {
    sessionSafe: safe,                                 // tokens good to use this 5h window
    sessionToSpend: Math.max(0, safe - used5),         // headroom left this window (0 → governor should pause)
    sessionOver: Math.max(0, used5 - safe),            // spent past the safe share (governor blocks when > 0)
    sessionsLeft: Math.round(sessionsLeft * 10) / 10,
  };
}

function report(pts, now, weekLo = now - WEEK_MS, quota = 0, week = 0, weekResetAt = 0) {
  const used = pts.filter(([t]) => t > now - WINDOW_MS).reduce((a, [, k]) => a + k, 0);
  // burn = tokens in the last 30 min, extrapolated to /hr
  const recent = pts.filter(([t]) => t > now - 30 * 60000).reduce((a, [, k]) => a + k, 0);
  const burnPerHr = recent * 2;
  const peak = historicalPeak(pts);
  // 5h cap ANCHORED to Anthropic's authoritative 5h % (rl.json quota): cap = used ÷ realPct, so pct reads
  // back the exact % /usage shows. Falls back to config/peak only with no live % (never a hardcoded guess).
  let cap, pct;
  if (quota > 0.01) { cap = Math.round(used / quota); pct = quota; }
  else {
    try { cap = JSON.parse(readFileSync(CONFIG, "utf8")).window_cap_tokens || null; } catch { cap = null; }
    if (!cap) cap = Math.round(peak * 1.05);
    pct = cap ? used / cap : null;
  }
  const minsToCap = (cap && burnPerHr > 0 && used < cap) ? Math.round((cap - used) / burnPerHr * 60) : null;
  // window reset: when the oldest token in the window ages out
  const inWin = pts.filter(([t]) => t > now - WINDOW_MS);
  const resetInMins = inWin.length ? Math.max(0, Math.round((inWin[0][0] + WINDOW_MS - now) / 60000)) : 0;
  // weekly limit — the other Claude plan wall. Anthropic's is a FIXED window that zeroes at resets_at, not a
  // rolling sum, so cut at the window start (weekLo = resets_at − 7d). Cap ANCHORED to Anthropic's 7d %:
  // weekCap = used ÷ realPct, weekPct = the real %. Consumers MUST gate on weekPct / sessionOver — NEVER a
  // raw bucket sum ÷ a hardcoded cap (that read 760M ÷ 750M = 101% and false-blocked at a real 37%).
  const weekUsed = pts.filter(([t]) => t > weekLo).reduce((a, [, k]) => a + k, 0);
  let weekCap, weekPct;
  if (week > 0.01) { weekCap = Math.round(weekUsed / week); weekPct = week; }
  else {
    try { weekCap = JSON.parse(readFileSync(CONFIG, "utf8")).week_cap_tokens || null; } catch { weekCap = null; }
    if (!weekCap) weekCap = Math.round(historicalPeak(pts, WEEK_MS) * 1.05);
    weekPct = weekCap ? weekUsed / weekCap : null;
  }
  const roll = rollSession(cap, weekCap, used, weekUsed, weekResetAt, now);
  return { used, cap, peak, pct, burnPerHr, minsToCap, resetInMins, weekUsed, weekCap, weekPct, weekResetAt, ...roll, ts: now };
}

// bucket the last 7d of (ts, tokens) into 5-min bins so the renderer can re-sum the rolling
// window against the live clock each tick — that's what makes "idle → the bar recovers" real.
function bucketize(pts, now) {
  const cutoff = now - WEEK_MS, m = new Map();
  for (const [ts, tok] of pts) {
    if (ts <= cutoff) continue;
    const b = Math.floor(ts / BUCKET_MS) * BUCKET_MS;
    m.set(b, (m.get(b) || 0) + tok);
  }
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([t, k]) => [t, Math.round(k)]);
}

// ─── --nazi: an hourly posture check an AGENT runs on itself ──────────────────────────────────────
// Reads what maxx already knows — status.json (ctx/cache/model/sessions), window.json (roll-session +
// weekPct + burn history), CLAUDE.md sizes (the always-on context tax) — and returns ranked token
// drains + the one highest-leverage lever for this hour. Machine `NAZI …` first line for grepping.
function fileTok(p) { try { return Math.round(readFileSync(p, "utf8").length / 4); } catch { return 0; } }
function nazi(wantJSON) {
  const num = (x) => Math.round(x || 0).toLocaleString("en-US");
  const tk = (x) => Math.round(Math.abs(x || 0) / 1000).toLocaleString("en-US") + "k";
  const st = readJSON(path.join(HOME, ".maxx", "status.json"), null);
  if (!st) {
    const msg = "token nazi — no status yet. Open Claude Code so the statusline writes ~/.maxx/status.json, then retry.";
    process.stdout.write((wantJSON ? JSON.stringify({ error: "no-status" }) : msg) + "\n"); return;
  }
  const S = st.session || {}, W = st.weekly || {};
  const win = readJSON(OUT, null);
  let burn1h = 0, burn6h = 0, burnPrev1h = 0;
  if (win && Array.isArray(win.buckets)) {
    const n0 = Date.now(), sum = (lo, hi) => win.buckets.reduce((s, b) => (b[0] > n0 - hi && b[0] <= n0 - lo ? s + b[1] : s), 0);
    burn1h = sum(0, 3600e3); burnPrev1h = sum(3600e3, 7200e3); burn6h = sum(0, 6 * 3600e3);
  }
  const trend = burn1h > burnPrev1h * 1.25 ? "rising" : burn1h < burnPrev1h * 0.75 ? "cooling" : "steady";
  const cwd = process.cwd();
  const mdFiles = [
    ["global CLAUDE.md", path.join(HOME, ".claude", "CLAUDE.md")],
    ["global RTK.md", path.join(HOME, ".claude", "RTK.md")],
    ["repo CLAUDE.md", path.join(cwd, "CLAUDE.md")],
  ].map(([label, p]) => ({ label, tok: fileTok(p) })).filter((f) => f.tok > 0);
  const claudeMdTok = mdFiles.reduce((s, f) => s + f.tok, 0);
  const ctxPct = st.ctxPct || 0, cachePct = st.cachePct ?? 100, sessions = st.sessions || 1, model = st.model || "?";
  const sessOver = (S.over || 0) > 0;
  const weekHot = (W.usedPct || 0) > (W.elapsedPct || 0) + 5 && (W.usedPct || 0) >= 50;
  const verdict = sessOver || (W.usedPct || 0) >= 90 ? "over" : weekHot || (S.usedPct || 0) >= 90 ? "hot" : "ok";
  const drains = [];
  if (model === "Opus") drains.push({ sink: "model", detail: "Opus burns the quota fastest", lever: "drop to Sonnet for routine work (one keystroke)", weight: sessOver || weekHot ? 90 : 55 });
  if (sessions > 1) drains.push({ sink: "sessions", detail: `${sessions} sessions burning in parallel → ~${sessions}× the rate`, lever: `close the ${sessions - 1} you're not driving`, weight: 40 + sessions * 12 });
  if (cachePct < 85) drains.push({ sink: "cache", detail: `cache ${cachePct}% — misses pay full freight`, lever: "stop rewriting early context; append instead of editing history", weight: cachePct < 60 ? 80 : 45 });
  if (ctxPct >= 65) drains.push({ sink: "context", detail: `context ${ctxPct}% full — every turn re-sends it all`, lever: "commit at a clean stop, then /compact", weight: ctxPct >= 85 ? 85 : 50 });
  if (claudeMdTok >= 4000) drains.push({ sink: "claude.md", detail: `~${tk(claudeMdTok)} tokens of CLAUDE.md loaded EVERY message`, lever: "trim/compress the global + repo instructions", weight: 30 + Math.min(30, claudeMdTok / 400) });
  if (trend === "rising") drains.push({ sink: "trend", detail: `burn rising — ${tk(burn1h)}/hr vs ${tk(burnPrev1h)}/hr prior`, lever: "you're accelerating; ease off or you'll hit the wall early", weight: 60 });
  drains.sort((a, b) => b.weight - a.weight);
  const topMove = drains[0]?.lever || (verdict === "ok" ? "on track — keep shipping the smallest thing that works" : "wrap up cleanly before the wall");
  const machine = `NAZI verdict=${verdict} weekly_left=${W.headroom || 0} weekly_pct=${W.usedPct || 0} session_tospend=${S.toSpend || 0} session_permin=${S.spendPerMin || 0} ctx_pct=${ctxPct} cache_pct=${cachePct} claudemd_tok=${claudeMdTok} sessions=${sessions} model=${model} burn_1h=${Math.round(burn1h)} burn_6h=${Math.round(burn6h)} trend=${trend} top_lever="${topMove}"`;
  if (wantJSON) {
    process.stdout.write(JSON.stringify({
      verdict, weekly: { left: W.headroom || 0, usedPct: W.usedPct || 0, resetIn: W.resetIn || "?" },
      session: { name: "session", fuel: S.toSpend || 0, perMin: S.spendPerMin || 0, over: S.over || 0, resetIn: S.resetIn || "?" },
      burn: { last1h: Math.round(burn1h), last6h: Math.round(burn6h), trend },
      context: { ctxPct, cachePct, claudeMdTok, claudeMdFiles: mdFiles }, sessions, model, drains, topMove,
    }, null, 2) + "\n"); return;
  }
  const L = [machine, "", `token nazi — hourly posture  ·  verdict: ${verdict.toUpperCase()}`, "",
    `  week          ${num(W.headroom)} left  ·  ${W.usedPct || 0}% used  ·  resets ${W.resetIn || "?"}`,
    sessOver ? `  session       ${num(S.over)} over your paced share  ·  ease off (tank refuels as usage ages out)  ·  ${S.resetIn || "?"}`
             : `  session       ${num(S.toSpend)} tokens  ·  ~${num(S.spendPerMin)}/min even burn  ·  rolling 5h`,
    `  burn          ${tk(burn1h)}/hr now  ·  ${tk(burn6h)} last 6h  ·  ${trend}`, ""];
  if (drains.length) { L.push("  biggest drains (highest leverage first):"); for (const d of drains) L.push(`    · ${d.sink.padEnd(9)} ${d.detail}  →  ${d.lever}`); }
  else L.push("  no standout drains — cache warm, context light, single session.");
  L.push("", `  do this hour →  ${topMove}`);
  process.stdout.write(L.join("\n") + "\n");
}

async function main() {
  const now = Date.now();
  if (process.argv.includes("--nazi")) { nazi(process.argv.includes("--json")); return; }
  // anchor the token caps to Claude's authoritative %s (render drops them in rl.json): with
  // cap = burned / used%, the token gauge reads exactly the real % — weighting quirks cancel.
  let quota = 0, week = 0, weekResetAt = 0;
  try { const rl = JSON.parse(readFileSync(RL, "utf8")); quota = rl.quota || 0; week = rl.week || 0; weekResetAt = rl.weekResetAt || 0; } catch {}
  // weekly window start = Anthropic's reset − 7d; max() never loosens past the rolling 7d, so a
  // stale/absent resets_at just falls back to the old behavior.
  const weekLo = Math.max(now - WEEK_MS, weekResetAt ? weekResetAt * 1000 - WEEK_MS : 0);

  // --json prints the full report (authoritative scan); other invocations refresh window.json.
  if (process.argv.includes("--json")) {
    const r = report(await collect(), now, weekLo, quota, week, weekResetAt);
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  const cursor = readJSON(CURSOR, null);
  const forceFull = process.argv.includes("--full");
  let buckets, offsets;
  if (forceFull || !cursor) {
    // seed (first run) or periodic reconcile: authoritative full scan, then snapshot offsets so
    // subsequent runs only tail the growth.
    const pts = await collect();
    buckets = bucketize(pts, now);
    offsets = {};
    for (const f of await files(PROJECTS)) { try { offsets[f] = statSync(f).size; } catch {} }
  } else {
    // hot path: tail only appended bytes and fold them into the cached buckets.
    const prev = readJSON(OUT, {});
    const { pts, offsets: off } = await collectIncremental(cursor.offsets || {});
    buckets = mergeBuckets(prev.buckets || [], pts, now);
    offsets = off;
  }

  // re-anchor caps against the freshly-summed window each run (quota comes from the live bar).
  const prev = readJSON(OUT, {});
  let used = 0, weekUsed = 0;
  for (const [t, k] of buckets) { if (t > now - WINDOW_MS) used += k; if (t > weekLo) weekUsed += k; }
  const cap5 = quota > 0.01 ? Math.round(used / quota) : (prev.cap5 || Math.round(used * 1.05) || 1);
  const cap7 = week  > 0.01 ? Math.round(weekUsed / week) : (prev.cap7 || Math.round(weekUsed * 1.05) || 1);
  // the roll-session gate, written into the cache so a governor reads the SAFE per-window spend directly —
  // no re-summing raw buckets, no hardcoded cap. Gate on sessionOver > 0 (or sessionToSpend === 0) to pause
  // an unattended agent until the 5h window resets; weekPct is the authoritative weekly % (= /usage).
  const roll = rollSession(cap5, cap7, used, weekUsed, weekResetAt, now);
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ buckets, cap5, cap7, used5: used, weekUsed, weekPct: week, weekResetAt, ...roll, ts: now }));
  writeFileSync(CURSOR, JSON.stringify({ offsets, ts: now }));
}
// run only when invoked directly (CLI / statusline), not when imported by a test.
if (process.argv[1] && process.argv[1].endsWith("limit.mjs")) {
  main().catch(e => { process.stderr.write("limit: " + e.message + "\n"); process.exit(1); });
}
