#!/usr/bin/env node
import { extractSemanticGraph, scoreSemanticGraph, renderPrompt } from "./pipeline/semantic-graph.js";
import { compilePromptWithLLM, callClaude, ollamaAvailable } from "./pipeline/llm.js";

const USAGE = `
maxx — compile a messy prompt, call the local LLM, return the answer

Usage:
  maxx "messy prompt"
  echo "messy prompt" | maxx
  maxx --compile "prompt"      show compiled prompt only, do not call LLM
  maxx --json "prompt"         full JSON output
  maxx --model qwen3.5:9b "prompt"
  maxx --agent "prompt"        compile + call Claude API (needs ANTHROPIC_API_KEY)
`.trim();

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { compile: false, json: false, agent: false, model: null, target: "generic", parts: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--compile")  { opts.compile = true; continue; }
    if (a === "--json")     { opts.json    = true; continue; }
    if (a === "--agent")    { opts.agent   = true; continue; }
    if (a === "--model")    { opts.model   = args[++i] || ""; continue; }
    if (a === "--target")   { opts.target  = args[++i] || "generic"; continue; }
    if (a === "--help" || a === "-h") { process.stdout.write(USAGE + "\n"); process.exit(0); }
    opts.parts.push(a);
  }
  return opts;
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").trim();
}

// ─── ANSI ─────────────────────────────────────────────────────────────────────

const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m",
};

function hr() { return c.dim + "─".repeat(50) + c.reset; }

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const opts   = parseArgs(process.argv);
  const stdin  = await readStdin();
  const prompt = [...opts.parts, stdin].filter(Boolean).join("\n").trim();

  if (!prompt) { process.stderr.write(USAGE + "\n"); process.exit(1); }

  const model = opts.model || process.env.OLLAMA_MODEL || "qwen3:1.7b";

  // ── Extract semantic graph
  const { graph, intent } = await extractSemanticGraph(prompt);
  const score = scoreSemanticGraph(graph, intent.confidence);

  // ── JSON mode
  if (opts.json) {
    process.stdout.write(JSON.stringify({ graph, intent, score }, null, 2) + "\n");
    return;
  }

  // ── Header
  const conf     = Math.round(intent.confidence * 100);
  const confNote = conf < 40 ? c.yellow + " ← low" + c.reset : "";
  process.stderr.write(`\n${hr()}\n`);
  process.stderr.write(`  ${c.bold}${intent.primary.label}${c.reset}  ${c.dim}${conf}%${confNote}  ·  ICS ${score.total}/100${c.reset}\n`);
  if (graph.missingInputs.length) {
    process.stderr.write(`  ${c.yellow}missing: ${graph.missingInputs.join(", ")}${c.reset}\n`);
  }
  process.stderr.write(`${hr()}\n\n`);

  // Slots that block the LLM from doing anything useful if absent
  const BLOCKING_SLOTS = {
    decide:  ["explicit options"],
    extract: ["source material"],
    fix:     ["error description"],
  };
  const blocking = (BLOCKING_SLOTS[intent.primary.key] || [])
    .filter((s) => graph.missingInputs.includes(s));

  // ── Unclear OR missing critical slot → clarifying question
  if (intent.confidence < 0.35 || blocking.length) {
    const q = blocking.length
      ? `What are the ${blocking[0]} you're deciding between?`
        .replace("explicit options", "options or ideas")
        .replace("error description", "error or symptoms you're seeing")
        .replace("source material", "source text you want me to extract from")
      : "What is the single most important outcome you need from this prompt?";
    process.stdout.write(`${q}\n`);
    return;
  }

  // ── Agent mode: compile with Qwen → send compiled prompt to local claude for testing
  if (opts.agent) {
    const rendered = renderPrompt(graph, "cursor");
    if (opts.compile) { process.stdout.write(rendered + "\n"); return; }
    const compiled = await compilePromptWithLLM(prompt, { graph, rendered, model });
    const answer   = await callClaude(compiled);
    process.stdout.write(answer + "\n");
    return;
  }

  // ── Compile prompt
  const compiled = renderPrompt(graph, opts.target);

  if (opts.compile) {
    process.stdout.write(compiled + "\n");
    return;
  }

  // ── Call LLM
  const ok = await ollamaAvailable();
  if (!ok) {
    process.stderr.write(`ollama not reachable. Use --compile to see the structured prompt.\n`);
    process.stdout.write(compiled + "\n");
    return;
  }

  const answer = await compilePromptWithLLM(prompt, { graph, rendered: compiled, model });
  process.stdout.write(answer + "\n");
}

main().catch((err) => {
  process.stderr.write((err.message || String(err)) + "\n");
  process.exit(1);
});
