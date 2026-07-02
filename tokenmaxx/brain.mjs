#!/usr/bin/env node
/**
 * maxx brain — watches the back-and-forth and gives real-time advice.
 *
 * Fired by a Claude Code hook (Stop) each turn. Reads the recent transcript,
 * runs cheap heuristics for the reflexes (re-reads, edit loops, repeated
 * commands, cache death, thrash), and — when something's ambiguous — asks a
 * cheap Haiku call for judgment via the `claude` CLI (your existing auth, same
 * Anthropic your session already talks to). Writes the top nudge to the state
 * bus (~/.tokenmaxx/state.json); the statusline is the face that shows it.
 *
 *   node brain.mjs                 # hook mode: reads hook JSON on stdin
 *   node brain.mjs --file X.jsonl  # analyze a specific transcript
 *   node brain.mjs --dry           # print the verdict, don't write the bus
 *   node brain.mjs --judge         # also run the Haiku judgment layer
 */
import { createReadStream, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";

const HOME = homedir();
const STATE = path.join(HOME, ".tokenmaxx", "state.json");
const PROJECTS = path.join(HOME, ".claude", "projects");
const WINDOW = 50;            // how many recent transcript messages the brain looks at

// ─── locate the session transcript ───────────────────────────────────────────
async function newest(dir) {
  let best = null;
  async function walk(d) {
    let es; try { es = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) await walk(f);
      else if (e.isFile() && e.name.endsWith(".jsonl")) {
        const m = (await stat(f)).mtimeMs;
        if (!best || m > best.m) best = { f, m };
      }
    }
  }
  await walk(dir);
  return best?.f || null;
}

// ─── parse the tail: tool actions + usage + timing (the raw feed) ─────────────
async function feed(file) {
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  const turns = [];
  for await (const line of rl) {
    if (!line || line[0] !== "{") continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    const msg = r.message;
    if (!msg) continue;
    const tools = [];
    if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b?.type === "tool_use") {
          const inp = b.input || {};
          tools.push({ name: b.name, path: inp.file_path || inp.path || null, cmd: inp.command || null });
        }
      }
    }
    const u = msg.usage || {};
    turns.push({
      role: msg.role,
      ts: r.timestamp ? Date.parse(r.timestamp) : NaN,
      tools,
      cc: u.cache_creation_input_tokens || 0,
      cr: u.cache_read_input_tokens || 0,
    });
  }
  return turns;
}

// ─── heuristics — the reflexes (free, every turn) ─────────────────────────────
function reflexes(turns) {
  const recent = turns.slice(-WINDOW);
  const signals = [];
  const reads = {}, edits = {}, cmds = {};
  let idleReprime = 0;
  for (let i = 0; i < recent.length; i++) {
    const t = recent[i];
    for (const tl of t.tools) {
      if (tl.name === "Read" && tl.path) reads[tl.path] = (reads[tl.path] || 0) + 1;
      if ((tl.name === "Edit" || tl.name === "Write") && tl.path) edits[tl.path] = (edits[tl.path] || 0) + 1;
      if (tl.name === "Bash" && tl.cmd) { const k = tl.cmd.trim().slice(0, 60); cmds[k] = (cmds[k] || 0) + 1; }
    }
    if (i > 0 && Number.isFinite(t.ts) && Number.isFinite(recent[i - 1].ts)
        && t.ts - recent[i - 1].ts > 5 * 60000 && t.cc > 5000) idleReprime++;
  }
  const base = (o) => path.basename(Object.entries(o).sort((a, b) => b[1] - a[1])[0]?.[0] || "");
  const top = (o) => Math.max(0, ...Object.values(o));
  if (top(edits) >= 4) signals.push({ sev: 3, kind: "thrash", msg: `editing ${base(edits)} on repeat (${top(edits)}×) — stuck? step back or try a different angle` });
  if (top(cmds) >= 3) signals.push({ sev: 3, kind: "loop", msg: `re-running the same command (${top(cmds)}×) — it's not the input, change the approach` });
  if (top(reads) >= 3) signals.push({ sev: 2, kind: "reread", msg: `re-reading ${base(reads)} (${top(reads)}×) — it's already in context; don't re-load it` });
  if (idleReprime >= 1) signals.push({ sev: 1, kind: "cache", msg: `cache re-primed after an idle gap — keep sessions warm, ~10× cheaper` });
  signals.sort((a, b) => b.sev - a.sev);
  return signals;
}

// ─── judgment — the smart layer (cheap Haiku via your existing claude CLI) ────
function judge(turns) {
  // compact, content-light digest: just the shape of recent actions
  const acts = turns.slice(-WINDOW).flatMap(t => t.tools.map(x => x.name + (x.path ? " " + path.basename(x.path) : x.cmd ? " $" : ""))).join(", ");
  const prompt = `You are a build coach watching a coding session. Recent tool actions: ${acts}. In <=12 words, is the dev making progress or stuck/spinning, and one concrete nudge. No preamble.`;
  const r = spawnSync("claude", ["-p", "--model", "claude-haiku-4-5", prompt], { encoding: "utf8", timeout: 30000 });
  if (r.status === 0 && r.stdout) return r.stdout.trim().slice(0, 120);
  return null;
}

// ─── write the verdict to the state bus (the face reads this) ─────────────────
function publish(advice) {
  let s = {}; try { s = JSON.parse(readFileSync(STATE, "utf8")); } catch {}
  s.advice = advice; s.advice_ts = Date.now();
  mkdirSync(path.dirname(STATE), { recursive: true });
  writeFileSync(STATE, JSON.stringify(s, null, 2));
}

async function main() {
  const argv = process.argv.slice(2);
  const dry = argv.includes("--dry"), doJudge = argv.includes("--judge");
  let file = null;
  const fi = argv.indexOf("--file"); if (fi >= 0) file = argv[fi + 1];
  if (!file) {                                   // hook mode: transcript_path on stdin
    try { const h = JSON.parse(readFileSync(0, "utf8")); file = h.transcript_path; } catch {}
  }
  if (!file) file = await newest(PROJECTS);
  if (!file) { process.stderr.write("brain: no transcript\n"); process.exit(0); }

  const turns = await feed(file);
  const signals = reflexes(turns);
  let advice = signals[0]?.msg || null;
  if (doJudge && (!advice || signals[0].sev < 2)) {   // escalate to Haiku when reflexes are quiet/ambiguous
    const j = judge(turns);
    if (j) advice = j;
  }

  console.log(JSON.stringify({ turns: turns.length, signals, advice }, null, 2));
  if (!dry && advice) publish(advice);
}
main().catch(e => { process.stderr.write("brain: " + e.message + "\n"); process.exit(0); });
