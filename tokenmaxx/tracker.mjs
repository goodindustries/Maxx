#!/usr/bin/env node
/**
 * tokenmaxx tracker — parse ~/.claude/projects/*.jsonl into a shareable stats payload.
 *
 * Usage:
 *   node tokenmaxx/tracker.mjs            — pretty summary
 *   node tokenmaxx/tracker.mjs --json     — machine-readable stats payload
 *   node tokenmaxx/tracker.mjs --dir PATH — override projects dir
 *
 * Reads only usage/token metadata. Never emits prompt or message content.
 */
import { createReadStream, realpathSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import path from "node:path";

const HOME = homedir();
const DEFAULT_DIR = path.join(HOME, ".claude", "projects");
const CONFIG_DIR = path.join(HOME, ".tokenmaxx");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const DEFAULT_SERVER = process.env.TOKENMAXX_SERVER || "https://tokenmaxx.dev";

// ─── identity ─────────────────────────────────────────────────────────────────
// installId is a stable anonymous key minted once per machine. handle is the
// chosen display name (the /u/<handle> slug). Same installId across runs → same
// person, even before they pick a handle.
function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}
function saveConfig(cfg) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
}
function identity() {
  const cfg = loadConfig();
  if (!cfg.installId) {
    cfg.installId = randomUUID();
    saveConfig(cfg);
  }
  return cfg;
}
function normalizeHandle(raw) {
  const h = String(raw || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(h)) {
    throw new Error(
      "handle must be 2-32 chars, lowercase letters/digits/dashes, not starting with a dash"
    );
  }
  return h;
}
function setUser(raw) {
  const handle = normalizeHandle(raw);
  const cfg = identity();
  cfg.handle = handle;
  saveConfig(cfg);
  return cfg;
}

// ─── args ───────────────────────────────────────────────────────────────────
// forms:
//   (none)            → card
//   json | --json     → JSON payload
//   push | --push     → collect + upload, print rank
//   set-user <handle> → set display handle
//   whoami            → print identity
// flags: --dir PATH, --server URL
function parseArgs(argv) {
  const out = { cmd: "card", dir: DEFAULT_DIR, server: DEFAULT_SERVER, handle: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json" || a === "json") out.cmd = "json";
    else if (a === "--push" || a === "push") out.cmd = "push";
    else if (a === "set-user" || a === "set-handle") { out.cmd = "set-user"; }
    else if (a === "whoami") out.cmd = "whoami";
    else if (a === "--dir") out.dir = argv[++i];
    else if (a === "--server") out.server = argv[++i];
    else rest.push(a);
  }
  if (out.cmd === "set-user") out.handle = rest[0];
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
    schema: "tokenmaxx.stats.v1",
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
    models,
    perDay,
  };
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
  L.push("  ⚡ tokenmaxx");
  L.push("  ─────────────────────────────────────────");
  L.push(`  total tokens      ${human(s.totals.tokens)}  (${fmt(s.totals.tokens)})`);
  L.push(`  tokens / day      ${human(s.tokensPerActiveDay)}`);
  L.push(`  cache-hit         ${(s.cacheHitRate * 100).toFixed(1)}%`);
  L.push(`  streak            ${s.streak}d   (longest ${s.longestStreak}d)`);
  L.push(`  active days       ${s.activeDays}   (${s.firstDay} → ${s.lastDay})`);
  L.push(`  sessions          ${fmt(s.sessions)}`);
  L.push(`  messages          ${fmt(s.messages)}`);
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

// ─── push to leaderboard ──────────────────────────────────────────────────────
async function pushStats(stats, server) {
  const id = identity();
  const body = { installId: id.installId, handle: id.handle || null, stats };
  const res = await fetch(`${server.replace(/\/$/, "")}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ingest failed ${res.status}: ${text.slice(0, 200)}`);
  let out;
  try {
    out = JSON.parse(text);
  } catch {
    throw new Error(`ingest returned non-JSON: ${text.slice(0, 200)}`);
  }
  return { id, out };
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
// via a symlink (e.g. installed into ~/.claude/skills/tokenmaxx → repo).
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
    if (a.cmd === "whoami") {
      const id = identity();
      w(JSON.stringify({ installId: id.installId, handle: id.handle || null }, null, 2));
    } else if (a.cmd === "set-user") {
      const cfg = setUser(a.handle);
      w(`handle set: ${cfg.handle}  (install ${cfg.installId.slice(0, 8)}…)`);
    } else if (a.cmd === "json") {
      w(JSON.stringify(await collectStats(a.dir), null, 2));
    } else if (a.cmd === "push") {
      const stats = await collectStats(a.dir);
      const { id, out } = await pushStats(stats, a.server);
      w(pretty(stats));
      const who = id.handle ? `@${id.handle}` : `install ${id.installId.slice(0, 8)}…`;
      w(`  pushed as ${who}` + (out.rank ? `  →  rank #${out.rank} of ${out.total}` : ""));
      if (!id.handle) w(`  (no handle yet — run: tokenmaxx set-user <name>)`);
      w("");
    } else {
      w(pretty(await collectStats(a.dir)));
    }
  } catch (err) {
    process.stderr.write(`tokenmaxx: ${err.message}\n`);
    process.exit(1);
  }
}
