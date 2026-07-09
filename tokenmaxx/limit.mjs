#!/usr/bin/env node
/**
 * maxx rate-limit watchdog — the solo wall that actually hurts.
 *
 * Claude's plan limits are ~5-hour rolling windows. This sums your token usage in
 * the last 5h across ALL sessions, measures your burn rate, and calibrates the cap
 * from YOUR OWN history (the biggest 5h window you've ever sustained ≈ your real
 * ceiling — where you got throttled). No opaque published number, no guess.
 *
 *   node limit.mjs            # write ~/.tokenmaxx/window.json (the cache the bar reads)
 *   node limit.mjs --json     # print the report
 *
 * Usage/timing metadata only.
 */
import { createReadStream, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import path from "node:path";

const HOME = homedir();
const PROJECTS = path.join(HOME, ".claude", "projects");
const OUT = path.join(HOME, ".tokenmaxx", "window.json");
const CONFIG = path.join(HOME, ".tokenmaxx", "config.json");
const RL = path.join(HOME, ".tokenmaxx", "rl.json");   // render drops the live %s here to anchor caps
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

// collect (ts, tokens) for every billed turn across all sessions
async function collect() {
  const pts = [];
  const seen = new Set();
  for (const f of await files(PROJECTS)) {
    let rl;
    try { rl = createInterface({ input: createReadStream(f, { encoding: "utf8" }), crlfDelay: Infinity }); }
    catch { continue; }
    for await (const line of rl) {
      if (!line || line[0] !== "{") continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      const u = r?.message?.usage; if (!u) continue;
      // weight by quota pressure: cache-reads are cheap (~0.1x) and barely count
      // toward the limit, so a high-cache session shouldn't look like it's burning fast.
      const tok = (u.input_tokens || 0) + (u.output_tokens || 0)
                + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) * 0.1;
      if (!tok) continue;
      const id = r.requestId || r.uuid; if (id) { if (seen.has(id)) continue; seen.add(id); }
      const ts = r.timestamp ? Date.parse(r.timestamp) : NaN;
      if (Number.isFinite(ts)) pts.push([ts, tok]);
    }
  }
  pts.sort((a, b) => a[0] - b[0]);
  return pts;
}

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

function report(pts, now) {
  const used = pts.filter(([t]) => t > now - WINDOW_MS).reduce((a, [, k]) => a + k, 0);
  // burn = tokens in the last 30 min, extrapolated to /hr
  const recent = pts.filter(([t]) => t > now - 30 * 60000).reduce((a, [, k]) => a + k, 0);
  const burnPerHr = recent * 2;
  const peak = historicalPeak(pts);
  let cap = null;
  try { cap = JSON.parse(readFileSync(CONFIG, "utf8")).window_cap_tokens || null; } catch {}
  if (!cap) cap = Math.round(peak * 1.05);   // your own ceiling, +5% headroom, until you set it
  const pct = cap ? used / cap : null;
  const minsToCap = (cap && burnPerHr > 0 && used < cap) ? Math.round((cap - used) / burnPerHr * 60) : null;
  // window reset: when the oldest token in the window ages out
  const inWin = pts.filter(([t]) => t > now - WINDOW_MS);
  const resetInMins = inWin.length ? Math.max(0, Math.round((inWin[0][0] + WINDOW_MS - now) / 60000)) : 0;
  // weekly limit — the other Claude plan wall (7-day rolling), same self-calibration
  const weekUsed = pts.filter(([t]) => t > now - WEEK_MS).reduce((a, [, k]) => a + k, 0);
  let weekCap = null;
  try { weekCap = JSON.parse(readFileSync(CONFIG, "utf8")).week_cap_tokens || null; } catch {}
  if (!weekCap) weekCap = Math.round(historicalPeak(pts, WEEK_MS) * 1.05);
  const weekPct = weekCap ? weekUsed / weekCap : null;
  return { used, cap, peak, pct, burnPerHr, minsToCap, resetInMins, weekUsed, weekCap, weekPct, ts: now };
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

async function main() {
  const now = Date.now();
  const pts = await collect();
  const r = report(pts, now);
  if (process.argv.includes("--json")) { console.log(JSON.stringify(r, null, 2)); return; }
  // anchor the token caps to Claude's authoritative %s (render drops them in rl.json): with
  // cap = burned / used%, the token gauge reads exactly the real % — weighting quirks cancel,
  // and the cap stays put between scans so a shrinking `burned` shows as recovery.
  let quota = 0, week = 0;
  try { const rl = JSON.parse(readFileSync(RL, "utf8")); quota = rl.quota || 0; week = rl.week || 0; } catch {}
  const cap5 = quota > 0.01 ? Math.round(r.used / quota) : r.cap;
  const cap7 = week > 0.01 ? Math.round(r.weekUsed / week) : r.weekCap;
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ buckets: bucketize(pts, now), cap5, cap7, ts: now }));
}
main().catch(e => { process.stderr.write("limit: " + e.message + "\n"); process.exit(1); });
