#!/usr/bin/env node
import { analyzePrompt } from "./skill-engine.js";

const USAGE = `
maxx — turn a messy prompt into a structured one

Usage:
  echo "messy prompt" | maxx
  maxx "messy prompt"
  maxx --json "messy prompt"

Flags:
  --json              full JSON output (pipeline, classification, problems, quality)
  --provider <name>   openai | claude | gemini | generic (default: generic)
  --framework <name>  e.g. React, Next, FastAPI
  --language <name>   e.g. TypeScript, Python
  --repo-type <name>  e.g. app, library, mono-repo
`.trim();

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { json: false, metadata: {}, promptParts: [] };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") { opts.json = true; continue; }
    if (a === "--provider")   { opts.metadata.provider  = args[++i] || ""; continue; }
    if (a === "--framework")  { opts.metadata.framework = args[++i] || ""; continue; }
    if (a === "--language")   { opts.metadata.language  = args[++i] || ""; continue; }
    if (a === "--repo-type")  { opts.metadata.repoType  = args[++i] || ""; continue; }
    if (a === "--help" || a === "-h") { process.stdout.write(USAGE + "\n"); process.exit(0); }
    opts.promptParts.push(a);
  }

  return opts;
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function main() {
  const opts = parseArgs(process.argv);
  const stdin = await readStdin();
  const prompt = [opts.promptParts.join(" "), stdin].filter(Boolean).join("\n").trim();

  if (!prompt) {
    process.stderr.write(USAGE + "\n");
    process.exit(1);
  }

  const result = await analyzePrompt({ prompt, metadata: opts.metadata });

  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  // Plain mode: optimized prompt to stdout, diagnostics to stderr
  if (result.followUpQuestion) {
    process.stderr.write(`[maxx] low confidence — ${result.followUpQuestion}\n`);
  }
  if (result.problems?.length) {
    for (const p of result.problems) {
      process.stderr.write(`[maxx] ${p.title}: ${p.action}\n`);
    }
  }

  process.stdout.write(result.optimizedPrompt + "\n");
}

main().catch((err) => {
  process.stderr.write((err.message || String(err)) + "\n");
  process.exit(1);
});
