const OLLAMA_BASE  = process.env.OLLAMA_URL   || "http://127.0.0.1:11434";
const DEFAULT_MODEL = process.env.OLLAMA_MODEL || "qwen3:1.7b";

export async function ollamaChat(messages, { model = DEFAULT_MODEL, temperature = 0.4 } = {}) {
  const isQwen3 = model.startsWith("qwen3");
  const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      // Disable chain-of-thought for qwen3 — faster, less verbose
      ...(isQwen3 ? { think: false } : {}),
      options: { temperature },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Ollama ${res.status}: ${text}`);
  }
  const data = await res.json();
  const raw = data.message?.content ?? "";
  // Strip any thinking tags that slip through
  return raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

// Compile a messy prompt into a clean, specific one a model can act on well.
// The output IS the prompt the user pastes into Claude — not the answer to it.
// Takes rawPrompt + pre-rendered deterministic output; LLM's job is to blend them
// into a single natural-sounding, precise prompt for pasting into Claude.
export async function compilePromptWithLLM(rawPrompt, { graph, rendered, model } = {}) {
  const missing = graph?.missingInputs?.length
    ? `Missing (use as [bracketed placeholders]): ${graph.missingInputs.join(", ")}`
    : "";

  const intentKey = typeof graph?.intent === "string" ? graph.intent : (graph?.intent?.primary?.key || "");
  const verbMap   = { decide: "Compare", fix: "Debug", learn: "Explain", research: "Research", plan: "Plan", extract: "Extract", create: "Create", write: "Draft" };
  const verb      = verbMap[intentKey] || "Draft";

  const system =
    "You rewrite vague requests as direct task instructions a model will execute immediately.\n" +
    `Start with the action verb '${verb}' (never 'Write a prompt'). State the exact task, key constraints, and expected output format. ` +
    "Use [brackets] for missing details. One instruction, under 80 words, no preamble.";

  const userMessage = [
    `Vague request: "${rawPrompt}"`,
    rendered ? `Structured breakdown:\n${rendered}` : "",
    missing,
    "",
    "Task instruction:",
  ].filter(Boolean).join("\n");

  return ollamaChat(
    [
      { role: "system", content: system },
      { role: "user",   content: userMessage },
    ],
    { temperature: 0.25, ...(model ? { model } : {}) },
  );
}

// Send a compiled prompt to the local claude CLI and return its answer.
// Qwen does the compilation; this just tests how the compiled prompt performs
// in a real LLM. Pass the already-finished compiled prompt string as `compiledPrompt`.
import { spawn } from "node:child_process";

export function callClaude(compiledPrompt, { model } = {}) {
  return new Promise((resolve, reject) => {
    const args = ["--print", compiledPrompt];
    if (model) args.push("--model", model);

    const proc = spawn("claude", args, { stdio: ["ignore", "pipe", "pipe"] });

    const out = [];
    const err = [];
    proc.stdout.on("data", d => out.push(d));
    proc.stderr.on("data", d => err.push(d));

    proc.on("close", code => {
      const text = Buffer.concat(out).toString("utf8").trim();
      if (code !== 0 && !text) {
        reject(new Error(`claude: ${Buffer.concat(err).toString("utf8").trim() || `exit ${code}`}`));
      } else {
        resolve(text);
      }
    });

    proc.on("error", e => reject(new Error(`claude not found on PATH: ${e.message}`)));
  });
}

export async function ollamaAvailable() {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}
