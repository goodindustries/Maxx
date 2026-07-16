#!/usr/bin/env node
/**
 * maxx tracker — parse ~/.claude/projects/*.jsonl into a local stats card.
 *
 * Usage:
 *   node maxx/tracker.mjs            — pretty summary
 *   node maxx/tracker.mjs session    — delegate to render.mjs (how much to spend)
 *   node maxx/tracker.mjs --json     — machine-readable stats payload
 *   node maxx/tracker.mjs --dir PATH — override projects dir
 *
 * Fully on-box: reads only usage/token metadata, sends nothing anywhere, never
 * emits prompt or message content.
 */
import { createReadStream, realpathSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HOME = homedir();
const DEFAULT_DIR = path.join(HOME, ".claude", "projects");
const CONFIG_DIR = path.join(HOME, ".maxx"); // local state dir (window.json / rl.json) — read-only here

// ─── args ───────────────────────────────────────────────────────────────────
// forms:
//   (none)            → card
//   session [raw]     → delegate to render.mjs (--session / --status)
//   json | --json     → JSON payload
// flags: --dir PATH
function parseArgs(argv) {
  const out = { cmd: "card", dir: DEFAULT_DIR, raw: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "session") out.cmd = "session";
    else if (a === "raw") out.raw = true;
    else if (a === "--json" || a === "json") { if (out.cmd === "session") out.raw = true; else out.cmd = "json"; }
    else if (a === "--dir") out.dir = argv[++i];
    else rest.push(a);
  }
  return out;
}

// ─── walk projects dir for .jsonl session files ───────────────────────────────
async function findSessionFiles(dir) {
  const files = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files; // dir missing → empty
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      files.push(...(await findSessionFiles(full)));
    } else if (e.isFile() && e.name.endsWith(".jsonl")) {
      files.push(full);
    }
  }
  return files;
}

// ─── local YYYY-MM-DD from an ISO timestamp ───────────────────────────────────
function localDay(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ─── accumulate one session file into the running stats ───────────────────────
async function ingestFile(file, acc) {
  const rl = createInterface({
    input: createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line || line[0] !== "{") continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // skip malformed line, keep going
    }
    const usage = rec?.message?.usage;
    if (!usage) continue;

    const inp = usage.input_tokens || 0;
    const cc = usage.cache_creation_input_tokens || 0;
    const cr = usage.cache_read_input_tokens || 0;
    const out = usage.output_tokens || 0;
    const total = inp + cc + cr + out;
    if (total === 0) continue;

    // de-dupe: streaming can emit the same requestId multiple times
    const id = rec.requestId || rec.uuid;
    if (id) {
      if (acc.seen.has(id)) continue;
      acc.seen.add(id);
    }

    const day = localDay(rec.timestamp);
    if (!day) continue;

    acc.totals.input += inp;
    acc.totals.cacheCreate += cc;
    acc.totals.cacheRead += cr;
    acc.totals.output += out;
    acc.messages += 1;

    const d = acc.byDay.get(day) || { total: 0, output: 0, cacheRead: 0, cacheableInput: 0 };
    d.total += total;
    d.output += out;
    d.cacheRead += cr;
    d.cacheableInput += inp + cc + cr; // all input-side tokens
    acc.byDay.set(day, d);

    const model = rec?.message?.model || "unknown";
    acc.byModel.set(model, (acc.byModel.get(model) || 0) + total);

    if (rec.sessionId) acc.sessions.add(rec.sessionId);
  }
}

// ─── streak math over the set of active days ──────────────────────────────────
function computeStreaks(days) {
  if (days.length === 0) return { current: 0, longest: 0 };
  const set = new Set(days);
  const sorted = [...set].sort(); // ascending YYYY-MM-DD (lexical == chronological)

  const dayNum = (s) => {
    const [y, m, d] = s.split("-").map(Number);
    return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
  };

  // longest run of consecutive calendar days
  let longest = 1, run = 1;
  for (let i = 1; i < sorted.length; i++) {
    if (dayNum(sorted[i]) - dayNum(sorted[i - 1]) === 1) run += 1;
    else run = 1;
    if (run > longest) longest = run;
  }

  // current streak = consecutive days ending today or yesterday
  const today = localDay(new Date().toISOString());
  const todayNum = dayNum(today);
  const last = sorted[sorted.length - 1];
  const gap = todayNum - dayNum(last);
  let current = 0;
  if (gap <= 1) {
    current = 1;
    for (let i = sorted.length - 1; i > 0; i--) {
      if (dayNum(sorted[i]) - dayNum(sorted[i - 1]) === 1) current += 1;
      else break;
    }
  }
  return { current, longest };
}

// ─── live 5h session window ───────────────────────────────────────────────────
// The bar's watchdog (limit.mjs) caches the rolling 5h token window in window.json,
// and render.mjs drops the live rate-limit %s + reset time in rl.json. Reading both
// here lets /maxx (and any agent reading --json) see where the CURRENT session sits:
// tokens burned, tokens left, and minutes until the wall resets. Limit-weighted
// tokens (cache-reads count ~0.1x) so used/cap matches Claude's real quota %.
function sessionWindow() {
  let win, rl;
  try { win = JSON.parse(readFileSync(path.join(CONFIG_DIR, "window.json"), "utf8")); } catch { return null; }
  try { rl = JSON.parse(readFileSync(path.join(CONFIG_DIR, "rl.json"), "utf8")); } catch { rl = {}; }
  if (!win || !Array.isArray(win.buckets) || !win.cap5) return null;
  const now = Date.now();
  let used = 0, burn5 = 0;
  for (const b of win.buckets) {
    if (b[0] > now - 5 * 3600 * 1000) used += b[1];
    if (b[0] > now - 5 * 60 * 1000) burn5 += b[1];
  }
  used = Math.round(used);
  const cap = win.cap5;
  const left = Math.max(0, cap - used);
  const pct = cap > 0 ? used / cap : 0;
  // use-it-or-lose-it pace: to fully use a rolling 5h budget you must sustain cap/300 per minute.
  // burning less than that leaves tokens to expire — "behind pace" = under-using, not over-using.
  const needPerMin = Math.round(cap / 300);
  const nowPerMin = Math.round(burn5 / 5);
  const behind = nowPerMin < needPerMin;
  // minutes until the wall clears. Prefer Anthropic's authoritative fixed-window reset
  // (rl.json); fall back to when the oldest in-window token ages out of the rolling 5h.
  let resetInMins = null;
  if (rl.fiveResetAt) resetInMins = Math.max(0, Math.round((rl.fiveResetAt * 1000 - now) / 60000));
  else {
    const inWin = win.buckets.filter((b) => b[0] > now - 5 * 3600 * 1000);
    if (inWin.length) resetInMins = Math.max(0, Math.round((inWin[0][0] + 5 * 3600 * 1000 - now) / 60000));
  }
  return { used, cap, left, pct, resetInMins, burn5: Math.round(burn5), needPerMin, nowPerMin, behind };
}

// ─── build the public stats payload ───────────────────────────────────────────
function buildStats(acc) {
  const t = acc.totals;
  const grand = t.input + t.cacheCreate + t.cacheRead + t.output;
  const cacheableInput = t.input + t.cacheCreate + t.cacheRead;
  const cacheHit = cacheableInput > 0 ? t.cacheRead / cacheableInput : 0;

  const days = [...acc.byDay.keys()].sort();
  const activeDays = days.length;
  const perDay = days.map((day) => ({ day, ...acc.byDay.get(day) }));
  const tokensPerActiveDay = activeDays > 0 ? Math.round(grand / activeDays) : 0;

  const streaks = computeStreaks(days);

  const models = [...acc.byModel.entries()]
    .map(([model, tokens]) => ({ model, tokens }))
    .sort((a, b) => b.tokens - a.tokens);

  return {
    generatedAt: new Date().toISOString(),
    schema: "maxx.stats.v1",
    totals: {
      tokens: grand,
      input: t.input,
      cacheCreation: t.cacheCreate,
      cacheRead: t.cacheRead,
      output: t.output,
    },
    cacheHitRate: Number(cacheHit.toFixed(4)),
    messages: acc.messages,
    sessions: acc.sessions.size,
    activeDays,
    tokensPerActiveDay,
    firstDay: days[0] || null,
    lastDay: days[activeDays - 1] || null,
    streak: streaks.current,
    longestStreak: streaks.longest,
    // RAW 5h log-scan window — NOT the pacing budget. For "how much to spend this session" use
    // `maxx session` / render.mjs --session (weekly-paced). Renamed from `.session` so consumers
    // stop mistaking this raw window for the sustainable share.
    session5hRaw: sessionWindow(),
    models,
    perDay,
  };
}

// minutes → "2h 14m" / "47m"
function fmtMins(m) {
  if (m == null) return "—";
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// ─── pretty print ─────────────────────────────────────────────────────────────
function fmt(n) {
  return n.toLocaleString("en-US");
}
function human(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}
function pretty(s) {
  const L = [];
  L.push("");
  L.push("  ⚡ maxx");
  L.push("  ─────────────────────────────────────────");
  L.push(`  total tokens      ${human(s.totals.tokens)}  (${fmt(s.totals.tokens)})`);
  L.push(`  tokens / day      ${human(s.tokensPerActiveDay)}`);
  L.push(`  cache-hit         ${(s.cacheHitRate * 100).toFixed(1)}%`);
  L.push(`  streak            ${s.streak}d   (longest ${s.longestStreak}d)`);
  L.push(`  active days       ${s.activeDays}   (${s.firstDay} → ${s.lastDay})`);
  L.push(`  sessions          ${fmt(s.sessions)}`);
  L.push(`  messages          ${fmt(s.messages)}`);
  if (s.session5hRaw) {
    const sw = s.session5hRaw;
    L.push("  ─────────────────────────────────────────");
    L.push("  5h window (raw — for pacing use `maxx session`)");
    L.push(`    used            ${human(sw.used)}  (${(sw.pct * 100).toFixed(0)}%)`);
    L.push(`    left            ${human(sw.left)}  of ${human(sw.cap)}`);
    L.push(`    resets in       ${fmtMins(sw.resetInMins)}`);
  }
  L.push("  ─────────────────────────────────────────");
  L.push("  breakdown");
  L.push(`    input           ${human(s.totals.input)}`);
  L.push(`    cache write      ${human(s.totals.cacheCreation)}`);
  L.push(`    cache read      ${human(s.totals.cacheRead)}`);
  L.push(`    output          ${human(s.totals.output)}`);
  if (s.models.length) {
    L.push("  ─────────────────────────────────────────");
    L.push("  models");
    for (const m of s.models.slice(0, 6)) {
      L.push(`    ${m.model.padEnd(28)} ${human(m.tokens)}`);
    }
  }
  L.push("");
  return L.join("\n");
}

// ─── main ─────────────────────────────────────────────────────────────────────
export async function collectStats(dir = DEFAULT_DIR) {
  const acc = {
    totals: { input: 0, cacheCreate: 0, cacheRead: 0, output: 0 },
    byDay: new Map(),
    byModel: new Map(),
    sessions: new Set(),
    seen: new Set(),
    messages: 0,
  };
  const files = await findSessionFiles(dir);
  for (const f of files) {
    try {
      await ingestFile(f, acc);
    } catch {
      // unreadable file → skip
    }
  }
  return buildStats(acc);
}

// Resolve both sides through symlinks so `isMain` holds when the script is run
// via a symlink (e.g. installed into ~/.claude/skills/maxx → repo).
function isMainModule() {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(invoked);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const a = parseArgs(process.argv.slice(2));
  const w = (s) => process.stdout.write(s + "\n");
  try {
    if (a.cmd === "session") {
      // PACING is NOT computed here. The sustainable per-session budget is weekly ÷ sessions-left,
      // and only render.mjs has the weekly rate-limit data (from the statusline's stdin, via
      // status.json). tracker's own 5h log-scan is a RAW window, not the pacing budget — a consumer
      // misread it as "plenty of headroom, run flat-out", the opposite of the truth. So delegate:
      //   `maxx session`        → the weekly-paced brief (render.mjs --session)
      //   `maxx session raw`    → the full status.json (render.mjs --status)
      const renderPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "render.mjs");
      try {
        const outStr = execFileSync(process.execPath, [renderPath, a.raw ? "--status" : "--session"],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        w(outStr.replace(/\n+$/, ""));
      } catch {
        w(a.raw ? "{}" : "  session: no pacing data yet — open Claude Code so the statusline seeds ~/.maxx/status.json.");
      }
    } else if (a.cmd === "json") {
      w(JSON.stringify(await collectStats(a.dir), null, 2));
    } else {
      w(pretty(await collectStats(a.dir)));
    }
  } catch (err) {
    process.stderr.write(`maxx: ${err.message}\n`);
    process.exit(1);
  }
}
