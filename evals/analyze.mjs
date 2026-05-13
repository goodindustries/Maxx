#!/usr/bin/env node
/**
 * Analyze benchmark results to find emergent properties.
 * Answers: which topics and intent types does Maxx help most?
 *
 * Usage:
 *   node evals/analyze.mjs
 *   node evals/analyze.mjs --topic coding
 */

import { getTopicStats, getIntentStats, getTopRuns, getStats } from "../pipeline/db.js";

const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m",
};

const W = 68;
function hr(ch = "─") { return c.dim + ch.repeat(W) + c.reset; }
function pad(s, n) { return String(s).padEnd(n); }
function rpad(s, n) { return String(s).padStart(n); }
function trunc(s, n = 55) { return String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s); }

function deltaBar(delta, width = 20) {
  const val = Math.max(-1, Math.min(1, delta));
  const mid = Math.floor(width / 2);
  if (val >= 0) {
    const filled = Math.round(val * mid);
    return c.dim + "─".repeat(mid) + c.reset + c.green + "█".repeat(filled) + c.reset + c.dim + "░".repeat(mid - filled) + c.reset;
  } else {
    const filled = Math.round(-val * mid);
    return c.dim + "░".repeat(mid - filled) + c.reset + c.red + "█".repeat(filled) + c.reset + c.dim + "─".repeat(mid) + c.reset;
  }
}

function winPct(wins, total) {
  return total ? `${Math.round(wins / total * 100)}%` : "—";
}

function deltaColor(d) {
  if (d > 0.05) return c.green;
  if (d < -0.05) return c.red;
  return c.dim;
}

function main() {
  const overall     = getStats();
  const topicStats  = getTopicStats();
  const intentStats = getIntentStats();
  const topWins     = getTopRuns(8, "DESC");
  const topLosses   = getTopRuns(8, "ASC");

  if (!overall.total) {
    process.stdout.write("No benchmark data yet. Run:\n  node evals/run-benchmark.mjs\n\n");
    return;
  }

  // ── Overall ────────────────────────────────────────────────────────────────
  process.stdout.write("\n" + hr("═") + "\n");
  process.stdout.write(c.bold + "  MAXX BENCHMARK ANALYSIS\n" + c.reset);
  process.stdout.write(hr("═") + "\n\n");

  process.stdout.write(`  Total runs    ${c.bold}${overall.total}${c.reset}\n`);
  process.stdout.write(`  Avg raw       ${c.dim}${overall.avg_raw_score}${c.reset}\n`);
  process.stdout.write(`  Avg maxx      ${c.dim}${overall.avg_maxx_score}${c.reset}\n`);
  const dCol = deltaColor(overall.avg_delta);
  process.stdout.write(`  Avg delta     ${dCol}${overall.avg_delta >= 0 ? "+" : ""}${overall.avg_delta}${c.reset}\n`);
  process.stdout.write(`  Wins          ${c.green}${overall.wins}${c.reset}  (${winPct(overall.wins, overall.total)})\n`);
  process.stdout.write(`  Losses        ${c.red}${overall.losses}${c.reset}  (${winPct(overall.losses, overall.total)})\n`);
  process.stdout.write(`  Ties          ${c.dim}${overall.ties}${c.reset}  (${winPct(overall.ties, overall.total)})\n`);

  // ── By topic ───────────────────────────────────────────────────────────────
  process.stdout.write("\n" + hr() + "\n");
  process.stdout.write(c.bold + "  BY TOPIC  (sorted by avg delta, best → worst)\n" + c.reset);
  process.stdout.write(hr() + "\n\n");

  process.stdout.write(
    `  ${c.dim}${pad("topic", 16)} ${"delta".padStart(7)}  ${"bar".padEnd(22)} ${"wins".padStart(5)} ${"losses".padStart(7)} ${"n".padStart(5)}${c.reset}\n`
  );

  for (const t of topicStats) {
    const d    = Number(t.avg_delta);
    const dStr = (d >= 0 ? "+" : "") + d.toFixed(3);
    process.stdout.write(
      `  ${pad(t.topic, 16)} ${deltaColor(d)}${rpad(dStr, 7)}${c.reset}  ${deltaBar(d)}  ` +
      `${c.green}${rpad(t.wins, 5)}${c.reset} ${c.red}${rpad(t.losses, 7)}${c.reset} ${c.dim}${rpad(t.total, 5)}${c.reset}\n`
    );
  }

  // ── By intent ──────────────────────────────────────────────────────────────
  process.stdout.write("\n" + hr() + "\n");
  process.stdout.write(c.bold + "  BY INTENT  (across all topics)\n" + c.reset);
  process.stdout.write(hr() + "\n\n");

  // Aggregate across topics
  const intentMap = new Map();
  for (const r of intentStats) {
    if (!intentMap.has(r.intent)) intentMap.set(r.intent, { wins: 0, losses: 0, total: 0, deltaSum: 0 });
    const e = intentMap.get(r.intent);
    e.wins     += r.wins;
    e.losses   += r.losses;
    e.total    += r.total;
    e.deltaSum += r.avg_delta * r.total;
  }

  const intentRows = [...intentMap.entries()]
    .map(([intent, e]) => ({ intent, ...e, avg_delta: e.deltaSum / e.total }))
    .sort((a, b) => b.avg_delta - a.avg_delta);

  process.stdout.write(
    `  ${c.dim}${pad("intent", 14)} ${"delta".padStart(7)}  ${"bar".padEnd(22)} ${"wins".padStart(5)} ${"losses".padStart(7)} ${"n".padStart(5)}${c.reset}\n`
  );

  for (const r of intentRows) {
    const d    = Number(r.avg_delta);
    const dStr = (d >= 0 ? "+" : "") + d.toFixed(3);
    process.stdout.write(
      `  ${pad(r.intent, 14)} ${deltaColor(d)}${rpad(dStr, 7)}${c.reset}  ${deltaBar(d)}  ` +
      `${c.green}${rpad(r.wins, 5)}${c.reset} ${c.red}${rpad(r.losses, 7)}${c.reset} ${c.dim}${rpad(r.total, 5)}${c.reset}\n`
    );
  }

  // ── Top wins ───────────────────────────────────────────────────────────────
  process.stdout.write("\n" + hr() + "\n");
  process.stdout.write(c.bold + "  MAXX HELPS MOST (highest delta)\n" + c.reset);
  process.stdout.write(hr() + "\n\n");

  for (const r of topWins) {
    const d = Number(r.delta);
    process.stdout.write(
      `  ${c.green}+${d.toFixed(3)}${c.reset}  ${c.dim}${pad(r.topic || "?", 14)}${r.intent || "?"}${c.reset}\n` +
      `  ${c.dim}raw:${c.reset}  "${trunc(r.raw_prompt, 55)}"\n` +
      `  ${c.cyan}maxx:${c.reset} "${trunc(r.cleaned_prompt, 55)}"\n\n`
    );
  }

  // ── Top losses ─────────────────────────────────────────────────────────────
  process.stdout.write(hr() + "\n");
  process.stdout.write(c.bold + "  MAXX HURTS MOST (lowest delta)\n" + c.reset);
  process.stdout.write(hr() + "\n\n");

  for (const r of topLosses) {
    const d = Number(r.delta);
    process.stdout.write(
      `  ${c.red}${d.toFixed(3)}${c.reset}  ${c.dim}${pad(r.topic || "?", 14)}${r.intent || "?"}${c.reset}\n` +
      `  ${c.dim}raw:${c.reset}  "${trunc(r.raw_prompt, 55)}"\n` +
      `  ${c.cyan}maxx:${c.reset} "${trunc(r.cleaned_prompt, 55)}"\n\n`
    );
  }

  // ── Emergent summary ───────────────────────────────────────────────────────
  process.stdout.write(hr("═") + "\n");
  process.stdout.write(c.bold + "  EMERGENT PROPERTIES\n" + c.reset);
  process.stdout.write(hr("═") + "\n\n");

  const bestTopic  = topicStats[0];
  const worstTopic = topicStats[topicStats.length - 1];
  const bestIntent = intentRows[0];
  const worstIntent = intentRows[intentRows.length - 1];

  if (bestTopic) {
    process.stdout.write(`  ${c.green}Most helped:${c.reset}  topic=${bestTopic.topic}  avg delta ${c.green}+${Number(bestTopic.avg_delta).toFixed(3)}${c.reset}  win rate ${winPct(bestTopic.wins, bestTopic.total)}\n`);
  }
  if (worstTopic) {
    process.stdout.write(`  ${c.red}Least helped:${c.reset} topic=${worstTopic.topic}  avg delta ${c.red}${Number(worstTopic.avg_delta).toFixed(3)}${c.reset}  loss rate ${winPct(worstTopic.losses, worstTopic.total)}\n`);
  }
  if (bestIntent) {
    process.stdout.write(`  ${c.green}Best intent:${c.reset}  ${bestIntent.intent}  avg delta ${c.green}+${Number(bestIntent.avg_delta).toFixed(3)}${c.reset}\n`);
  }
  if (worstIntent) {
    process.stdout.write(`  ${c.red}Worst intent:${c.reset} ${worstIntent.intent}  avg delta ${c.red}${Number(worstIntent.avg_delta).toFixed(3)}${c.reset}\n`);
  }

  process.stdout.write("\n" + hr("═") + "\n\n");
}

main();
