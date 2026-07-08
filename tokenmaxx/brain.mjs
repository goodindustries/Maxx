#!/usr/bin/env node
/**
 * maxx brain — real-time build guidance, ZERO EGRESS. Everything runs locally; nothing ever
 * leaves the box (no network, no LLM call, not even a read of your prompt/message text).
 *
 * Fired by a Claude Code hook (Stop) each turn. It reads only the TOOL ACTIONS from the recent
 * transcript (tool names + file paths + command strings — never prompt or assistant text), runs
 * cheap local heuristics (edit thrash, command loops, circling the same file), and writes the top
 * nudge to the state bus (~/.tokenmaxx/state.json) that the statusline reads. It also refreshes the
 * rolling-token window (window.json) on a cadence by running limit.mjs — again, a purely local scan.
 *
 *   node brain.mjs                 # hook mode: reads hook JSON on stdin
 *   node brain.mjs --file X.jsonl  # analyze a specific transcript
 *   node brain.mjs --dry           # print the verdict, don't write the bus
 */
import { createReadStream, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HOME = homedir();
const STATE = path.join(HOME, ".tokenmaxx", "state.json");
const PROJECTS = path.join(HOME, ".claude", "projects");
const LIMIT_MARK = path.join(HOME, ".tokenmaxx", ".limit-scan");
const WINDOW = 50;            // how many recent transcript messages the brain looks at
const LIMIT_MS = 90 * 1000;  // refresh the rolling-token window (window.json) at most this often

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

// ─── parse the tail: TOOL ACTIONS only (never prompt or message text) ─────────
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
    turns.push({ tools });
  }
  return turns;
}

// ─── heuristics — the reflexes (local, every turn, free) ──────────────────────
function reflexes(turns) {
  const recent = turns.slice(-WINDOW);
  const reads = {}, edits = {}, cmds = {};
  for (const t of recent) {
    for (const tl of t.tools) {
      if (tl.name === "Read" && tl.path) reads[tl.path] = (reads[tl.path] || 0) + 1;
      if ((tl.name === "Edit" || tl.name === "Write") && tl.path) edits[tl.path] = (edits[tl.path] || 0) + 1;
      if (tl.name === "Bash" && tl.cmd) { const k = tl.cmd.trim().slice(0, 60); cmds[k] = (cmds[k] || 0) + 1; }
    }
  }
  const base = (o) => path.basename(Object.entries(o).sort((a, b) => b[1] - a[1])[0]?.[0] || "");
  const top = (o) => Math.max(0, ...Object.values(o));
  const signals = [];
  if (top(edits) >= 4) signals.push({ sev: 3, msg: `editing ${base(edits)} on repeat (${top(edits)}×) — stuck? step back or try a different angle` });
  if (top(cmds) >= 3) signals.push({ sev: 3, msg: `re-running the same command (${top(cmds)}×) — it's not the input, change the approach` });
  if (top(reads) >= 3) signals.push({ sev: 2, msg: `circling ${base(reads)} (${top(reads)}×) — you've seen it; make the call and move` });
  signals.sort((a, b) => b.sev - a.sev);
  return signals;
}

// generic cadence gate (for the window.json refresh)
function dueFor(mark, ms) {
  try { return Date.now() - Number(readFileSync(mark, "utf8")) > ms; } catch { return true; }
}
function markNow(mark) {
  try { mkdirSync(path.dirname(mark), { recursive: true }); writeFileSync(mark, String(Date.now())); } catch {}
}

// ─── write the verdict to the state bus (the face reads this) ─────────────────
// Atomic write: temp + rename, so the 1s renderer never reads a half-written file.
function writeStateAtomic(s) {
  mkdirSync(path.dirname(STATE), { recursive: true });
  const tmp = `${STATE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, STATE);
}
// advice is PER SESSION — keyed by session_id — so your bar never shows a nudge derived from a
// different concurrent session's transcript.
function publish(advice, sid) {
  let s = {}; try { s = JSON.parse(readFileSync(STATE, "utf8")); } catch {}
  if (sid) {
    if (!s.sessions) s.sessions = {};
    const cutoff = Date.now() - 2 * 3600 * 1000;   // prune slots gone quiet >2h so it can't grow forever
    for (const k of Object.keys(s.sessions)) if ((s.sessions[k].advice_ts || 0) < cutoff) delete s.sessions[k];
    s.sessions[sid] = { advice, advice_ts: Date.now() };
  } else {
    s.advice = advice; s.advice_ts = Date.now();   // no session id (e.g. --file with no --sid) → legacy global slot
  }
  writeStateAtomic(s);
}

async function main() {
  const argv = process.argv.slice(2);
  const dry = argv.includes("--dry");
  let file = null, sid = null;
  const fi = argv.indexOf("--file"); if (fi >= 0) file = argv[fi + 1];
  const si = argv.indexOf("--sid"); if (si >= 0) sid = argv[si + 1] || null;
  if (!file) {                                   // hook mode: transcript_path + session_id on stdin
    try { const h = JSON.parse(readFileSync(0, "utf8")); file = h.transcript_path; sid = sid || h.session_id || null; } catch {}
  }
  if (!file) file = await newest(PROJECTS);
  if (!file) process.exit(0);

  const turns = await feed(file);

  // REFLEX MODE — local heuristics only, publish immediately. (The richer pace/model coaching is
  // computed locally in render.mjs; this supplies the edit-loop nudges.)
  const signals = reflexes(turns);
  const advice = signals[0]?.msg || null;
  if (!dry && advice) publish(advice, sid);
  if (dry) console.log(JSON.stringify({ turns: turns.length, signals, advice }, null, 2));

  // Refresh the rolling-token window (window.json the bar reads for burned/limit). A LOCAL scan of
  // all sessions, run detached on a cadence — off the hook's critical path.
  if (!dry && dueFor(LIMIT_MARK, LIMIT_MS)) {
    markNow(LIMIT_MARK);
    try {
      spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "limit.mjs")],
            { detached: true, stdio: "ignore" }).unref();
    } catch {}
  }
}
main().catch(e => { process.stderr.write("brain: " + e.message + "\n"); process.exit(0); });
