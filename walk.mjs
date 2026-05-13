#!/usr/bin/env node
/**
 * Maxx pipeline walkthrough — shows every transformation step for a prompt.
 *
 * Usage:
 *   node walk.mjs                          — interactive menu
 *   node walk.mjs "your prompt here"       — direct
 *   node walk.mjs 3                        — pick preset by number
 */
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { normalizeText, splitSentences } from "./pipeline/normalize.js";
import { cleanPromptText } from "./pipeline/cleanup.js";
import { correctGrammar } from "./pipeline/grammar.js";
import { condensePrompt, scoreSentence } from "./pipeline/condense.js";
import { classifyIntent, KEYWORD_RULES } from "./pipeline/intents.js";
import { selectTemplate } from "./pipeline/templates.js";
import { computePQSTrace } from "./pipeline/scoring.js";
import { analyzePrompt } from "./skill-engine.js";

// ─── ANSI ─────────────────────────────────────────────────────────────────────

const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m",
  cyan: "\x1b[36m", magenta: "\x1b[35m", blue: "\x1b[34m", white: "\x1b[37m",
};

const W = 68;

function hr(char = "─")   { process.stdout.write(c.dim + char.repeat(W) + c.reset + "\n"); }
function banner(title)    {
  process.stdout.write("\n" + c.bold + "═".repeat(W) + c.reset + "\n");
  process.stdout.write(c.bold + `  ${title}` + c.reset + "\n");
  process.stdout.write(c.bold + "═".repeat(W) + c.reset + "\n\n");
}
function step(n, title)   {
  process.stdout.write("\n");
  hr();
  process.stdout.write(c.bold + c.cyan + `  STEP ${n}  ` + c.reset + c.bold + title + c.reset + "\n");
  hr();
  process.stdout.write("\n");
}
function field(label, value, color = c.white) {
  const lpad = `  ${label}`.padEnd(18);
  process.stdout.write(c.dim + lpad + c.reset + color + value + c.reset + "\n");
}
function note(text) {
  process.stdout.write(c.dim + `  → ${text}` + c.reset + "\n");
}
function diff(before, after) {
  if (before === after) {
    note("No change.");
    return;
  }
  process.stdout.write(c.dim + "  Before  " + c.reset + `"${before}"\n`);
  process.stdout.write(c.dim + "  After   " + c.reset + c.green + `"${after}"` + c.reset + "\n");
}

// ─── presets ──────────────────────────────────────────────────────────────────

const PRESETS = [
  "hey claude this sqlite sync keeps breaking and the logs are noisy and maybe postgres would fix it but honestly the auth path might be the real issue can you help me sort this out",
  "help me ask my landlord about paying rent a few days late without sounding irresponsible",
  "my code is broken fix it",
  "is react or vue better",
  "help me ask for a raise its been 2 years and honestly i deserve one",
  "make this website better",
  "organize everything its a total mess",
  "what should i use for my database",
];

// ─── keyword match reporter ───────────────────────────────────────────────────

function reportKeywords(text, topIntents) {
  for (const { key, label } of topIntents) {
    const rules = KEYWORD_RULES[key];
    if (!rules) continue;
    const normalFired = rules.normal.filter((p) => p.test(text));
    const phraseFired = rules.phrase.filter((p) => p.test(text));
    const score = normalFired.length + phraseFired.length * 2;
    if (score === 0) continue;
    process.stdout.write(`  ${c.bold}${label.padEnd(12)}${c.reset} keyword score ${c.green}${score}${c.reset}\n`);
    for (const p of normalFired) note(`normal  (+1)  ${p}`);
    for (const p of phraseFired) note(`phrase  (+2)  ${p}`);
  }
}

// ─── score bar ────────────────────────────────────────────────────────────────

const BAR = 36;
function scoreBar(score, color) {
  const filled = Math.round(score / 100 * BAR);
  return color + "█".repeat(filled) + c.dim + "░".repeat(BAR - filled) + c.reset;
}

// ─── main walk ────────────────────────────────────────────────────────────────

async function walk(rawPrompt) {
  banner(`MAXX  —  Pipeline Walkthrough`);
  process.stdout.write(c.bold + "  Prompt: " + c.reset + c.yellow + `"${rawPrompt}"` + c.reset + "\n\n");

  // ── Step 1: Normalize ──────────────────────────────────────────────────────
  step(1, "Normalize");
  const normalized = normalizeText(rawPrompt);
  note("Collapse whitespace, strip CRLF, deduplicate punctuation.");
  process.stdout.write("\n");
  diff(rawPrompt.trim(), normalized.trim());

  // ── Step 2: Clean ──────────────────────────────────────────────────────────
  step(2, "Clean  —  remove lead-ins, greetings, and hedges");
  const cleaned = cleanPromptText(normalized);
  note("Lead-ins: hey / hi / claude / can you / i need / i was wondering");
  note("Hedges:   maybe / honestly / frankly  (only before action verbs)");
  process.stdout.write("\n");
  diff(normalized.trim(), cleaned.trim());

  // find what was removed
  const rawWords = new Set(normalized.toLowerCase().split(/\s+/));
  const cleanWords = new Set(cleaned.toLowerCase().split(/\s+/));
  const removed = [...rawWords].filter((w) => !cleanWords.has(w) && w.length > 1);
  if (removed.length) {
    process.stdout.write("\n");
    note(`Removed words: ${removed.map((w) => c.red + w + c.reset).join("  ")}`);
  }

  // ── Step 3: Grammar ────────────────────────────────────────────────────────
  step(3, "Grammar correction  —  LanguageTool integration");
  const grammar = await correctGrammar(cleaned, {});
  if (grammar.applied) {
    note("Grammar corrections applied:");
    diff(cleaned, grammar.text);
  } else {
    note("Skipped  (MAXX_LANGUAGE_TOOL_URL not set, or no corrections needed).");
    field("Text", grammar.text || cleaned);
  }
  const grammarText = grammar.text || cleaned;

  // ── Step 4: Condense ───────────────────────────────────────────────────────
  step(4, "Condense  —  score each sentence, keep top signal");
  const sentences = splitSentences(grammarText);
  const condensed = condensePrompt(grammarText);

  note("Scoring rules: constraint keywords +2, action verbs +2, URLs +2, numbers +2, short sentence +1");
  process.stdout.write("\n");

  const keptSet = new Set(condensed.sentences);
  for (const s of sentences) {
    const score = scoreSentence(s);
    const kept  = keptSet.has(s);
    const icon  = kept ? c.green + "✓" + c.reset : c.red + "✗" + c.reset;
    const sc    = `[${score}]`.padStart(4);
    process.stdout.write(
      `  ${icon} ${c.dim}score ${sc}${c.reset}  "${s}"\n`
    );
  }

  if (condensed.droppedCount > 0) {
    process.stdout.write("\n");
    note(`Dropped ${condensed.droppedCount} low-signal sentence(s).`);
  } else {
    process.stdout.write("\n");
    note("All sentences kept.");
  }
  const condText = condensed.text || grammarText;

  // ── Step 5: Classify intent ────────────────────────────────────────────────
  step(5, "Classify intent  —  keyword scoring + hash embedding");
  const intent = await classifyIntent(condText, {});

  note("Score = semantic × 0.40  +  min(keywords, 8) × 0.20");
  note("Hash embeddings are noisy for short prompts — keywords dominate.");
  process.stdout.write("\n");

  process.stdout.write(`  ${"Intent".padEnd(14)} ${"Keywords".padStart(8)} ${"Semantic".padStart(9)} ${"Score".padStart(7)}\n`);
  process.stdout.write(c.dim + "  " + "─".repeat(W - 2) + c.reset + "\n");

  for (const r of intent.ranked.slice(0, 5)) {
    const isTop = r.intent === intent.primary.key;
    const color = isTop ? c.bold + c.green : c.dim;
    const marker = isTop ? " ←" : "";
    process.stdout.write(
      `  ${color}${r.intent.padEnd(14)}${c.reset}` +
      `${String(r.keywords).padStart(8)}` +
      `${r.semantic.toFixed(3).padStart(9)}` +
      `${r.score.toFixed(3).padStart(7)}` +
      `${color}${marker}${c.reset}\n`
    );
  }

  process.stdout.write("\n");
  note(`Primary: ${c.bold}${intent.primary.label}${c.reset}  (${Math.round(intent.confidence * 100)}% confidence)`);
  if (intent.secondary.length) {
    note(`Secondary: ${intent.secondary.map((i) => i.label).join(", ")}`);
  }

  // show which keyword rules fired for the primary intent
  const topFive = intent.ranked.slice(0, 3).map((r) => ({ key: r.intent, label: r.intent }));
  process.stdout.write("\n");
  process.stdout.write(c.dim + "  Rules that fired:\n" + c.reset);
  reportKeywords(condText, topFive);

  // ── Step 6: Select template ────────────────────────────────────────────────
  step(6, "Select template");
  const template = selectTemplate(intent.primary.key);
  field("Template", template.label, c.cyan);
  field("Fields",   template.fields.join("  ·  "), c.dim);
  process.stdout.write("\n");
  note("Requested output:");
  for (const line of template.requestedOutput) {
    process.stdout.write(`    ${c.dim}- ${line}${c.reset}\n`);
  }

  // ── Step 7: Fill fields ────────────────────────────────────────────────────
  step(7, "Fill fields  —  extract values from cleaned text");

  // Run the full analysis to get the field values (already computed internally)
  const fullResult = await analyzePrompt({ prompt: rawPrompt });
  const fields = fullResult.fields;

  if (!fields) {
    note("Intent unclear — fields not filled. Clarifying question:");
    process.stdout.write("\n  " + c.cyan + fullResult.clarifyingQuestion + c.reset + "\n");
  } else {
    for (const [key, value] of Object.entries(fields)) {
      const label = key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (s) => s.toUpperCase());
      const isDefault = value === "Not specified" || value === "Preserve the user's intent." ||
                        value === "Recommend the smallest viable fix path." || value === fullResult.pipeline.cleaned;
      process.stdout.write(
        `  ${c.bold}${label.padEnd(18)}${c.reset}` +
        (isDefault ? c.dim : c.white) + value + c.reset + "\n"
      );
    }
  }

  // ── Step 8: Build optimized prompt ────────────────────────────────────────
  step(8, "Build optimized prompt");

  if (!fullResult.optimizedPrompt) {
    note("No optimized prompt — rewrite skipped due to low confidence.");
    process.stdout.write("\n  " + c.cyan + fullResult.clarifyingQuestion + c.reset + "\n");
  } else {
    for (const line of fullResult.optimizedPrompt.split("\n")) {
      process.stdout.write("  " + (line.endsWith(":") || line.startsWith("Task") || line.startsWith("─")
        ? c.bold + line + c.reset
        : line) + "\n");
    }
  }

  // ── Step 9: Score ─────────────────────────────────────────────────────────
  step(9, "Evaluate  —  PQS before and after");

  const { pqs } = fullResult.evaluation;
  const DIM = {
    actionability:    ["Actionability", 20],
    specificity:      ["Specificity",   20],
    clarity:          ["Clarity",       15],
    constraints:      ["Constraints",   20],
    context:          ["Context",       15],
    outputDefinition: ["OutputDef",     10],
  };

  process.stdout.write(
    `  ${"Dimension".padEnd(16)} ${"Before".padStart(6)}  ${"After".padStart(5)}  ${"Δ".padStart(4)}  ${"Max".padStart(4)}\n`
  );
  process.stdout.write(c.dim + "  " + "─".repeat(W - 2) + c.reset + "\n");

  for (const [key, [label, max]] of Object.entries(DIM)) {
    const before = pqs.dimensions.before[key];
    const after  = pqs.dimensions.after[key];
    const delta  = (pqs.dimensionDelta?.[key] ?? after - before);
    const dStr   = delta > 0 ? c.green + `+${delta}` + c.reset : delta < 0 ? c.red + delta + c.reset : c.dim + "—" + c.reset;
    process.stdout.write(
      `  ${label.padEnd(16)} ${String(before).padStart(6)}  ${String(after).padStart(5)}  ${dStr.padStart(4)}  ${String(max).padStart(4)}\n`
    );
  }

  process.stdout.write(c.dim + "  " + "─".repeat(W - 2) + c.reset + "\n");
  process.stdout.write(
    `  ${"Total".padEnd(16)} ${c.bold}${String(pqs.before).padStart(6)}${c.reset}  ` +
    `${c.bold}${String(pqs.after).padStart(5)}${c.reset}  ` +
    `${c.green}+${pqs.delta}${c.reset}  ${String(100).padStart(4)}\n\n`
  );

  process.stdout.write(`  Before  ${scoreBar(pqs.before, c.cyan)}  ${pqs.before}/100\n`);
  process.stdout.write(`  After   ${scoreBar(pqs.after,  c.green)}  ${pqs.after}/100  ${c.green}+${pqs.delta} pts${c.reset}\n\n`);

  // rules that fired before (from trace)
  if (pqs.trace?.before) {
    note("Rules that fired on the raw prompt:");
    for (const [dim, rules] of Object.entries(pqs.trace.before)) {
      const [label] = DIM[dim] || [dim];
      for (const r of rules) {
        process.stdout.write(`    ${c.dim}${label.padEnd(14)}  ${r}${c.reset}\n`);
      }
    }
  }

  process.stdout.write("\n");
  hr("═");
  process.stdout.write("\n");
}

// ─── entry ────────────────────────────────────────────────────────────────────

async function main() {
  const arg = process.argv[2];

  if (arg && /^\d+$/.test(arg)) {
    const idx = parseInt(arg, 10) - 1;
    const prompt = PRESETS[idx];
    if (!prompt) { process.stderr.write(`No preset #${arg}\n`); process.exit(1); }
    await walk(prompt);
    return;
  }

  if (arg) {
    await walk(arg);
    return;
  }

  // Interactive menu
  process.stdout.write("\n" + c.bold + "  MAXX  —  Pipeline Walkthrough\n" + c.reset);
  process.stdout.write(c.dim + "  Pick a prompt to walk through, or type your own.\n\n" + c.reset);

  PRESETS.forEach((p, i) => {
    process.stdout.write(`  ${c.bold}${i + 1}${c.reset}  ${c.dim}${p.length > 70 ? p.slice(0, 69) + "…" : p}${c.reset}\n`);
  });
  process.stdout.write(`\n  ${c.bold}0${c.reset}  ${c.dim}Enter your own prompt${c.reset}\n\n`);

  const rl = readline.createInterface({ input, output });
  let prompt;

  try {
    const choice = (await rl.question("  Choice → ")).trim();
    if (choice === "0" || choice === "") {
      prompt = (await rl.question("  Prompt → ")).trim();
    } else if (/^\d+$/.test(choice)) {
      prompt = PRESETS[parseInt(choice, 10) - 1];
      if (!prompt) { process.stderr.write("Invalid choice.\n"); process.exit(1); }
    } else {
      prompt = choice; // typed a prompt directly
    }
  } finally {
    rl.close();
  }

  process.stdout.write("\n");
  await walk(prompt);
}

main().catch((err) => {
  process.stderr.write(err.message + "\n");
  process.exit(1);
});
