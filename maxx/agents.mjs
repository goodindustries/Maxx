#!/usr/bin/env node
/**
 * maxx agents — WHO is burning tokens right now, rolled up to the session you'd act on.
 *
 * The nazi/status views give a session COUNT ("8 sessions burning"). This gives
 * the attribution with names you can act on.
 *
 * Session logs nest: a root session lives at
 *     ~/.claude/projects/<project>/<ROOT-UUID>.jsonl
 * and everything it spawns lives UNDER it —
 *     <project>/<ROOT-UUID>/subagents/agent-*.jsonl
 *     <project>/<ROOT-UUID>/subagents/workflows/<wf>/agent-*.jsonl
 * A 300-agent workflow is therefore ONE root session's burn, not 300 strangers.
 * This tool rolls every descendant up to its ROOT and labels it with the root's
 * human title (customTitle > aiTitle > agentName), so "what's eating the quota"
 * answers with "nonprofit-atlas: Build self-healing agent — 204M" not a UUID.
 *
 * Usage:
 *   node maxx/agents.mjs               — ranked roots, last 60m
 *   node maxx/agents.mjs --mins 30     — window minutes (default 60)
 *   node maxx/agents.mjs --children    — also list each root's live descendants
 *   node maxx/agents.mjs --json        — machine payload
 *   node maxx/agents.mjs --dir PATH    — override projects dir
 *
 * Agent-readable: first stdout line is a single `MAXX_AGENTS …` record (grep it).
 * Fully on-box: reads only usage/token metadata + titles. Sends nothing.
 */
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import path from "node:path";

const HOME = homedir();
const DEFAULT_DIR = path.join(HOME, ".claude", "projects");
const LIVE_SEC = 5 * 60;

function parseArgs(argv) {
  const out = { dir: DEFAULT_DIR, mins: 60, json: false, children: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json" || a === "json") out.json = true;
    else if (a === "--children" || a === "children") out.children = true;
    else if (a === "--mins") out.mins = Number(argv[++i]) || 60;
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

// Map a file path under the projects dir to its owning root session.
//   <project>/<root>.jsonl                              → root itself   (kind: own)
//   <project>/<root>/subagents/.../agent-*.jsonl        → child         (kind: sub)
//   <project>/<root>/subagents/workflows/<wf>/agent-*   → child         (kind: wf)
function classify(dir, file) {
  const rel = path.relative(dir, file).split(path.sep);
  const project = rel[0] || "?";
  if (rel.length === 2) {
    return { project, root: rel[1].replace(/\.jsonl$/, ""), kind: "own" };
  }
  const root = rel[1]; // the ROOT-UUID directory
  const kind = rel.includes("workflows") ? "wf" : "sub";
  return { project, root, kind };
}

async function ingest(file, cutoffSec) {
  let tok = 0, out = 0, turns = 0, last = 0;
  let custom = null, ai = null, agent = null, branch = null, cwd = null;
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line || line[0] !== "{") continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.customTitle) custom = rec.customTitle;
    if (rec.aiTitle) ai = rec.aiTitle;
    if (rec.agentName) agent = rec.agentName;
    if (rec.gitBranch) branch = rec.gitBranch;
    if (rec.cwd) cwd = rec.cwd;
    const u = rec?.message?.usage || rec?.usage;
    const ts = rec?.timestamp;
    if (!u || !ts) continue;
    const t = Date.parse(ts) / 1000;
    if (!Number.isFinite(t) || t < cutoffSec) continue;
    tok += (u.input_tokens || 0) + (u.output_tokens || 0) +
           (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    out += u.output_tokens || 0;
    turns++;
    if (t > last) last = t;
  }
  return { tok, out, turns, last, custom, ai, agent, branch, cwd };
}

// Metadata-only scan of a root's own .jsonl — no token/window filter. Used to
// backfill name+branch for roots whose own log fell outside the window but whose
// children are still live (idle root, bleeding descendants). Stops once it has both.
async function readMeta(file) {
  let custom = null, ai = null, agent = null, branch = null, cwd = null;
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line || line[0] !== "{") continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.customTitle) custom = rec.customTitle;
    if (rec.aiTitle) ai = rec.aiTitle;
    if (rec.agentName) agent = rec.agentName;
    if (rec.gitBranch) branch = rec.gitBranch;
    if (rec.cwd) cwd = rec.cwd;
    if (custom && branch) break; // best labels found, stop early
  }
  rl.close();
  return { name: custom || ai || agent || null, branch, cwd };
}

const fmt = (n) =>
  n >= 1e9 ? (n / 1e9).toFixed(1) + "B" :
  n >= 1e6 ? (n / 1e6).toFixed(1) + "M" :
  n >= 1e3 ? (n / 1e3).toFixed(0) + "k" : String(n);
const pad = (s, w) => String(s).padStart(w);
const projShort = (p) => p.replace(/^-Users-reify-(Classified-)?/, "").replace(/^-+/, "") || "?";
// Per-root label: the short project name, or the session's cwd when there's no
// real project dir (e.g. a `claude` run from `/` shows up as project "-" → "?").
const projLabel = (r) => { const s = projShort(r.project); return s === "?" ? (r.cwd || "?") : s; };

const args = parseArgs(process.argv.slice(2));
const nowSec = Date.now() / 1000;
const cutoffSec = nowSec - args.mins * 60;
const liveSince = nowSec - LIVE_SEC;

const files = await recentFiles(args.dir, cutoffSec * 1000);

// aggregate into ROOT sessions
const roots = new Map();
for (const f of files) {
  const s = await ingest(f, cutoffSec);
  if (!s.tok) continue;
  const c = classify(args.dir, f);
  const key = `${c.project}/${c.root}`;
  let r = roots.get(key);
  if (!r) {
    r = { key, project: c.project, root: c.root, billed: 0, out: 0, own: 0, sub: 0, wf: 0,
          nSub: 0, nWf: 0, live: 0, last: 0, name: null, branch: null, cwd: null, children: [] };
    roots.set(key, r);
  }
  r.billed += s.tok; r.out += s.out; r.last = Math.max(r.last, s.last);
  r[c.kind] += s.tok;
  if (c.kind === "sub") r.nSub++;
  if (c.kind === "wf") r.nWf++;
  if (s.last > liveSince) r.live++;
  if (c.kind === "own") { r.name = s.custom || s.ai || s.agent || r.name; r.branch = s.branch || r.branch; r.cwd = s.cwd || r.cwd; }
  else if (!r.name && (s.custom || s.ai || s.agent)) r.name = s.custom || s.ai || s.agent;
  if (s.last > liveSince) r.children.push({ kind: c.kind, billed: s.tok, file: path.basename(f).replace(/\.jsonl$/, "").slice(0, 12) });
}

// Backfill roots whose own log was outside the window (idle root, live children):
// read the root .jsonl directly for its title + branch instead of showing "?".
for (const r of roots.values()) {
  if (r.name && r.branch) continue;
  const rootFile = path.join(args.dir, r.project, r.root + ".jsonl");
  try {
    const m = await readMeta(rootFile);
    r.name = r.name || m.name;
    r.branch = r.branch || m.branch;
    r.cwd = r.cwd || m.cwd;
  } catch {}
}

const ranked = [...roots.values()].sort((a, b) => b.billed - a.billed);
const totBilled = ranked.reduce((a, r) => a + r.billed, 0);
const totOut = ranked.reduce((a, r) => a + r.out, 0);
const liveRoots = ranked.filter((r) => r.live > 0);

// ── agent-readable first line ───────────────────────────────────────────────
const label = (r) => `${projLabel(r)}${r.name ? ":" + r.name.slice(0, 32) : ""}`;
const top = ranked.slice(0, 4).map((r) => `${label(r).replace(/\s+/g, "_")}=${fmt(r.billed)}`).join(" ");
console.log(`MAXX_AGENTS window=${args.mins}m billed=${fmt(totBilled)} output=${fmt(totOut)} roots=${ranked.length} live_roots=${liveRoots.length} top=[${top}]`);

if (args.json) {
  console.log(JSON.stringify({
    windowMins: args.mins, at: new Date(nowSec * 1000).toISOString(),
    totalBilled: totBilled, totalOutput: totOut, rootCount: ranked.length, liveRoots: liveRoots.length,
    roots: ranked.map((r) => ({
      key: r.key, project: projLabel(r), name: r.name, branch: r.branch,
      billed: r.billed, output: r.out, live: r.live, agoMin: Math.round((nowSec - r.last) / 60),
      breakdown: { own: r.own, subagents: r.sub, workflow: r.wf, nSub: r.nSub, nWf: r.nWf },
      liveChildren: r.children.sort((a, b) => b.billed - a.billed).slice(0, 10),
    })),
  }, null, 2));
  process.exit(0);
}

// ── pretty card ─────────────────────────────────────────────────────────────
console.log(`\n  maxx agents — who's burning  ·  last ${args.mins}m  ·  rolled up to root session\n`);
for (const r of ranked) {
  const flag = r.live ? "🔴" : "  ";
  const ago = r.live ? `${r.live} live` : `idle ${Math.round((nowSec - r.last) / 60)}m`;
  const nm = r.name ? `"${r.name}"` : projLabel(r);
  const parts = [];
  if (r.sub) parts.push(`sub ${fmt(r.sub)}×${r.nSub}`);
  if (r.wf) parts.push(`wf ${fmt(r.wf)}×${r.nWf}`);
  const bd = parts.length ? `  (own ${fmt(r.own)} · ${parts.join(" · ")})` : "";
  console.log(`  ${flag} ${pad(fmt(r.billed), 7)}  ${pad(ago, 8)}  ${projLabel(r)} — ${nm}${bd}`);
  console.log(`            ${" ".repeat(9)}${r.root.slice(0, 8)}${r.branch ? "  @" + r.branch : ""}`);
  if (args.children && r.children.length) {
    for (const c of r.children.sort((a, b) => b.billed - a.billed).slice(0, 8)) {
      console.log(`              ↳ ${pad(fmt(c.billed), 7)}  ${c.kind}  ${c.file}`);
    }
  }
}
console.log(`  ${"─".repeat(52)}`);
console.log(`  ${fmt(totBilled)} billed · ${fmt(totOut)} output · ${ranked.length} root sessions · ${liveRoots.length} live`);
console.log(`  billed counts cache reads (count toward quota); output = generated (the costly part).\n`);
