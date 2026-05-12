#!/usr/bin/env node
import { analyzePrompt } from "./skill-engine.js";

function parseArgs(argv) {
  const args = argv.slice(2);
  const options = {
    json: false,
    metadata: {},
    promptParts: [],
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--framework") {
      options.metadata.framework = args[++index] || "";
      continue;
    }

    if (arg === "--language") {
      options.metadata.language = args[++index] || "";
      continue;
    }

    if (arg === "--repo-type") {
      options.metadata.repoType = args[++index] || "";
      continue;
    }

    if (arg === "--model-type") {
      options.metadata.modelType = args[++index] || "";
      continue;
    }

    options.promptParts.push(arg);
  }

  return options;
}

async function readStdin() {
  if (process.stdin.isTTY) {
    return "";
  }

  let data = "";
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data.trim();
}

async function main() {
  const options = parseArgs(process.argv);
  const stdinPrompt = await readStdin();
  const prompt = [options.promptParts.join(" "), stdinPrompt].filter(Boolean).join(" ").trim();

  if (!prompt) {
    process.stderr.write(
      "Usage: node cli.mjs [--json] [--framework <name>] [--language <name>] [--repo-type <name>] [--model-type <name>] <prompt>\n",
    );
    process.exit(1);
  }

  const analysis = await analyzePrompt({
    prompt,
    metadata: options.metadata,
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(analysis, null, 2)}\n`);
    return;
  }

  process.stdout.write(`now maxxed - ${JSON.stringify(analysis.optimizedPrompt)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message || String(error)}\n`);
  process.exit(1);
});
