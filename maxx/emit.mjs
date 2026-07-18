#!/usr/bin/env node
/**
 * maxx emit — the log-shipper half of centralized, omni-surface budget.
 *
 * The problem it solves: subscription budget (5h/weekly %) is only observable
 * from an interactive Claude Code client (the laptop statusline). Cloud routines
 * can't read /usage at all. But EVERY surface can count its own tokens. So instead
 * of asking each surface "what % of the wall am I at?" (unreachable), we ship the
 * raw per-turn usage metadata to a central tally, and anchor the tally to the
 * authoritative % whenever an interactive session observes it (rate_limits → rl.json).
 *
 * This is the on-box emitter. It reads only token/usage metadata — never prompt or
 * message content — from ~/.claude/projects, tallies everything NEW since the last
 * emit (cursor), attaches the current rate-limit anchor if one is fresh, and POSTs
 * one envelope to the central logs endpoint. Run it on an interval (like a log
 * shipper). The cloud side ships the same envelope via the account-wide maxx MCP
 * connector; both feed one tally store keyed by the user's handle.
 *
 * Config (~/.maxx/config.json): handle (userid), secret (bearer), installId (surface),
 * logsUrl (base, default https://meetmaxx.co). Cursor in ~/.maxx/emit-cursor.json.
 *
 * Usage:
 *   node maxx/emit.mjs               — DRY RUN: print the envelope, don't send, don't advance cursor
 *   node maxx/emit.mjs --send        — POST the envelope and advance the cursor on success
 *   node maxx/emit.mjs --since ISO   — override the cursor (re-emit from a timestamp)
 *   node maxx/emit.mjs --json        — print the raw envelope JSON only
 *   node maxx/emit.mjs --dir PATH    — override projects dir
 *
 * Wire contract: see maxx/LOGS.md.
 */
import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir, hostname } from "node:os";
import path from "node:path";

const HOME = homedir();
const DEFAULT_DIR = path.join(HOME, ".claude", "projects");
const CONFIG = path.join(HOME, ".maxx", "config.json");
const RL = path.join(HOME, ".maxx", "rl.json");
const CURSOR = path.join(HOME, ".maxx", "emit-cursor.json");
const ANCHOR_MAX_AGE_SEC = 30 * 60; // an anchor older than this is not trustworthy

const readJSON = (p, d) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return d; } };

function parseArgs(argv) {
  const out = { dir: DEFAULT_DIR, send: false, json: false, since: null, watch: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--send" || a === "send") out.send = true;
    else if (a === "--json" || a === "json") out.json = true;
    else if (a === "--watch" || a === "watch") { out.watch = true; out.send = true; }
    else if (a === "--since") out.since = argv[++i];
    else if (a === "--dir") out.dir = argv[++i];
  }
  return out;
}

async function recentFiles(dir, cutoffMs) {
  const files = [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return files; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) files.push(...(await recentFiles(full, cutoffMs)));
    else if (e.isFile() && e.name.endsWith(".jsonl")) {
      try { if ((await stat(full)).mtimeMs >= cutoffMs) files.push(full); } catch {}
    }
  }
  return files;
}

// Map a file to its owning ROOT session (same nesting rule as agents.mjs).
function classify(dir, file) {
  const rel = path.relative(dir, file).split(path.sep);
  const project = rel[0] || "?";
  if (rel.length === 2) return { project, root: rel[1].replace(/\.jsonl$/, "") };
  return { project, root: rel[1] };
}

const projShort = (p) => p.replace(/^-Users-reify-(Classified-)?/, "").replace(/^-+/, "") || "?";
const modelFamily = (m) => {
  if (!m) return "other";
  const s = String(m).toLowerCase();
  if (s.includes("opus")) return "Opus";
  if (s.includes("sonnet")) return "Sonnet";
  if (s.includes("haiku")) return "Haiku";
  if (s.includes("fable") || s.includes("mythos")) return "Fable";
  return "other";
};

// Quota-pressure weighting — MUST match limit.mjs so the tally's token amounts
// agree with the /usage-anchored statusline (not raw billed, which is ~10x higher
// because cache reads dominate). Per-token: output 5x, cache-write 1.25x,
// cache-read 0.1x. Per-model weight from ~/.maxx/prices.json (daily-refreshed) or
// the built-in fallback. `billed` we ship IS this weighted number.
const PRICE_W = (() => {
  const fallback = { fable: 10 / 3, mythos: 10 / 3, opus: 5 / 3, sonnet: 1, haiku: 1 / 3 };
  try { return { ...fallback, ...(readJSON(path.join(HOME, ".maxx", "prices.json"), {}).weights || {}) }; }
  catch { return fallback; }
})();
const modelWeight = (m) => { m = String(m || "").toLowerCase(); for (const fam in PRICE_W) if (m.includes(fam)) return PRICE_W[fam]; return PRICE_W.sonnet; };
const weightedTok = (u, model) =>
  ((u.input_tokens || 0) + (u.output_tokens || 0) * 5 +
   (u.cache_creation_input_tokens || 0) * 1.25 + (u.cache_read_input_tokens || 0) * 0.1) * modelWeight(model);

// Sum only usage records strictly newer than `sinceSec`, per file, keeping the
// root labels + per-model billed. Returns the new records' contribution.
async function ingestSince(file, sinceSec) {
  let billed = 0, out = 0, turns = 0, first = 0, last = 0;
  const byModel = {};
  let custom = null, ai = null, agent = null, branch = null;
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line || line[0] !== "{") continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.customTitle) custom = rec.customTitle;
    if (rec.aiTitle) ai = rec.aiTitle;
    if (rec.agentName) agent = rec.agentName;
    if (rec.gitBranch) branch = rec.gitBranch;
    const u = rec?.message?.usage || rec?.usage;
    const ts = rec?.timestamp;
    if (!u || !ts) continue;
    const t = Date.parse(ts) / 1000;
    if (!Number.isFinite(t) || t <= sinceSec) continue; // only NEW records
    const model = rec?.message?.model || rec?.model;
    const b = Math.round(weightedTok(u, model)); // quota-weighted, matches limit.mjs
    if (!b) continue;
    billed += b;
    out += u.output_tokens || 0;
    turns++;
    byModel[modelFamily(model)] = (byModel[modelFamily(model)] || 0) + b;
    if (!first || t < first) first = t;
    if (t > last) last = t;
  }
  return { billed, out, turns, byModel, first, last, name: custom || ai || agent || null, branch };
}

const iso = (sec) => new Date(sec * 1000).toISOString();

const args = parseArgs(process.argv.slice(2));
const cfg = readJSON(CONFIG, {});
const handle = cfg.handle || "unknown";
const secret = cfg.secret || "";
const installId = cfg.installId || hostname();
const base = (process.env.MAXX_LOGS_URL || cfg.logsUrl || "https://meetmaxx.co").replace(/\/$/, "");
const surface = cfg.surface || `laptop:${installId.slice(0, 8)}`;

// One emit cycle: read cursor, scan NEW usage past it, attach a fresh anchor,
// print (dry) or POST (send) and advance the cursor only on a 2xx. Returns the
// new maxTs so --watch can chain cycles. First run (no cursor) ships ALL history
// — a one-time bulk backfill so the server has complete ground truth to
// reconstruct usage over time and true-up caps against every past anchor.
async function runOnce({ quiet = false } = {}) {
  const nowSec = Date.now() / 1000;
  const cursorState = readJSON(CURSOR, {});
  const sinceSec = args.since ? Date.parse(args.since) / 1000 : (cursorState.lastTs || 0);

  const files = await recentFiles(args.dir, (sinceSec - 120) * 1000 || 0);
  const roots = new Map();
  let maxTs = sinceSec;
  for (const f of files) {
    const s = await ingestSince(f, sinceSec);
    if (!s.billed) continue;
    const c = classify(args.dir, f);
    const key = `${c.project}/${c.root}`;
    let r = roots.get(key);
    if (!r) { r = { root: c.root, project: projShort(c.project), name: null, branch: null, billed: 0, output: 0, turns: 0, byModel: {}, first: 0, last: 0 }; roots.set(key, r); }
    r.billed += s.billed; r.output += s.out; r.turns += s.turns;
    for (const k in s.byModel) r.byModel[k] = (r.byModel[k] || 0) + s.byModel[k];
    if (s.name) r.name = s.name;
    if (s.branch) r.branch = s.branch;
    if (!r.first || s.first < r.first) r.first = s.first;
    if (s.last > r.last) r.last = s.last;
    if (s.last > maxTs) maxTs = s.last;
  }

  // Anchor: the authoritative subscription %s the interactive statusline observed.
  // Only attach if fresh — never ship a stale anchor with a new timestamp.
  const rl = readJSON(RL, null);
  let anchor = null;
  if (rl && rl.ts && (Date.now() - rl.ts) / 1000 < ANCHOR_MAX_AGE_SEC && (rl.quota != null || rl.week != null)) {
    anchor = {
      five_pct: rl.quota ?? null, week_pct: rl.week ?? null,
      five_reset: rl.fiveResetAt ?? null, week_reset: rl.weekResetAt ?? null,
      observed_at: iso(rl.ts / 1000),
    };
  }

  const sessions = [...roots.values()]
    .sort((a, b) => b.billed - a.billed)
    .map((r) => ({
      root: r.root, project: r.project, name: r.name, branch: r.branch,
      billed: r.billed, output: r.output, turns: r.turns, by_model: r.byModel,
      first_ts: r.first ? iso(r.first) : null, last_ts: r.last ? iso(r.last) : null,
    }));
  const totalBilled = sessions.reduce((a, s) => a + s.billed, 0);
  const totalOutput = sessions.reduce((a, s) => a + s.output, 0);

  const envelope = {
    v: 1, surface, install_id: installId, handle,
    emitted_at: iso(nowSec), since: sinceSec ? iso(sinceSec) : null,
    cursor: String(Math.round(maxTs)),
    totals: { billed: totalBilled, output: totalOutput, sessions: sessions.length },
    sessions, anchor,
  };

  if (!quiet) {
    console.log(`MAXX_EMIT handle=${handle} surface=${surface} new_billed=${totalBilled} output=${totalOutput} sessions=${sessions.length} anchor=${anchor ? "yes" : "no"} target=${base}/api/u/${handle}/logs mode=${args.send ? "send" : "dry"}`);
    if (args.json) console.log(JSON.stringify(envelope, null, 2));
  }
  if (!totalBilled) { if (!quiet) console.log("  nothing new since cursor."); return maxTs; }

  if (!args.send) {
    if (!quiet && !args.json) {
      console.log(`\n  DRY RUN — would POST to ${base}/api/u/${handle}/logs:`);
      for (const s of sessions.slice(0, 8)) {
        const mm = Object.entries(s.by_model).map(([k, v]) => `${k} ${Math.round(v / 1e3)}k`).join(" ");
        console.log(`    ${String(Math.round(s.billed / 1e3)).padStart(6)}k  ${s.project} — ${s.name || s.root.slice(0, 8)}  (${mm})`);
      }
      console.log(`  anchor: ${anchor ? `5h ${Math.round((anchor.five_pct || 0) * 100)}% · week ${Math.round((anchor.week_pct || 0) * 100)}%` : "none fresh"}`);
      console.log(`  cursor would advance ${sinceSec ? iso(sinceSec) : "(start)"} → ${iso(maxTs)}\n  run with --send to ship it.\n`);
    }
    return maxTs;
  }

  // --send
  if (!secret) { process.stderr.write("maxx emit: no secret in ~/.maxx/config.json.\n"); if (!args.watch) process.exit(1); return maxTs; }
  try {
    const res = await fetch(`${base}/api/u/${encodeURIComponent(handle)}/logs`, {
      method: "POST",
      headers: { "content-type": "application/json", "authorization": `Bearer ${secret}` },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.text().catch(() => "");
    if (res.ok) {
      writeFileSync(CURSOR, JSON.stringify({ lastTs: Math.round(maxTs), at: iso(nowSec) }));
      console.log(`  sent ✓ ${res.status} +${fmtK(totalBilled)} · cursor → ${iso(maxTs)} · ${body.slice(0, 120)}`);
    } else {
      console.log(`  send FAILED ${res.status} — cursor NOT advanced · ${body.slice(0, 200)}`);
      if (!args.watch) process.exit(1);
    }
  } catch (e) {
    console.log(`  send error — cursor NOT advanced · ${e.message}`);
    if (!args.watch) process.exit(1);
  }
  return maxTs;
}

const fmtK = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : Math.round(n / 1e3) + "k";

if (!args.watch) {
  await runOnce();
} else {
  // Live stream: a session's .jsonl is appended per-turn WHILE it runs, so tailing
  // the projects dir emits each turn's usage as it lands. Debounce bursts; a slow
  // interval backstops any watch event the OS drops.
  const { watch } = await import("node:fs");
  console.log(`MAXX_EMIT watch=on surface=${surface} target=${base} — live-streaming turns as they land (Ctrl-C to stop)`);
  await runOnce({ quiet: true });
  let timer = null, running = false;
  const kick = () => {
    if (timer) return;
    timer = setTimeout(async () => {
      timer = null;
      if (running) return;
      running = true;
      try { await runOnce({ quiet: true }); } catch (e) { console.log("  cycle error:", e.message); }
      running = false;
    }, 2000); // debounce 2s
  };
  try { watch(args.dir, { recursive: true }, (_e, f) => { if (f && f.endsWith(".jsonl")) kick(); }); }
  catch { /* recursive watch unsupported on some platforms */ }
  setInterval(kick, 60000); // 60s backstop
}
