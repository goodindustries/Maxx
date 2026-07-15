#!/usr/bin/env node
/**
 * token nazi — an hourly posture check an AGENT runs to manage its own token burn.
 *
 *   node nazi.mjs            → human report + a machine NAZI=… first line
 *   node nazi.mjs --json     → JSON only (for programmatic agents)
 *
 * It reads what maxx already knows — no new counting:
 *   ~/.tokenmaxx/status.json  the live posture (weekly %/left, roll-session budget, ctx%, cache, sessions, model)
 *   ~/.tokenmaxx/window.json  the burn history (per-bucket tokens → last-1h / last-6h trend)
 *   CLAUDE.md files           the always-on context tax (global + project) loaded on EVERY message
 *
 * …and turns it into a ranked list of the biggest token drains + the single highest-leverage move
 * for THIS hour. The point isn't more numbers — it's the one lever to flip so the week doesn't run dry.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const HOME = homedir();
const readJSON = (p, d = null) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return d; } };
const fileTok = (p) => { try { return Math.round(readFileSync(p, "utf8").length / 4); } catch { return 0; } }; // ~4 chars/token
const n = (x) => Math.round(x || 0).toLocaleString("en-US");
const tk = (x) => Math.round(Math.abs(x || 0) / 1000).toLocaleString("en-US") + "k";

const wantJSON = process.argv.includes("--json");
const st = readJSON(path.join(HOME, ".tokenmaxx", "status.json"));
if (!st) {
  const msg = "token nazi — no status yet. Open Claude Code so the statusline writes ~/.tokenmaxx/status.json, then retry.";
  process.stdout.write((wantJSON ? JSON.stringify({ error: "no-status" }) : msg) + "\n");
  process.exit(0);
}

const S = st.session || {}, W = st.weekly || {};

// ── burn trend from the raw buckets (gross maxx-counted tokens; ~2× Anthropic on cache-heavy work,
//    so it's a RELATIVE signal — is burn rising or falling — not an absolute charge).
const win = readJSON(path.join(HOME, ".tokenmaxx", "window.json"));
let burn1h = 0, burn6h = 0, burnPrev1h = 0;
if (win && Array.isArray(win.buckets)) {
  const now = Date.now(), sum = (lo, hi) => win.buckets.reduce((s, b) => (b[0] > now - hi && b[0] <= now - lo ? s + b[1] : s), 0);
  burn1h = sum(0, 3600e3); burnPrev1h = sum(3600e3, 7200e3); burn6h = sum(0, 6 * 3600e3);
}
const trend = burn1h > burnPrev1h * 1.25 ? "rising" : burn1h < burnPrev1h * 0.75 ? "cooling" : "steady";

// ── always-on context tax: CLAUDE.md files loaded on every message (global + repo).
const cwd = process.cwd();
const mdFiles = [
  ["global CLAUDE.md", path.join(HOME, ".claude", "CLAUDE.md")],
  ["global RTK.md", path.join(HOME, ".claude", "RTK.md")],
  ["repo CLAUDE.md", path.join(cwd, "CLAUDE.md")],
].map(([label, p]) => ({ label, tok: fileTok(p) })).filter((f) => f.tok > 0);
const claudeMdTok = mdFiles.reduce((s, f) => s + f.tok, 0);

const ctxPct = st.ctxPct || 0, cachePct = st.cachePct ?? 100, sessions = st.sessions || 1, model = st.model || "?";

// ── verdict: is a wall headed for a lockout? session over its sustainable share, or weekly past even-pace.
const sessOver = (S.over || 0) > 0;
const weekHot = (W.usedPct || 0) > (W.elapsedPct || 0) + 5 && (W.usedPct || 0) >= 50; // ahead of even-burn AND materially used
const verdict = sessOver || (W.usedPct || 0) >= 90 ? "over" : weekHot || (S.usedPct || 0) >= 90 ? "hot" : "ok";

// ── ranked drains: each is {sink, detail, lever, weight}. weight orders them; only real ones surface.
const drains = [];
if (model === "Opus") drains.push({ sink: "model", detail: "Opus burns the quota fastest", lever: "drop to Sonnet for routine work (one keystroke)", weight: sessOver || weekHot ? 90 : 55 });
if (sessions > 1) drains.push({ sink: "sessions", detail: `${sessions} sessions burning in parallel → ~${sessions}× the rate`, lever: `close the ${sessions - 1} you're not driving`, weight: 40 + sessions * 12 });
if (cachePct < 85) drains.push({ sink: "cache", detail: `cache ${cachePct}% — misses pay full freight`, lever: "stop rewriting early context; append instead of editing history", weight: cachePct < 60 ? 80 : 45 });
if (ctxPct >= 65) drains.push({ sink: "context", detail: `context ${ctxPct}% full — every turn re-sends it all`, lever: "commit at a clean stop, then /compact", weight: ctxPct >= 85 ? 85 : 50 });
if (claudeMdTok >= 4000) drains.push({ sink: "claude.md", detail: `~${tk(claudeMdTok)} tokens of CLAUDE.md loaded EVERY message`, lever: "trim/compress the global + repo instructions", weight: 30 + Math.min(30, claudeMdTok / 400) });
if (trend === "rising") drains.push({ sink: "trend", detail: `burn rising — ${tk(burn1h)}/hr vs ${tk(burnPrev1h)}/hr prior`, lever: "you're accelerating; ease off or you'll hit the wall early", weight: 60 });
drains.sort((a, b) => b.weight - a.weight);

const topMove = drains[0]?.lever || (verdict === "ok" ? "on track — keep shipping the smallest thing that works" : "wrap up cleanly before the wall");

// ── machine line first: an agent greps this; the prose below is for a human reading over its shoulder.
const machine = `NAZI verdict=${verdict} weekly_left=${W.headroom || 0} weekly_pct=${W.usedPct || 0} session_tospend=${S.toSpend || 0} session_permin=${S.spendPerMin || 0} ctx_pct=${ctxPct} cache_pct=${cachePct} claudemd_tok=${claudeMdTok} sessions=${sessions} model=${model} burn_1h=${Math.round(burn1h)} burn_6h=${Math.round(burn6h)} trend=${trend} top_lever="${topMove}"`;

if (wantJSON) {
  process.stdout.write(JSON.stringify({
    verdict, weekly: { left: W.headroom || 0, usedPct: W.usedPct || 0, resetIn: W.resetIn || "?" },
    session: { name: "roll-session", toSpend: S.toSpend || 0, perMin: S.spendPerMin || 0, over: S.over || 0, resetIn: S.resetIn || "?" },
    burn: { last1h: Math.round(burn1h), last6h: Math.round(burn6h), trend },
    context: { ctxPct, cachePct, claudeMdTok, claudeMdFiles: mdFiles },
    sessions, model, drains, topMove,
  }, null, 2) + "\n");
  process.exit(0);
}

const L = [];
L.push(machine);
L.push("");
L.push(`token nazi — hourly posture  ·  verdict: ${verdict.toUpperCase()}`);
L.push("");
L.push(`  weekly        ${n(W.headroom)} left  ·  ${W.usedPct || 0}% used  ·  resets ${W.resetIn || "?"}`);
if (sessOver) L.push(`  roll-session  ${n(S.over)} OVER your sustainable share  ·  ease off  ·  resets ${S.resetIn || "?"}`);
else L.push(`  roll-session  ${n(S.toSpend)} to spend  ·  ~${n(S.spendPerMin)}/min  ·  resets ${S.resetIn || "?"}`);
L.push(`  burn          ${tk(burn1h)}/hr now  ·  ${tk(burn6h)} last 6h  ·  ${trend}`);
L.push("");
if (drains.length) {
  L.push("  biggest drains (highest leverage first):");
  for (const d of drains) L.push(`    · ${d.sink.padEnd(9)} ${d.detail}  →  ${d.lever}`);
} else {
  L.push("  no standout drains — cache warm, context light, single session.");
}
L.push("");
L.push(`  do this hour →  ${topMove}`);
process.stdout.write(L.join("\n") + "\n");
