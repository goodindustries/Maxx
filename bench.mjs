#!/usr/bin/env node
/**
 * Maxx bench — 25 bad prompts through the semantic graph pipeline.
 * Shows: intent, ICS score, graph fields, compiled output.
 *
 * Usage:
 *   node bench.mjs           — full output
 *   node bench.mjs --short   — one line per prompt (intent + score + goal)
 */
import { extractSemanticGraph, scoreSemanticGraph, renderPrompt } from "./pipeline/semantic-graph.js";
import { compilePromptWithLLM, ollamaAvailable } from "./pipeline/llm.js";

const W = 68;

// ─── ANSI ─────────────────────────────────────────────────────────────────────

const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m",
  cyan: "\x1b[36m", white: "\x1b[37m",
};

function hr(ch = "─") { return c.dim + ch.repeat(W) + c.reset; }
function pad(s, n) { return String(s).padEnd(n); }
function rpad(s, n) { return String(s).padStart(n); }
function trunc(s, n = 60) { return s.length > n ? s.slice(0, n - 1) + "…" : s; }

function scoreColor(n) {
  if (n >= 70) return c.green;
  if (n >= 45) return c.yellow;
  return c.red;
}

// ─── prompts ──────────────────────────────────────────────────────────────────

const PROMPTS = [
  // Write
  "hey claude help me word this so i dont sound mad",
  "i need to send something to my boss about being late can you help",
  "write something for the team meeting announcement tomorrow",
  "can you help me reply to this angry client email without being too aggressive",
  "help me ask for a raise its been 2 years and honestly i deserve one",

  // Decide
  "should i use postgres or sqlite honestly not sure which is better for my app",
  "is react or vue better",
  "help me decide if i should take this job offer or stay where i am",

  // Fix
  "my code is broken fix it",
  "the app keeps crashing randomly and i dont know why",
  "something is wrong with the auth and users cant log in anymore",
  "my api responses are really slow lately and it wasnt like this before",

  // Plan
  "help me plan my project",
  "i need a roadmap for launching this feature soon",
  "help me figure out how to approach this migration",

  // Research
  "tell me about machine learning",
  "what should i use for my database",

  // Create
  "make me some social media posts",
  "give me ideas for the landing page",
  "write a bio for my linkedin or something",

  // Learn
  "explain how oauth works basically i dont really understand it",
  "i want to understand docker but honestly never really got it",

  // Extract
  "get the important stuff from my notes",
  "pull out the main points from this meeting",

  // Vague
  "organize everything its a total mess",
];

// ─── display ──────────────────────────────────────────────────────────────────

function printHeader() {
  process.stdout.write("\n" + hr("═") + "\n");
  process.stdout.write(c.bold + "  MAXX BENCH  " + c.reset +
    c.dim + "— 25 prompts through the semantic graph pipeline\n" + c.reset);
  process.stdout.write(hr("═") + "\n\n");
}

function printShortRow(i, prompt, graph, intent, score) {
  const conf      = Math.round(intent.confidence * 100);
  const col       = scoreColor(score.total);
  const missing   = graph.missingInputs.length ? c.yellow + ` [missing: ${graph.missingInputs.join(", ")}]` + c.reset : "";
  process.stdout.write(
    `  ${c.dim}${rpad(i, 2)}${c.reset}  ` +
    `${c.bold}${pad(intent.primary.label, 10)}${c.reset}` +
    `${c.dim}${rpad(conf, 4)}%${c.reset}  ` +
    `${col}${rpad(score.total, 3)}${c.reset}  ` +
    `${c.dim}${trunc(graph.goal, 42)}${c.reset}` +
    missing + "\n"
  );
}

function printFull(i, prompt, graph, intent, score, compiled) {
  const conf    = Math.round(intent.confidence * 100);
  const col     = scoreColor(score.total);
  const bk      = score.breakdown;

  process.stdout.write("\n" + hr() + "\n");
  process.stdout.write(
    `  ${c.bold}${rpad(i, 2)}/25${c.reset}  ` +
    `${c.bold}${pad(intent.primary.label, 10)}${c.reset}` +
    `${c.dim}${conf}%${c.reset}  ` +
    `${col}ICS ${score.total}/100${c.reset}\n`
  );
  process.stdout.write(c.dim + `  "${trunc(prompt, 64)}"` + c.reset + "\n\n");

  // ── Graph fields
  const gFields = [
    ["goal",        graph.goal],
    ["object",      graph.object !== "request" ? graph.object : null],
    ["audience",    graph.audience],
    ["tone",        graph.tone.length ? graph.tone.join(", ") : null],
    ["constraints", graph.constraints.length ? graph.constraints.join(" · ") : null],
    ["output",      [graph.output.format, graph.output.length].filter(Boolean).join(" · ")],
    ["missing",     graph.missingInputs.length ? graph.missingInputs.join(", ") : null],
    ["uncertainty", graph.uncertainty],
  ];
  for (const [label, value] of gFields) {
    if (!value) continue;
    const isWarn = label === "missing";
    process.stdout.write(
      `  ${c.dim}${pad(label, 12)}${c.reset}` +
      (isWarn ? c.yellow : c.white) + value + c.reset + "\n"
    );
  }

  // ── Score breakdown (compact)
  process.stdout.write("\n");
  const bkParts = [
    ["intent",      bk.intentConfidence],
    ["goal",        bk.goalClarity],
    ["constraints", bk.constraintCompleteness],
    ["object",      bk.objectSpecificity],
    ["output",      bk.outputDefinition],
  ];
  const penalties = (bk.missingSlotPenalty || 0) + (bk.uncertaintyPenalty || 0);
  const scoreStr = bkParts.map(([l, v]) => `${c.dim}${l}${c.reset} ${col}${v}${c.reset}`).join("  ") +
    (penalties < 0 ? `  ${c.red}penalty ${penalties}${c.reset}` : "");
  process.stdout.write("  " + scoreStr + "\n");

  // ── Compiled output
  process.stdout.write("\n" + c.dim + "  Compiled:\n" + c.reset);
  for (const line of compiled.split("\n")) {
    process.stdout.write("  " + c.cyan + line + c.reset + "\n");
  }
}

function printSummary(results) {
  process.stdout.write("\n" + hr("═") + "\n");
  process.stdout.write(c.bold + "  SUMMARY\n" + c.reset);
  process.stdout.write(hr("═") + "\n\n");

  // Intent distribution
  const intentMap = {};
  const scores    = [];
  for (const r of results) {
    const key = r.intent.primary.label;
    intentMap[key] = (intentMap[key] || []);
    intentMap[key].push(r.score.total);
    scores.push(r.score.total);
  }

  const avg    = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  const low    = scores.filter((s) => s < 45).length;
  const mid    = scores.filter((s) => s >= 45 && s < 70).length;
  const high   = scores.filter((s) => s >= 70).length;
  const missingCount = results.filter((r) => r.graph.missingInputs.length > 0).length;

  process.stdout.write(`  Avg ICS: ${scoreColor(avg)}${avg}/100${c.reset}   ` +
    `${c.green}High ≥70: ${high}${c.reset}   ${c.yellow}Mid 45-69: ${mid}${c.reset}   ${c.red}Low <45: ${low}${c.reset}\n`);
  process.stdout.write(`  Missing slots: ${c.yellow}${missingCount}/25${c.reset} prompts had at least one missing slot\n\n`);

  // Per-intent avg
  process.stdout.write(c.bold + "  By intent:\n" + c.reset);
  for (const [label, arr] of Object.entries(intentMap).sort()) {
    const a = Math.round(arr.reduce((x, y) => x + y, 0) / arr.length);
    const bar = scoreColor(a) + "█".repeat(Math.round(a / 5)) + c.reset + c.dim + "░".repeat(20 - Math.round(a / 5)) + c.reset;
    process.stdout.write(`  ${pad(label, 12)}  ${bar}  ${scoreColor(a)}${rpad(a, 3)}${c.reset}  (${arr.length} prompts)\n`);
  }

  process.stdout.write("\n" + hr("═") + "\n\n");
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const shortMode   = process.argv.includes("--short");
  const answersMode = process.argv.includes("--answers");
  const model       = (() => {
    const i = process.argv.indexOf("--model");
    return i !== -1 ? process.argv[i + 1] : process.env.OLLAMA_MODEL || "qwen3:1.7b";
  })();

  printHeader();

  // ── answers mode: INPUT / OUTPUT pairs for all 25 prompts
  if (answersMode) {
    const ok = await ollamaAvailable();
    if (!ok) { process.stderr.write("ollama not reachable\n"); process.exit(1); }

    process.stdout.write(c.dim + `  model: ${model}\n\n` + c.reset);

    for (let i = 0; i < PROMPTS.length; i++) {
      const prompt = PROMPTS[i];
      const { graph, intent } = await extractSemanticGraph(prompt);
      const score    = scoreSemanticGraph(graph, intent.confidence);
      const compiled = renderPrompt(graph, "generic");

      const answer = await compilePromptWithLLM(prompt, { graph, rendered: compiled, model });

      const conf = Math.round(intent.confidence * 100);
      process.stdout.write(hr() + "\n");
      process.stdout.write(
        `  ${c.bold}${rpad(i + 1, 2)}/25${c.reset}  ` +
        `${c.bold}${pad(intent.primary.label, 10)}${c.reset}` +
        `${c.dim}${conf}%  ICS ${score.total}${c.reset}\n\n`
      );
      process.stdout.write(c.dim + "  IN   " + c.reset + `"${prompt}"\n\n`);
      process.stdout.write(c.dim + "  OUT  " + c.reset);
      const lines = answer.split("\n");
      process.stdout.write(lines[0] + "\n");
      for (const line of lines.slice(1)) {
        process.stdout.write("       " + line + "\n");
      }
      process.stdout.write("\n");
    }

    process.stdout.write(hr("═") + "\n\n");
    return;
  }

  if (shortMode) {
    process.stdout.write(
      `  ${c.dim}${"#".padEnd(4)}${"Intent".padEnd(12)}${"Conf".padStart(5)}  ${"ICS".padStart(4)}  ${"Goal / question"}${c.reset}\n`
    );
    process.stdout.write("  " + c.dim + "─".repeat(W - 2) + c.reset + "\n");
  }

  const results = [];

  for (let i = 0; i < PROMPTS.length; i++) {
    const prompt = PROMPTS[i];
    const { graph, intent } = await extractSemanticGraph(prompt);
    const score    = scoreSemanticGraph(graph, intent.confidence);
    const compiled = renderPrompt(graph, "generic");

    results.push({ prompt, graph, intent, score, compiled });

    if (shortMode) {
      printShortRow(i + 1, prompt, graph, intent, score);
    } else {
      printFull(i + 1, prompt, graph, intent, score, compiled);
    }
  }

  printSummary(results);
}

main().catch((err) => {
  process.stderr.write(err.message + "\n");
  process.exit(1);
});
