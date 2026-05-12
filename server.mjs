import { createServer } from "node:http";
import { analyzePrompt } from "./skill-engine.js";

const port = Number(process.env.PORT || 4181);
const host = process.env.HOST || "127.0.0.1";

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

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    json(res, 200, { ok: true });
    return;
  }

  // POST /optimize  — body: { prompt, provider?, framework?, language?, repoType? }
  if (req.method === "POST" && url.pathname === "/optimize") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      json(res, 400, { ok: false, error: "invalid request body" });
      return;
    }

    const prompt = String(body.prompt || "").trim();
    if (!prompt) {
      json(res, 400, { ok: false, error: "prompt is required" });
      return;
    }

    try {
      const result = await analyzePrompt({
        prompt,
        metadata: {
          framework: body.framework || "",
          language: body.language || "",
          repoType: body.repoType || "",
          provider: body.provider || "",
        },
      });
      json(res, 200, result);
    } catch (err) {
      json(res, 500, { ok: false, error: err.message || "pipeline error" });
    }
    return;
  }

  json(res, 404, { ok: false, error: "not found" });
});

server.listen(port, host, () => {
  process.stdout.write(`maxx listening on http://${host}:${port}\n`);
});
