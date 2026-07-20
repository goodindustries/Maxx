#!/usr/bin/env node
/**
 * fenix — burn down, rise with context. The maxx rebirth loop.
 *
 * The /fenix skill has the AGENT write .fenix/handoff.md (what's in motion, decisions,
 * next steps), then the human clears context. This file is the OTHER half:
 *
 *   node fenix.mjs --wake     SessionStart hook. If the cwd has a fresh unconsumed
 *                             handoff, print it (hook stdout becomes session context)
 *                             and mark it consumed — read=consume, exactly like the
 *                             maxx directive channel. Silent no-op otherwise.
 *   node fenix.mjs --status   Show pending/consumed handoffs for this directory.
 *
 * Unattended continuation (the "cron" half): after /fenix you can also relaunch
 * headless — `claude -p "$(cat .fenix/handoff.md)"` — or let the next interactive
 * session in this directory pick it up automatically via --wake.
 */
import { readFileSync, writeFileSync, renameSync, statSync, readdirSync, existsSync, openSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

const DIR = path.join(process.cwd(), ".fenix");
const HANDOFF = path.join(DIR, "handoff.md");
const MAX_AGE_H = 48; // a stale handoff is history, not context — never auto-inject old state

const arg = process.argv[2] || "--wake";

if (arg === "--wake") {
  // SessionStart hooks get {source: startup|clear|resume|compact} on stdin — after a /clear
  // with NO handoff, say so (the observed first-run failure: user cleared without /fenix
  // first, then "continue" had nothing to continue from). Manual runs (TTY) stay quiet.
  let src = "";
  try { if (!process.stdin.isTTY) src = (JSON.parse(readFileSync(0, "utf8") || "{}").source || ""); } catch {}
  try {
    const st = statSync(HANDOFF);
    const ageH = (Date.now() - st.mtimeMs) / 3600000;
    if (ageH > MAX_AGE_H) process.exit(0);
    const body = readFileSync(HANDOFF, "utf8");
    // consume BEFORE printing: a crash mid-print must not re-inject next session
    renameSync(HANDOFF, path.join(DIR, `handoff.consumed-${new Date().toISOString().replace(/[:.]/g, "-")}.md`));
    process.stdout.write(
      `🔥 FENIX — this session rises from a cleared one. The handoff below is what was in motion ` +
      `(written ${Math.round(ageH * 60)}m ago, now consumed). Resume it; verify claims against the ` +
      `working tree before trusting them.\n\n${body}\n`
    );
  } catch {
    if (src === "clear")
      process.stdout.write("fenix: no handoff in this directory — nothing carried over. Sequence is /fenix BEFORE /clear (handoffs are per-directory, written to .fenix/handoff.md; fenix cannot resurrect an already-wiped thread).\n");
  }
  process.exit(0);
}

// --rise: the SELF-SUSTAINING rebirth. /clear is a human keystroke the model can't press —
// but a new process is a fresh context by construction. Each risen generation carries the
// standing order to fenix AGAIN when its context gets heavy or its turn would end with work
// in motion — so the chain continues until the mission is done or a brake trips:
//   · generation cap (.fenix/generation, default 5, MAXX_RISE_MAX_GEN overrides)
//   · budget brake: at the 5h wall the rise is not refused but DELAYED — a detached sleeper
//     re-runs --rise right after the window refills (the "cron" half, no crontab needed).
// Child flags: --permission-mode acceptEdits by default; MAXX_RISE_FLAGS overrides.
if (arg === "--rise") {
  if (!existsSync(HANDOFF)) { console.error("fenix: no pending handoff to rise from."); process.exit(1); }
  const GEN_F = path.join(DIR, "generation");
  const gen = (() => { try { return parseInt(readFileSync(GEN_F, "utf8"), 10) || 0; } catch { return 0; } })();
  const maxGen = parseInt(process.env.MAXX_RISE_MAX_GEN || "5", 10);
  if (gen >= maxGen) { console.error(`fenix: generation cap (${gen}/${maxGen}) — chain ends here. rm .fenix/generation to restart.`); process.exit(1); }
  // budget brake — the maxx window cache knows if we're at the wall
  const HOME = process.env.HOME || "";
  let win = null, rl = null;
  try { win = JSON.parse(readFileSync(path.join(HOME, ".maxx", "window.json"), "utf8")); } catch {}
  try { rl = JSON.parse(readFileSync(path.join(HOME, ".maxx", "rl.json"), "utf8")); } catch {}
  const atWall = win && (win.sessionToSpend === 0 || win.sessionOver > 0);
  if (atWall && !process.env.MAXX_RISE_NOW) {
    const resetAt = rl && rl.fiveResetAt ? rl.fiveResetAt * 1000 : Date.now() + 3600000;
    const delaySec = Math.max(60, Math.round((resetAt - Date.now()) / 1000) + 120);
    const self = process.argv[1];
    const sleeper = spawn("sh", ["-c", `sleep ${delaySec} && MAXX_RISE_NOW=1 node "${self}" --rise`],
      { cwd: process.cwd(), detached: true, stdio: "ignore" });
    sleeper.unref();
    console.log(`fenix: at the wall — rise scheduled in ${Math.round(delaySec / 60)}m (when the window refills). sleeper pid ${sleeper.pid}`);
    process.exit(0);
  }
  const body = readFileSync(HANDOFF, "utf8");
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  renameSync(HANDOFF, path.join(DIR, `handoff.consumed-${ts}.md`)); // consume FIRST: the child's --wake hook must not double-inject
  writeFileSync(GEN_F, String(gen + 1));
  const log = path.join(DIR, `rise-${ts}.log`);
  const fd = openSync(log, "a");
  const flags = (process.env.MAXX_RISE_FLAGS || "--permission-mode acceptEdits").split(/\s+/).filter(Boolean);
  const prompt =
    `🔥 FENIX RISE — generation ${gen + 1}/${maxGen}. You are the continuation of a cleared session. ` +
    `Resume the handoff below; verify its claims against the working tree first.\n\n` +
    `STANDING ORDER (this is what makes you a phoenix, not a fork): when your context passes ~70%, ` +
    `or you must stop with work still in motion, run /fenix again — write .fenix/handoff.md exactly per ` +
    `the fenix skill, then run \`node ${process.argv[1]} --rise\` and END your turn. The next generation ` +
    `continues. If the mission is COMPLETE, write .fenix/DONE.md with the outcome instead and stop.\n\n${body}`;
  const child = spawn("claude", ["-p", prompt, ...flags], { cwd: process.cwd(), detached: true, stdio: ["ignore", fd, fd] });
  child.unref();
  console.log(`fenix: risen — generation ${gen + 1}/${maxGen} · pid ${child.pid} · log ${log}`);
  process.exit(0);
}

if (arg === "--status") {
  if (!existsSync(DIR)) { console.log("fenix: no .fenix/ here — nothing pending."); process.exit(0); }
  const pending = existsSync(HANDOFF) ? `PENDING (${Math.round((Date.now() - statSync(HANDOFF).mtimeMs) / 60000)}m old)` : "none";
  const consumed = readdirSync(DIR).filter((f) => f.startsWith("handoff.consumed-")).length;
  console.log(`fenix: pending handoff: ${pending} · consumed: ${consumed}`);
  process.exit(0);
}

console.error("fenix: unknown arg (use --wake | --rise | --status)");
process.exit(1);
