#!/usr/bin/env node
/**
 * maxx gate — the HARD budget gate. PreToolUse hook that DENIES token-expensive
 * tool calls (Agent / Task / Workflow spawns) when the central tally says the
 * account is over budget or the signal is stale. The MCP connector's
 * instructions are advisory; this is the enforcement layer — a PreToolUse deny
 * blocks the tool even in bypass mode, and cloud routines honor repo
 * .claude/settings.json hooks too.
 *
 * Hook mode (stdin JSON from Claude Code):
 *   deny  → {"hookSpecificOutput":{"permissionDecision":"deny", ...}}
 *   allow → exit 0, no output (normal permission flow continues)
 *
 * CLI:
 *   node gate.mjs --status              current gate state + live verdict
 *   node gate.mjs --off                 disable (same as overturn, reason "manual off")
 *   node gate.mjs --on                  re-enable
 *   node gate.mjs --overturn "reason"   disable AND record the overturn: noted in
 *                                       ~/.maxx/gate.json + gate.log AND shipped to
 *                                       the central tally feed (visible in maxx watch)
 *
 * Fail-closed: no fresh verdict (server unreachable AND cache >10m old) → deny.
 * That is the whole point — an invisible budget must read as "no budget".
 */
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";

const HOME = homedir();
const DIR = path.join(HOME, ".maxx");
const CONFIG = path.join(DIR, "config.json");
const GATE = path.join(DIR, "gate.json");
const CACHE = path.join(DIR, "gate-cache.json");
const LOG = path.join(DIR, "gate.log");
const CACHE_FRESH_SEC = 60;       // reuse a verdict this fresh without a network call
const CACHE_GRACE_SEC = 600;      // server unreachable: trust a cached verdict up to this age
const GATED = /^(Agent|Task|Workflow|ScheduleWakeup|CronCreate)$/;

const readJSON = (p, d) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return d; } };
const log = (line) => { try { mkdirSync(DIR, { recursive: true }); appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`); } catch {} };

const cfg = readJSON(CONFIG, {});
const base = (process.env.MAXX_LOGS_URL || cfg.logsUrl || "https://api.meetmaxx.co").replace(/\/$/, "");

async function budget() {
  const c = readJSON(CACHE, null);
  const age = c ? Date.now() / 1000 - c.at : Infinity;
  if (c && age < CACHE_FRESH_SEC) return c.b;
  try {
    const res = await fetch(`${base}/api/u/${encodeURIComponent(cfg.handle)}/budget`, {
      headers: { authorization: `Bearer ${cfg.secret}` },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`${res.status}`);
    const b = await res.json();
    writeFileSync(CACHE, JSON.stringify({ at: Date.now() / 1000, b }));
    return b;
  } catch (e) {
    if (c && age < CACHE_GRACE_SEC) return c.b;   // brief outage: last verdict stands
    return { verdict: "unreachable", error: e.message };  // fail closed upstream
  }
}

// Ship a note into the central tally feed (billed:0 — visible, never counted).
async function note(kind, text) {
  try {
    await fetch(`${base}/api/u/${encodeURIComponent(cfg.handle)}/logs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.secret}` },
      body: JSON.stringify({
        v: 1, surface: `gate:${hostname().slice(0, 8)}`, handle: cfg.handle,
        emitted_at: new Date().toISOString(), cursor: `${kind}-${Date.now()}`,
        sessions: [{ root: `${kind}-${Date.now()}`, name: text, billed: 0, last_ts: new Date().toISOString() }],
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {}
}

const args = process.argv.slice(2);
const gate = readJSON(GATE, { enabled: true });

if (args.includes("--status")) {
  const b = await budget();
  console.log(JSON.stringify({ gate: gate.enabled ? "ON" : "OFF", overturn: gate.overturn || null, verdict: b.verdict, session_to_spend: b.session_to_spend ?? null, week: b.week ?? null }, null, 2));
  process.exit(0);
}
if (args.includes("--on")) {
  writeFileSync(GATE, JSON.stringify({ enabled: true }, null, 2));
  log("gate ON");
  await note("gate-on", "GATE RE-ENABLED");
  console.log("maxx gate: ON");
  process.exit(0);
}
if (args.includes("--off") || args.includes("--overturn")) {
  const i = args.indexOf("--overturn");
  const reason = (i >= 0 && args[i + 1]) || "manual off";
  const overturn = { ts: new Date().toISOString(), reason, host: hostname() };
  writeFileSync(GATE, JSON.stringify({ enabled: false, overturn }, null, 2));
  log(`gate OVERTURN: ${reason}`);
  await note("gate-overturn", `⚠ GATE OVERTURNED: ${reason}`);
  console.log(`maxx gate: OFF — overturn RECORDED (local gate.log + central feed): "${reason}"`);
  console.log("re-enable: node gate.mjs --on");
  process.exit(0);
}

// ---- hook mode: PreToolUse JSON on stdin ----
let input = "";
for await (const chunk of process.stdin) input += chunk;
let hook = {};
try { hook = JSON.parse(input); } catch { process.exit(0); }   // not a hook call → allow

const tool = hook.tool_name || "";
if (!GATED.test(tool)) process.exit(0);                         // not an expensive tool → allow

if (!gate.enabled) {
  // overturned — allow, already noted at overturn time; keep a local trace
  log(`allow (gate OFF${gate.overturn ? `, overturn: ${gate.overturn.reason}` : ""}) tool=${tool}`);
  process.exit(0);
}
if (!cfg.handle || !cfg.secret) process.exit(0);                // no maxx account on this box → not our call

const b = await budget();
const over = b.verdict === "over" || b.verdict === "stale" || b.verdict === "unreachable" || b.session_to_spend === 0;
if (!over) process.exit(0);

log(`DENY tool=${tool} verdict=${b.verdict} session_to_spend=${b.session_to_spend ?? "?"}`);
console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason:
      `MAXX BUDGET GATE: verdict=${b.verdict}, session_to_spend=${b.session_to_spend ?? "unknown"} — ` +
      `account-wide budget window has no tokens for expensive work (${tool}). ` +
      `Wait for the window, or the USER may explicitly overturn (recorded to the central feed): ` +
      `node ~/.claude/skills/maxx/gate.mjs --overturn "<reason>"`,
  },
}));
