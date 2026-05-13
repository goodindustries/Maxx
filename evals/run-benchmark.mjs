#!/usr/bin/env node
/**
 * Run the full A/B benchmark across all generated prompts.
 *
 * For each prompt:
 *   raw path:  messyPrompt → Claude → rawOutput → score
 *   maxx path: messyPrompt → Maxx/Qwen → cleanedPrompt → Claude → maxxOutput → score
 *   save: raw_prompt, cleaned_prompt, raw_output, maxx_output, raw_score, maxx_score, delta, topic, intent
 *
 * Usage:
 *   node evals/run-benchmark.mjs
 *   node evals/run-benchmark.mjs --topic coding
 *   node evals/run-benchmark.mjs --limit 20
 *   node evals/run-benchmark.mjs --concurrency 5
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { extractSemanticGraph, scoreSemanticGraph, renderPrompt } from "../pipeline/semantic-graph.js";
import { compilePromptWithLLM, callClaude } from "../pipeline/llm.js";
import { saveRun, getRuns, getStats } from "../pipeline/db.js";
import scoreOutput from "./assertions/output-quality.js";

const ROOT        = dirname(dirname(fileURLToPath(import.meta.url)));
const PROMPTS_FILE = join(ROOT, "evals", "data", "prompts.json");

const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m",
};

function arg(name, def = null) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : def;
}
const HAS_FLAG = name => process.argv.includes(name);

// ── Concurrency pool ──────────────────────────────────────────────────────────
async function withPool(items, concurrency, fn) {
  let idx = 0;
  const results = new Array(items.length);
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// ── Progress line ─────────────────────────────────────────────────────────────
let _done = 0, _total = 0, _wins = 0, _losses = 0, _ties = 0;
function progress(delta) {
  _done++;
  if      (delta >  0.05) _wins++;
  else if (delta < -0.05) _losses++;
  else                    _ties++;

  const pct  = Math.round(_done / _total * 100);
  const bar  = "█".repeat(Math.round(pct / 5)) + "░".repeat(20 - Math.round(pct / 5));
  process.stdout.write(
    `\r  ${c.dim}${bar}${c.reset} ${pct}%  ${_done}/${_total}  ` +
    `${c.green}▲${_wins}${c.reset} ${c.red}▼${_losses}${c.reset} ${c.dim}─${_ties}${c.reset}   `
  );
}

// ── Single benchmark run ──────────────────────────────────────────────────────
async function runOne(rawPrompt, topic) {
  try {
    // Control: raw → Claude
    const rawOutputPromise = callClaude(rawPrompt);

    // Treatment: Maxx compiles → Claude
    const { graph, intent } = await extractSemanticGraph(rawPrompt);
    const ics               = scoreSemanticGraph(graph, intent.confidence);
    const rendered          = renderPrompt(graph, "generic");
    const cleanedPrompt     = await compilePromptWithLLM(rawPrompt, { graph, rendered, model: "qwen3:1.7b" });
    const maxxOutputPromise = callClaude(cleanedPrompt);

    const [rawOutput, maxxOutput] = await Promise.all([rawOutputPromise, maxxOutputPromise]);

    const rawScore  = scoreOutput(rawOutput).score;
    const maxxScore = scoreOutput(maxxOutput).score;
    const delta     = Math.round((maxxScore - rawScore) * 1000) / 1000;

    saveRun({
      rawPrompt,
      cleanedPrompt,
      rawOutput,
      maxxOutput,
      rawScore,
      maxxScore,
      delta,
      downstreamProvider: "claude-cli",
      optimizerModel:     "qwen3:1.7b",
      icsScore:           ics.total,
      intent:             intent.primary.label,
      topic,
    });

    progress(delta);
    return { ok: true, delta };
  } catch (err) {
    progress(0);
    return { ok: false, error: err.message };
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!existsSync(PROMPTS_FILE)) {
    process.stderr.write(`No prompts file found. Run: node evals/generate-prompts.mjs\n`);
    process.exit(1);
  }

  const data        = JSON.parse(readFileSync(PROMPTS_FILE, "utf8"));
  const filterTopic = arg("--topic");
  const limit       = Number(arg("--limit", 0));
  const concurrency = Number(arg("--concurrency", 3));

  // Build flat work list: [{ rawPrompt, topic }]
  let work = [];
  for (const [key, val] of Object.entries(data)) {
    if (filterTopic && key !== filterTopic) continue;
    for (const p of val.prompts) {
      work.push({ rawPrompt: p, topic: key });
    }
  }
  if (limit) work = work.slice(0, limit);

  // Skip already-completed prompts
  const existing = new Set(getRuns(10000).map(r => r.raw_prompt));
  const todo     = work.filter(w => !existing.has(w.rawPrompt));

  _total = todo.length;

  process.stdout.write(`\n${c.bold}Maxx benchmark run${c.reset}\n`);
  process.stdout.write(`${c.dim}${todo.length} prompts to run  (${existing.size} already done)  concurrency ${concurrency}${c.reset}\n\n`);

  if (_total === 0) {
    process.stdout.write("All prompts already benchmarked. Run analyze:\n  node evals/analyze.mjs\n\n");
    return;
  }

  await withPool(todo, concurrency, ({ rawPrompt, topic }) => runOne(rawPrompt, topic));

  process.stdout.write("\n\n");
  const stats = getStats();
  process.stdout.write(`${c.bold}Done.${c.reset}  avg delta ${stats.avg_delta >= 0 ? c.green : c.red}${stats.avg_delta}${c.reset}  ` +
    `wins ${c.green}${stats.wins}${c.reset}  losses ${c.red}${stats.losses}${c.reset}  ties ${c.dim}${stats.ties}${c.reset}\n\n`);
}

main().catch(err => { process.stderr.write(err.message + "\n"); process.exit(1); });
