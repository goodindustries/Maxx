#!/usr/bin/env node
/**
 * maxx · session optimizer — analyze one Claude Code session transcript and show
 * where the tokens went, ranked by dollars, with specific fixes.
 *
 *   node optimize.mjs                analyze the most recent session
 *   node optimize.mjs --dir PATH     override ~/.claude/projects
 *   node optimize.mjs --json         machine-readable report
 *   node optimize.mjs --no-color     plain text
 *
 * Reads usage / timing / model metadata only — never prompt or message content.
 * Pricing is Anthropic list price ($/token); tune PRICE if yours differs.
 */
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import path from "node:path";

const HOME = homedir();
const DEFAULT_DIR = path.join(HOME, ".claude", "projects");
const IDLE_MS = 5 * 60 * 1000;            // cache TTL: gaps beyond this re-prime context
const GRUNT_OUTPUT = 350;                 // turns with less output than this look mechanical

// $/token by model family: input, output, cache-write, cache-read
const PRICE = {
  opus:   { in: 15e-6, out: 75e-6, cw: 18.75e-6, cr: 1.5e-6 },
  sonnet: { in: 3e-6,  out: 15e-6, cw: 3.75e-6,  cr: 0.3e-6 },
  haiku:  { in: 1e-6,  out: 5e-6,  cw: 1.25e-6,  cr: 0.1e-6 },
};
const family = (m) => {
  const s = String(m || "").toLowerCase();
  return s.includes("opus") ? "opus" : s.includes("haiku") ? "haiku" : s.includes("sonnet") ? "sonnet" : "sonnet";
};
const costOf = (t, fam = family(t.model)) => {
  const p = PRICE[fam];
  return t.input * p.in + t.output * p.out + t.cc * p.cw + t.cr * p.cr;
};

// ─── args ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const o = { dir: DEFAULT_DIR, json: false, color: process.stdout.isTTY };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir") o.dir = argv[++i];
    else if (a === "--json") o.json = true;
    else if (a === "--no-color") o.color = false;
    else if (a === "--color") o.color = true;
  }
  return o;
}

// ─── find the most recently modified session file ───────────────────────────────
async function newestSession(dir) {
  let best = null;
  async function walk(d) {
    let entries;
    try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && e.name.endsWith(".jsonl")) {
        try {
          const m = (await stat(full)).mtimeMs;
          if (!best || m > best.mtime) best = { file: full, mtime: m };
        } catch { /* skip */ }
      }
    }
  }
  await walk(dir);
  return best?.file || null;
}

// ─── parse one session's turns (usage/timing/model only) ────────────────────────
async function parseSession(file) {
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  const turns = [];
  const seen = new Set();
  let project = null;
  for await (const line of rl) {
    if (!line || line[0] !== "{") continue;
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    if (!project && rec.cwd) project = path.basename(rec.cwd);
    const u = rec?.message?.usage;
    if (!u) continue;
    const input = u.input_tokens || 0, cc = u.cache_creation_input_tokens || 0;
    const cr = u.cache_read_input_tokens || 0, output = u.output_tokens || 0;
    if (input + cc + cr + output === 0) continue;
    const id = rec.requestId || rec.uuid;
    if (id) { if (seen.has(id)) continue; seen.add(id); }
    const ts = rec.timestamp ? Date.parse(rec.timestamp) : NaN;
    turns.push({ ts, model: rec?.message?.model || "unknown", input, cc, cr, output });
  }
  turns.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return { turns, project: project || path.basename(file).replace(/\.jsonl$/, "") };
}

// ─── analyze ────────────────────────────────────────────────────────────────────
function analyze({ turns, project }) {
  const tot = { input: 0, cc: 0, cr: 0, output: 0, cost: 0 };
  let peakCtx = 0, first = null, last = null;
  const byFam = new Map();
  let reprimeSavings = 0, idleGaps = 0;
  let gruntSavings = 0, gruntTurns = 0;

  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    tot.input += t.input; tot.cc += t.cc; tot.cr += t.cr; tot.output += t.output;
    const c = costOf(t); tot.cost += c;
    const fam = family(t.model);
    byFam.set(fam, (byFam.get(fam) || 0) + (t.input + t.cc + t.cr + t.output));
    const ctx = t.input + t.cc + t.cr;
    if (ctx > peakCtx) peakCtx = ctx;
    if (Number.isFinite(t.ts)) { if (first === null) first = t.ts; last = t.ts; }

    // idle-gap re-prime: a >5min gap expires the cache, so the next turn pays
    // cache-WRITE for context a warm session would have read cheaply.
    if (i > 0 && Number.isFinite(t.ts) && Number.isFinite(turns[i - 1].ts) && t.ts - turns[i - 1].ts > IDLE_MS) {
      idleGaps++;
      const p = PRICE[fam];
      reprimeSavings += t.cc * (p.cw - p.cr);
    }
    // grunt-on-Opus: a small-output Opus turn that Haiku could likely have done
    if (fam === "opus" && t.output > 0 && t.output < GRUNT_OUTPUT) {
      gruntTurns++;
      gruntSavings += c - costOf(t, "haiku");
    }
  }

  const inputSide = tot.input + tot.cc + tot.cr;
  const cacheHit = inputSide > 0 ? tot.cr / inputSide : 0;
  const durMs = first !== null && last !== null ? last - first : 0;
  const burnHr = durMs > 0 ? tot.cost / (durMs / 3.6e6) : 0;
  const grand = inputSide + tot.output;

  // ── compact runway: context fill velocity → turns to the auto-compact cliff ──
  const ctxSeries = turns.map((t) => t.input + t.cc + t.cr);   // context sent per turn
  const curCtx = ctxSeries[ctxSeries.length - 1] || 0;
  const domFam = [...byFam.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "opus";
  const window = domFam === "haiku" ? 200_000 : peakCtx > 210_000 ? 1_000_000 : 200_000;
  const recent = ctxSeries.slice(-10);
  const deltas = [];
  for (let i = 1; i < recent.length; i++) { const d = recent[i] - recent[i - 1]; if (d > 0) deltas.push(d); }
  const vel = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;  // tokens/turn
  const cliff = 0.85 * window;
  const turnsToCliff = vel > 0 ? Math.max(0, Math.round((cliff - curCtx) / vel)) : null;
  const runway = { curCtx, curPct: curCtx / window, window, velPct: vel / window, turnsToCliff, overCliff: curCtx >= cliff };

  const findings = [];
  if (reprimeSavings > 0.01)
    findings.push({ key: "cache", save: reprimeSavings, est: false,
      title: "cache misses from idle gaps",
      detail: `${idleGaps} gap${idleGaps === 1 ? "" : "s"} >5min re-primed context. Keep sessions warm — /compact at a stopping point instead of walking away; cache reads are ~10× cheaper than re-writes.` });
  if (gruntSavings > 0.01)
    findings.push({ key: "model", save: gruntSavings, est: true,
      title: "possible grunt work on Opus",
      detail: `${gruntTurns} Opus turn${gruntTurns === 1 ? "" : "s"} had small output — some may be mechanical (search, renames, edits) that Haiku does ~15× cheaper. Upper bound: short output can also be a tool call after real reasoning, so treat this as a ceiling, not a bill.` });
  findings.sort((a, b) => b.save - a.save);

  const solid = reprimeSavings;                       // measured, not heuristic
  const estimate = gruntSavings;                      // upper-bound
  return {
    project, turns: turns.length, durMs, burnHr, peakCtx, runway,
    cacheHit, cost: tot.cost, grand, breakdown: tot,
    models: [...byFam.entries()].map(([f, tokens]) => ({ family: f, tokens })).sort((a, b) => b.tokens - a.tokens),
    findings, solid, estimate,
    solidPct: tot.cost > 0 ? solid / tot.cost : 0,
  };
}

// ─── format ─────────────────────────────────────────────────────────────────────
function human(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(0) + "K";
  return String(Math.round(n));
}
function dur(ms) {
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}
function bar(frac, w = 10) {
  const f = Math.max(0, Math.min(w, Math.round(frac * w)));
  return "█".repeat(f) + "░".repeat(w - f);
}
function report(a, color) {
  const P = "\x1b[38;2;133;62;204m", D = "\x1b[38;2;127;99;156m", I = "\x1b[38;2;76;40;113m", B = "\x1b[1m", R = "\x1b[0m";
  const c = (code, s) => (color ? code + s + R : s);
  const L = [];
  L.push("");
  L.push("  " + c(B + P, "maxx · session optimizer"));
  L.push("  " + c(D, `${a.project} · ${a.turns} turns · ${dur(a.durMs)}`));
  L.push("  " + c(D, "spend ") + c(I + B, `$${a.cost.toFixed(2)}`) + c(D, `  ·  $${a.burnHr.toFixed(2)}/hr pace  ·  cache-hit `) + c(I, `${(a.cacheHit * 100).toFixed(0)}%`));
  L.push("");
  const g = a.grand || 1, bd = a.breakdown;
  const rows = [
    ["cache read ", bd.cr, "cheap ✓"],
    ["fresh input", bd.input, ""],
    ["cache write", bd.cc, "expensive"],
    ["output     ", bd.output, ""],
  ];
  L.push("  " + c(D, "where the tokens went"));
  for (const [label, v, note] of rows)
    L.push("    " + c(D, label) + " " + c(P, bar(v / g)) + " " + c(I, `${((v / g) * 100).toFixed(0)}%`.padStart(4)) + (note ? c(D, "  " + note) : ""));
  L.push("");
  // compact runway — the "when to compact" answer
  const rw = a.runway;
  L.push("  " + c(D, "compact runway"));
  L.push("    " + c(D, "current ctx ") + c(P, bar(rw.curPct)) + " " + c(I + B, `${(rw.curPct * 100).toFixed(0)}%`)
    + c(D, `  (${human(rw.curCtx)} / ${human(rw.window)})`) + (rw.velPct > 0 ? c(D, `   filling ~${(rw.velPct * 100).toFixed(1)}%/turn`) : ""));
  let advice;
  if (rw.overCliff) advice = "over the 85% cliff — /compact now, at the first clean break.";
  else if (rw.turnsToCliff === null) advice = "context is stable — compact whenever you switch tasks.";
  else advice = `~${rw.turnsToCliff} turn${rw.turnsToCliff === 1 ? "" : "s"} to the 85% cliff. Best compact: your next task boundary within ~${rw.turnsToCliff}.`;
  L.push("    " + c(P + B, "→ ") + c(I, advice));
  L.push("");
  if (a.findings.length) {
    L.push("  " + c(D, "findings ") + c(D, "(ranked by $ saved)"));
    a.findings.forEach((f, i) => {
      const tag = f.save > 0 ? c(I + B, `${f.est ? "up to " : ""}~$${f.save.toFixed(2)}`) : c(D, "quality");
      L.push("    " + c(P + B, `${i + 1}.`) + " " + c(B + I, f.title) + "   " + tag);
      // wrap detail at ~82 cols
      const words = f.detail.split(" "); let ln = "      ";
      for (const w of words) { if ((ln + w).length > 82) { L.push(c(D, ln)); ln = "      "; } ln += w + " "; }
      L.push(c(D, ln.replace(/\s+$/, "")));
    });
    L.push("");
    L.push("  " + c(B + P, "bottom line: ") + c(B + I, `~$${a.solid.toFixed(2)} solid`)
      + c(D, ` (${(a.solidPct * 100).toFixed(0)}% of spend, measured)`)
      + (a.estimate > 0.01 ? c(D, ` · up to ~$${a.estimate.toFixed(2)} more if grunt-routing applies`) : ""));
  } else {
    L.push("  " + c(P, "running clean — no material waste found this session. ✓"));
  }
  L.push("");
  return L.join("\n");
}

// ─── main ────────────────────────────────────────────────────────────────────────
async function main() {
  const o = parseArgs(process.argv.slice(2));
  const file = await newestSession(o.dir);
  if (!file) { process.stderr.write("maxx: no session transcripts found under " + o.dir + "\n"); process.exit(1); }
  const parsed = await parseSession(file);
  if (parsed.turns.length < 2) { process.stderr.write("maxx: not enough turns in the latest session to analyze yet.\n"); process.exit(1); }
  const a = analyze(parsed);
  process.stdout.write(o.json ? JSON.stringify(a, null, 2) + "\n" : report(a, o.color) + "\n");
}
main().catch((e) => { process.stderr.write("maxx: " + e.message + "\n"); process.exit(1); });
