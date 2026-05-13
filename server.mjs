import { createServer } from "node:http";
import { ollamaChat, compilePromptWithLLM, callClaude, ollamaAvailable } from "./pipeline/llm.js";
import { extractSemanticGraph, scoreSemanticGraph, renderPrompt } from "./pipeline/semantic-graph.js";
import { analyzePrompt } from "./skill-engine.js";
import { saveRun, getRuns, getRun, getStats } from "./pipeline/db.js";
import scoreOutput from "./evals/assertions/output-quality.js";

const PORT = Number(process.env.PORT || 4187);
const HOST = process.env.HOST || "127.0.0.1";

// ─── helpers ──────────────────────────────────────────────────────────────────

function json(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(payload, null, 2));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  const ct = req.headers["content-type"] || "";
  if (ct.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(text).entries());
  }
  return JSON.parse(text);
}

// Send a prompt to the downstream test LLM (Claude or Ollama).
// Claude/Cursor is the test environment — it only answers, never optimizes.
async function callDownstream(prompt, { provider, ollamaModel }) {
  if (provider === "claude") return callClaude(prompt);
  return ollamaChat([{ role: "user", content: prompt }], { model: ollamaModel });
}

// ─── server ───────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" });
    res.end();
    return;
  }

  // GET /health
  if (req.method === "GET" && url.pathname === "/health") {
    const llm = await ollamaAvailable();
    json(res, 200, { ok: true, llm });
    return;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // POST /benchmark  — the A/B test loop
  //
  // control:   messyPrompt → downstream LLM → rawOutput
  // treatment: messyPrompt → Maxx/Qwen → cleanedPrompt → same downstream LLM → maxxOutput
  // judge:     Promptfoo output-quality rubric scores both; saves delta to DB
  //
  // Body: { prompt, downstreamProvider?: "claude"|"ollama", optimizerModel?: "qwen3:1.7b" }
  // ────────────────────────────────────────────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/benchmark") {
    let body;
    try { body = await readBody(req); }
    catch { json(res, 400, { ok: false, error: "invalid body" }); return; }

    const rawPrompt          = String(body.prompt || "").trim();
    if (!rawPrompt) { json(res, 400, { ok: false, error: "prompt required" }); return; }

    const downstreamProvider = String(body.downstreamProvider || "claude");
    const optimizerModel     = String(body.optimizerModel     || process.env.OLLAMA_MODEL || "qwen3:1.7b");

    try {
      // ── Step 1: control path — raw prompt → downstream LLM
      const rawOutputPromise = callDownstream(rawPrompt, { provider: downstreamProvider, ollamaModel: optimizerModel });

      // ── Step 2: treatment path — Maxx compiles, then downstream LLM answers the cleaned prompt
      const { graph, intent } = await extractSemanticGraph(rawPrompt);
      const score             = scoreSemanticGraph(graph, intent.confidence);
      const rendered          = renderPrompt(graph, downstreamProvider === "claude" ? "cursor" : "generic");
      const cleanedPrompt     = await compilePromptWithLLM(rawPrompt, { graph, rendered, model: optimizerModel });
      const maxxOutputPromise = callDownstream(cleanedPrompt, { provider: downstreamProvider, ollamaModel: optimizerModel });

      // ── Step 3: wait for both LLM calls (run in parallel where possible)
      const [rawOutput, maxxOutput] = await Promise.all([rawOutputPromise, maxxOutputPromise]);

      // ── Step 4: Promptfoo rubric scores both outputs
      const rawScore  = scoreOutput(rawOutput).score;
      const maxxScore = scoreOutput(maxxOutput).score;
      const delta     = Math.round((maxxScore - rawScore) * 1000) / 1000;

      // ── Step 5: save full record
      const runId = saveRun({
        rawPrompt,
        cleanedPrompt,
        rawOutput,
        maxxOutput,
        rawScore,
        maxxScore,
        delta,
        downstreamProvider,
        optimizerModel,
        icsScore: score.total,
        intent:   intent.primary.label,
      });

      json(res, 200, {
        ok:       true,
        runId,
        rawPrompt,
        cleanedPrompt,
        rawOutput,
        maxxOutput,
        rawScore,
        maxxScore,
        delta,
        winner:   delta > 0.05 ? "maxx" : delta < -0.05 ? "raw" : "tie",
        downstreamProvider,
        optimizerModel,
      });
    } catch (err) {
      json(res, 500, { ok: false, error: err.message || "error" });
    }
    return;
  }

  // POST /ask  — compile only path (Maxx optimizes, downstream answers)
  // Body: { prompt, model?, targetModel? }
  if (req.method === "POST" && url.pathname === "/ask") {
    let body;
    try { body = await readBody(req); }
    catch { json(res, 400, { ok: false, error: "invalid body" }); return; }

    const prompt      = String(body.prompt || "").trim();
    if (!prompt) { json(res, 400, { ok: false, error: "prompt required" }); return; }

    const ollamaModel = String(body.model || process.env.OLLAMA_MODEL || "qwen3:1.7b");
    const targetModel = String(body.targetModel || "generic");

    try {
      const { graph, intent } = await extractSemanticGraph(prompt);
      const score = scoreSemanticGraph(graph, intent.confidence);

      if (intent.confidence < 0.35) {
        json(res, 200, {
          ok: true, unclear: true, graph,
          classification: { primary: "Unclear", confidence: intent.confidence },
          clarifyingQuestion: graph.missingInputs.length
            ? `What is the ${graph.missingInputs[0]} for this request?`
            : "What is the single most important outcome you need from this prompt?",
        });
        return;
      }

      const rendered      = renderPrompt(graph, targetModel);
      const cleanedPrompt = await compilePromptWithLLM(prompt, { graph, rendered, model: ollamaModel });

      json(res, 200, {
        ok: true,
        classification: { primary: intent.primary.label, confidence: intent.confidence },
        score: { total: score.total, breakdown: score.breakdown },
        cleanedPrompt,
        model: ollamaModel,
      });
    } catch (err) {
      json(res, 500, { ok: false, error: err.message || "error" });
    }
    return;
  }

  // POST /compile  — deterministic render only, no LLM
  if (req.method === "POST" && url.pathname === "/compile") {
    let body;
    try { body = await readBody(req); }
    catch { json(res, 400, { ok: false, error: "invalid body" }); return; }

    const prompt = String(body.prompt || "").trim();
    if (!prompt) { json(res, 400, { ok: false, error: "prompt required" }); return; }

    const targetModel = String(body.targetModel || "generic");

    try {
      const { graph, intent } = await extractSemanticGraph(prompt);
      const score = scoreSemanticGraph(graph, intent.confidence);
      const compiled = renderPrompt(graph, targetModel);

      json(res, 200, {
        ok: true,
        classification: { primary: intent.primary.label, confidence: intent.confidence },
        graph,
        score: { total: score.total, breakdown: score.breakdown },
        compiled,
      });
    } catch (err) {
      json(res, 500, { ok: false, error: err.message || "error" });
    }
    return;
  }

  // POST /raw  — send prompt directly to a downstream LLM, no Maxx processing
  // Used by Promptfoo raw-provider as the control path.
  // Body: { prompt, provider?: "claude"|"ollama", model? }
  if (req.method === "POST" && url.pathname === "/raw") {
    let body;
    try { body = await readBody(req); }
    catch { json(res, 400, { ok: false, error: "invalid body" }); return; }

    const prompt   = String(body.prompt   || "").trim();
    const provider = String(body.provider || "claude");
    if (!prompt) { json(res, 400, { ok: false, error: "prompt required" }); return; }

    try {
      const output = await callDownstream(prompt, {
        provider,
        ollamaModel: String(body.model || process.env.OLLAMA_MODEL || "qwen3:1.7b"),
      });
      json(res, 200, { ok: true, output });
    } catch (err) {
      json(res, 500, { ok: false, error: err.message || "error" });
    }
    return;
  }

  // GET /runs       — benchmark history (?limit=N)
  if (req.method === "GET" && url.pathname === "/runs") {
    const limit = Math.min(Number(url.searchParams.get("limit") || 50), 500);
    json(res, 200, { ok: true, runs: getRuns(limit), stats: getStats() });
    return;
  }

  // GET /runs/:id   — single run
  if (req.method === "GET" && /^\/runs\/\d+$/.test(url.pathname)) {
    const id  = Number(url.pathname.split("/")[2]);
    const run = getRun(id);
    if (!run) { json(res, 404, { ok: false, error: "run not found" }); return; }
    json(res, 200, { ok: true, run });
    return;
  }

  // POST /optimize  — legacy deterministic pipeline
  if (req.method === "POST" && url.pathname === "/optimize") {
    let body;
    try { body = await readBody(req); }
    catch { json(res, 400, { ok: false, error: "invalid body" }); return; }

    const prompt = String(body.prompt || "").trim();
    if (!prompt) { json(res, 400, { ok: false, error: "prompt required" }); return; }

    try {
      const result = await analyzePrompt({ prompt, metadata: {
        framework: body.framework || "",
        language:  body.language  || "",
        repoType:  body.repoType  || "",
      }});
      json(res, 200, result);
    } catch (err) {
      json(res, 500, { ok: false, error: err.message || "error" });
    }
    return;
  }

  json(res, 404, { ok: false, error: "not found" });
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`maxx  http://${HOST}:${PORT}\n`);
  ollamaAvailable().then((ok) => {
    process.stdout.write(`ollama  ${ok ? "ready" : "not reachable"}\n`);
  });
});
