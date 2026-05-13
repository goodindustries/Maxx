#!/usr/bin/env node
/**
 * Generate 500 bad prompts across 10 topics using Claude.
 * Output: evals/data/prompts.json
 *
 * Usage:
 *   node evals/generate-prompts.mjs
 *   node evals/generate-prompts.mjs --topic coding   (single topic, for testing)
 */

import { callClaude } from "../pipeline/llm.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT     = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_FILE = join(ROOT, "evals", "data", "prompts.json");
mkdirSync(join(ROOT, "evals", "data"), { recursive: true });

const TOPICS = [
  { key: "coding",        label: "Writing or editing code" },
  { key: "debugging",     label: "Debugging broken software" },
  { key: "writing",       label: "Professional emails and messages" },
  { key: "decisions",     label: "Tech or product decisions and tradeoffs" },
  { key: "learning",      label: "Learning a new concept or technology" },
  { key: "planning",      label: "Project or feature planning and roadmaps" },
  { key: "interpersonal", label: "Workplace relationships and difficult conversations" },
  { key: "creative",      label: "Creative writing, bios, and content" },
  { key: "career",        label: "Career decisions, raises, and job changes" },
  { key: "data",          label: "Data analysis, metrics, and reporting" },
];

const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m",
};

function parsePrompts(raw) {
  return raw
    .split("\n")
    .map(l => l
      .replace(/^\d+[\.\)\-\*]\s*/, "")  // strip numbering/bullets
      .replace(/^["']|["']$/g, "")        // strip surrounding quotes
      .trim()
    )
    .filter(l => l.length > 8 && l.length < 200)
    .filter(l => !/^(here are|these are|below are|prompt|topic|note:|output)/i.test(l));
}

async function generateTopic(topic) {
  process.stdout.write(`  generating ${c.cyan}${topic.key}${c.reset} (${topic.label})…\n`);

  const instruction = `Generate exactly 50 bad, vague, messy prompts that a real user might type when asking for help with: "${topic.label}".

Rules for each prompt:
- Write exactly how a frustrated or busy person types — casual, sloppy, no polish
- Each must be vague, missing key context, or poorly stated
- Mix short (4-10 words) with medium (12-25 words)
- No numbering, no bullets, no labels, no quotes
- Vary the failure modes: too vague, missing context, emotional rambling, half-formed thought, contradictory, overly broad

Output: exactly 50 prompts, one per line, nothing else before or after.`;

  const raw = await callClaude(instruction);
  const prompts = parsePrompts(raw);

  if (prompts.length < 40) {
    process.stdout.write(`  ${c.yellow}warning: only got ${prompts.length} prompts for ${topic.key}, re-trying…${c.reset}\n`);
    const raw2 = await callClaude(instruction);
    return [...new Set([...prompts, ...parsePrompts(raw2)])].slice(0, 50);
  }

  return prompts.slice(0, 50);
}

async function main() {
  const filterKey = process.argv.includes("--topic")
    ? process.argv[process.argv.indexOf("--topic") + 1]
    : null;

  const topics = filterKey ? TOPICS.filter(t => t.key === filterKey) : TOPICS;

  process.stdout.write(`\n${c.bold}Maxx — generating bad prompts${c.reset}\n`);
  process.stdout.write(`${c.dim}${topics.length} topics × 50 prompts = ${topics.length * 50} total${c.reset}\n\n`);

  const result = {};

  for (const topic of topics) {
    const prompts = await generateTopic(topic);
    result[topic.key] = {
      label: topic.label,
      prompts,
    };
    process.stdout.write(`  ${c.green}✓${c.reset} ${topic.key}: ${prompts.length} prompts\n`);
  }

  const total = Object.values(result).reduce((n, t) => n + t.prompts.length, 0);
  writeFileSync(OUT_FILE, JSON.stringify(result, null, 2));

  process.stdout.write(`\n${c.bold}Done.${c.reset} ${total} prompts → ${OUT_FILE}\n\n`);
}

main().catch(err => { process.stderr.write(err.message + "\n"); process.exit(1); });
