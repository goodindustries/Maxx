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
import { createReadStream, writeFileSync, mkdirSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import path from "node:path";

const HOME = homedir();
const PROJECTS = path.join(HOME, ".claude", "projects");
const OUT = path.join(HOME, ".tokenmaxx", "window.json");
const CONFIG = path.join(HOME, ".tokenmaxx", "config.json");
const RL = path.join(HOME, ".tokenmaxx", "rl.json");   // render drops the live %s here to anchor caps
const CURSOR = path.join(HOME, ".tokenmaxx", "scan.json"); // per-file byte offsets for the incremental tail
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

function report(pts, now, weekLo = now - WEEK_MS) {
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
  // weekly limit — the other Claude plan wall. Anthropic's is a FIXED window that zeroes at
  // resets_at, not a rolling sum, so cut at the window start (weekLo = resets_at − 7d passed in)
  // — else a pre-reset burst inflates cap7's anchor for up to 7 days after the wall reset.
  const weekUsed = pts.filter(([t]) => t > weekLo).reduce((a, [, k]) => a + k, 0);
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
  // anchor the token caps to Claude's authoritative %s (render drops them in rl.json): with
  // cap = burned / used%, the token gauge reads exactly the real % — weighting quirks cancel.
  let quota = 0, week = 0, weekResetAt = 0;
  try { const rl = JSON.parse(readFileSync(RL, "utf8")); quota = rl.quota || 0; week = rl.week || 0; weekResetAt = rl.weekResetAt || 0; } catch {}
  // weekly window start = Anthropic's reset − 7d; max() never loosens past the rolling 7d, so a
  // stale/absent resets_at just falls back to the old behavior.
  const weekLo = Math.max(now - WEEK_MS, weekResetAt ? weekResetAt * 1000 - WEEK_MS : 0);

  // --json prints the full report (authoritative scan); other invocations refresh window.json.
  if (process.argv.includes("--json")) {
    const r = report(await collect(), now, weekLo);
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
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ buckets, cap5, cap7, ts: now }));
  writeFileSync(CURSOR, JSON.stringify({ offsets, ts: now }));
}
main().catch(e => { process.stderr.write("limit: " + e.message + "\n"); process.exit(1); });
