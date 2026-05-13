#!/usr/bin/env node
/**
 * Compare raw vs maxx provider scores from the latest Promptfoo eval run.
 * Run: npm run eval:json && npm run eval:compare
 */

import fs from "node:fs";

const FILE = new URL("./results/latest.json", import.meta.url).pathname;

if (!fs.existsSync(FILE)) {
  process.stderr.write(`No results found at ${FILE}\nRun: npm run eval:json\n`);
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(FILE, "utf8"));

// Promptfoo result shape varies across versions — handle both layouts
const rows = data.results?.results ?? data.results ?? [];

if (!rows.length) {
  process.stderr.write("No result rows found in JSON.\n");
  process.exit(1);
}

// ── Group by prompt text, split by provider ────────────────────────────────

const grouped = new Map();

for (const row of rows) {
  const prompt = row.vars?.prompt ?? row.prompt ?? "(unknown)";
  const provider = row.provider?.id ?? row.provider ?? "unknown";
  if (!grouped.has(prompt)) grouped.set(prompt, {});
  grouped.get(prompt)[provider] = row;
}

// ── ANSI ──────────────────────────────────────────────────────────────────

const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m",
};

function scoreColor(n) {
  if (n >= 0.7) return c.green;
  if (n >= 0.45) return c.yellow;
  return c.red;
}

function deltaColor(d) {
  if (d > 0.05) return c.green;
  if (d < -0.05) return c.red;
  return c.dim;
}

function trunc(s, n = 60) { return s.length > n ? s.slice(0, n - 1) + "…" : s; }
function fmt(n) { return n.toFixed(3); }

// ── Output ────────────────────────────────────────────────────────────────

const W = 68;
const hr = c.dim + "─".repeat(W) + c.reset;

process.stdout.write("\n" + "═".repeat(W) + "\n");
process.stdout.write(c.bold + "  MAXX EVAL COMPARISON  " + c.reset +
  c.dim + `raw vs maxx — ${grouped.size} prompts\n` + c.reset);
process.stdout.write("═".repeat(W) + "\n\n");

const deltas = [];
let wins = 0, losses = 0, ties = 0;

for (const [prompt, pair] of grouped.entries()) {
  const raw  = pair.raw;
  const maxx = pair.maxx;

  if (!raw || !maxx) {
    process.stdout.write(c.dim + `  (skipped — missing provider data for: ${trunc(prompt, 50)})` + c.reset + "\n");
    continue;
  }

  const rawScore  = raw.score  ?? raw.gradingResult?.score  ?? 0;
  const maxxScore = maxx.score ?? maxx.gradingResult?.score ?? 0;
  const delta     = maxxScore - rawScore;

  deltas.push(delta);
  if (delta > 0.05) wins++;
  else if (delta < -0.05) losses++;
  else ties++;

  const symbol = delta > 0.05 ? "▲" : delta < -0.05 ? "▼" : "─";
  const dCol   = deltaColor(delta);

  process.stdout.write(
    `  ${dCol}${symbol}${c.reset} ${c.dim}${trunc(prompt, 52)}${c.reset}\n` +
    `    raw ${scoreColor(rawScore)}${fmt(rawScore)}${c.reset}  →  maxx ${scoreColor(maxxScore)}${fmt(maxxScore)}${c.reset}` +
    `  ${dCol}${delta >= 0 ? "+" : ""}${fmt(delta)}${c.reset}\n`
  );
}

// ── Summary ───────────────────────────────────────────────────────────────

const avgDelta = deltas.length
  ? deltas.reduce((a, b) => a + b, 0) / deltas.length
  : 0;

process.stdout.write("\n" + hr + "\n");
process.stdout.write(c.bold + "  SUMMARY\n" + c.reset);
process.stdout.write(
  `  Prompts:   ${grouped.size}\n` +
  `  Maxx wins: ${c.green}${wins}${c.reset}  ties: ${c.dim}${ties}${c.reset}  losses: ${c.red}${losses}${c.reset}\n` +
  `  Avg delta: ${deltaColor(avgDelta)}${avgDelta >= 0 ? "+" : ""}${fmt(avgDelta)}${c.reset}\n`
);

// Decision rule from spec
const passRate = wins / Math.max(deltas.length, 1);
const lossRate = losses / Math.max(deltas.length, 1);
const verdict  = avgDelta >= 0.15 && lossRate <= 0.20;

process.stdout.write(
  `\n  Benchmark: ${verdict ? c.green + "PASS" : c.red + "FAIL"}${c.reset}` +
  c.dim + ` (need avg delta ≥0.15, loss rate ≤20%)` + c.reset + "\n"
);

process.stdout.write("\n" + "═".repeat(W) + "\n\n");
