#!/usr/bin/env node
/**
 * maxx brain — watches the back-and-forth and gives real-time build guidance.
 *
 * Fired by a Claude Code hook (Stop) each turn. Reads the recent transcript,
 * runs cheap heuristics for the reflexes (edit thrash, command loops, circling
 * the same file), and — on a background cadence — asks a cheap Haiku call (via the
 * `claude` CLI, your existing auth) to judge the session across three lenses:
 * PRODUCT (a slight build hint), PROMPT (coach how you're prompting), STUCK (name
 * the fix). Prompt text is redacted before it's sent. Writes the top nudge to the
 * state bus (~/.tokenmaxx/state.json); the statusline is the face that shows it.
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
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HOME = homedir();
const STATE = path.join(HOME, ".tokenmaxx", "state.json");
const PROJECTS = path.join(HOME, ".claude", "projects");
const JUDGE_MARK = path.join(HOME, ".tokenmaxx", ".brain-judge");
const WINDOW = 50;            // how many recent transcript messages the brain looks at
const CADENCE_MS = 5 * 60 * 1000;   // think (Haiku) at most this often, in the background

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
    // your actual prompt text (only real user turns — skip tool_result turns and the
    // harness noise). Fuels the prompt-coaching lens; redacted before it ever leaves.
    let text = "";
    if (msg.role === "user") {
      const blocks = typeof msg.content === "string"
        ? [{ type: "text", text: msg.content }]
        : (Array.isArray(msg.content) ? msg.content : []);
      text = blocks
        .filter(b => b?.type === "text" && typeof b.text === "string")
        .map(b => b.text)
        .filter(t => !/system-reminder|<command-name>|hook additional context/i.test(t))
        .join(" ")
        .trim();
    }
    const u = msg.usage || {};
    turns.push({
      role: msg.role,
      ts: r.timestamp ? Date.parse(r.timestamp) : NaN,
      tools,
      text,
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
  for (let i = 0; i < recent.length; i++) {
    const t = recent[i];
    for (const tl of t.tools) {
      if (tl.name === "Read" && tl.path) reads[tl.path] = (reads[tl.path] || 0) + 1;
      if ((tl.name === "Edit" || tl.name === "Write") && tl.path) edits[tl.path] = (edits[tl.path] || 0) + 1;
      if (tl.name === "Bash" && tl.cmd) { const k = tl.cmd.trim().slice(0, 60); cmds[k] = (cmds[k] || 0) + 1; }
    }
  }
  const base = (o) => path.basename(Object.entries(o).sort((a, b) => b[1] - a[1])[0]?.[0] || "");
  const top = (o) => Math.max(0, ...Object.values(o));
  if (top(edits) >= 4) signals.push({ sev: 3, kind: "thrash", msg: `editing ${base(edits)} on repeat (${top(edits)}×) — stuck? step back or try a different angle` });
  if (top(cmds) >= 3) signals.push({ sev: 3, kind: "loop", msg: `re-running the same command (${top(cmds)}×) — it's not the input, change the approach` });
  if (top(reads) >= 3) signals.push({ sev: 2, kind: "reread", msg: `circling ${base(reads)} (${top(reads)}×) — you've seen it; make the call and move` });
  signals.sort((a, b) => b.sev - a.sev);
  return signals;
}

// redact obvious secrets from prompt text BEFORE it's ever sent to the judge.
// Belt-and-suspenders — it goes only to your own `claude` auth, but keys never should.
function redact(s) {
  return s
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "«pemkey»")
    .replace(/\b(sk-[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{12,})\b/g, "«key»")
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, "Bearer «token»")
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "«email»")
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, "«hex»");
}

// ─── judgment — the smart layer (cheap Haiku via your existing claude CLI) ────
// A calm, Naval-esque advisor beside the builder. Prefers a QUESTION over a command
// — one thing to think about, given the context. Lenses: PRODUCT (a context-based
// "have you thought about X?"), PROMPT (coach how they're prompting), STUCK (a gentle
// reframe). Tool actions are content-light (names + basenames); prompt text is
// redacted first.
function judge(turns) {
  const recent = turns.slice(-WINDOW);
  const acts = recent.flatMap(t => t.tools.map(x => x.name + (x.path ? " " + path.basename(x.path) : x.cmd ? " $cmd" : ""))).join(", ");
  const prompts = recent
    .filter(t => t.role === "user" && t.text)
    .slice(-4)
    .map(t => "• " + redact(t.text).replace(/\s+/g, " ").slice(0, 180))
    .join("\n");
  if (!acts && !prompts) return null;
  const prompt = `You are a calm, Naval-Ravikant-style advisor sitting beside a builder — pithy, first-principles, never bossy. You watch their session and offer ONE thing to think about, as a question or a short aphorism (max 15 words).

Recent tool actions (oldest first): ${acts || "(none)"}

Their recent prompts to the AI (redacted): ${prompts || "(none)"}

Pick the single most useful nudge, in this spirit:
- PRODUCT (prefer this): a context-based open question — e.g. "have you thought about who this is for?", "what's the one feature that makes the rest optional?", "is this leverage or busywork?", "what would make this 10x simpler?". Be specific to what they're building.
- PROMPT: if their prompting costs them, ask it — "could you point it at the file instead of pasting?", "what's your done-condition here?".
- STUCK: if they're clearly spinning — "what if the approach is the problem, not the input?".

Prefer a question over a command. If nothing earns a line, reply exactly "ok". No preamble, no quotes, no markdown.`;
  // MAXX_BRAIN_CHILD flags claude's own Stop hook so a nested brain bails (no recursion).
  const r = spawnSync("claude", ["-p", "--model", "haiku", prompt],
                      { encoding: "utf8", timeout: 45000, env: { ...process.env, MAXX_BRAIN_CHILD: "1" } });
  if (r.status !== 0 || !r.stdout) return null;
  const t = r.stdout.trim().replace(/^["']+|["']+$/g, "");
  if (!t || /^ok\b/i.test(t) || t.length > 110) return null;   // "ok" → stay quiet
  return t.slice(0, 100);
}
function dueForJudge() {
  try { return Date.now() - Number(readFileSync(JUDGE_MARK, "utf8")) > CADENCE_MS; }
  catch { return true; }
}
function markJudged() {
  try { mkdirSync(path.dirname(JUDGE_MARK), { recursive: true }); writeFileSync(JUDGE_MARK, String(Date.now())); } catch {}
}

// ─── write the verdict to the state bus (the face reads this) ─────────────────
function publish(advice) {
  let s = {}; try { s = JSON.parse(readFileSync(STATE, "utf8")); } catch {}
  s.advice = advice; s.advice_ts = Date.now();
  mkdirSync(path.dirname(STATE), { recursive: true });
  writeFileSync(STATE, JSON.stringify(s, null, 2));
}

async function main() {
  // Recursion guard: the judge shells out to `claude -p`, whose session could fire
  // the Stop hook again. Any brain spawned under a judge sees this env and bails.
  if (process.env.MAXX_BRAIN_CHILD) process.exit(0);
  const argv = process.argv.slice(2);
  const dry = argv.includes("--dry"), doJudge = argv.includes("--judge");
  let file = null;
  const fi = argv.indexOf("--file"); if (fi >= 0) file = argv[fi + 1];
  if (!file) {                                   // hook mode: transcript_path on stdin
    try { const h = JSON.parse(readFileSync(0, "utf8")); file = h.transcript_path; } catch {}
  }
  if (!file) file = await newest(PROJECTS);
  if (!file) process.exit(0);

  const turns = await feed(file);

  // JUDGE MODE — spawned detached on a cadence. Slow (a Haiku call), off the hook
  // path, so it never blocks your turn. Thinks, then updates the bus.
  if (doJudge) {
    const j = judge(turns);
    if (j && !dry) publish(j);
    if (dry) console.log(JSON.stringify({ mode: "judge", thought: j }, null, 2));
    return;
  }

  // REFLEX MODE — the hook, every turn. Fast heuristics, publish immediately.
  const signals = reflexes(turns);
  const advice = signals[0]?.msg || null;
  if (!dry && advice) publish(advice);
  if (dry) console.log(JSON.stringify({ turns: turns.length, signals, advice }, null, 2));

  // Cadence: when the reflexes are quiet, let the brain THINK in the background.
  const strong = signals[0] && signals[0].sev >= 3;
  if (!dry && !strong && dueForJudge()) {
    markJudged();
    try {
      spawn(process.execPath, [fileURLToPath(import.meta.url), "--judge", "--file", file],
            { detached: true, stdio: "ignore" }).unref();
    } catch {}
  }
}
main().catch(e => { process.stderr.write("brain: " + e.message + "\n"); process.exit(0); });
