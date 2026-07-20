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
import { readFileSync, renameSync, statSync, readdirSync, existsSync, openSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

const DIR = path.join(process.cwd(), ".fenix");
const HANDOFF = path.join(DIR, "handoff.md");
const MAX_AGE_H = 48; // a stale handoff is history, not context — never auto-inject old state

const arg = process.argv[2] || "--wake";

if (arg === "--wake") {
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
  } catch { /* no handoff → silent */ }
  process.exit(0);
}

// --rise: the unattended rebirth. /clear is a human keystroke the model can't press —
// but a NEW process is a fresh context by construction. Consume the handoff and spawn a
// detached headless continuation with it as the prompt. Output → .fenix/rise-<ts>.log.
if (arg === "--rise") {
  if (!existsSync(HANDOFF)) { console.error("fenix: no pending handoff to rise from."); process.exit(1); }
  const body = readFileSync(HANDOFF, "utf8");
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  renameSync(HANDOFF, path.join(DIR, `handoff.consumed-${ts}.md`)); // consume FIRST: the child's --wake hook must not double-inject
  const log = path.join(DIR, `rise-${ts}.log`);
  const fd = openSync(log, "a");
  const child = spawn("claude", ["-p", `🔥 FENIX RISE — you are the continuation of a cleared session. Resume the handoff below; verify claims against the working tree first.\n\n${body}`],
    { cwd: process.cwd(), detached: true, stdio: ["ignore", fd, fd] });
  child.unref();
  console.log(`fenix: risen — headless continuation pid ${child.pid} · log ${log}`);
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
