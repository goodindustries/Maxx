import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzePrompt, skillSamples } from "./skill-engine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const basePort = Number(process.env.PORT || 4181);
const host = process.env.HOST || "127.0.0.1";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload, null, 2));
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) {
    return {};
  }

  const contentType = req.headers["content-type"] || "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(text).entries());
  }

  return JSON.parse(text);
}

async function serveStatic(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const filePath = path.resolve(__dirname, `.${pathname}`);

  if (!filePath.startsWith(__dirname)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  try {
    const data = await readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, {
      "Content-Type": mimeTypes[ext] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(data);
  } catch {
    sendText(res, 404, "Not found");
  }
}

const server = createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && requestUrl.pathname === "/api/health") {
    sendJson(res, 200, { ok: true, status: "healthy" });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/samples") {
    sendJson(res, 200, { ok: true, samples: skillSamples });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/skill/optimize") {
    try {
      const body = await readBody(req);
      const prompt = String(body.prompt || "").trim();
      if (!prompt) {
        sendJson(res, 400, { ok: false, error: "Prompt is required" });
        return;
      }

      const metadata = {
        framework: body.framework || "",
        language: body.language || "",
        repoType: body.repoType || "",
        modelType: body.modelType || "",
      };

      sendJson(res, 200, await analyzePrompt({ prompt, metadata }));
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message || "Invalid JSON body" });
    }
    return;
  }

  await serveStatic(req, res);
});

function listen(port) {
  server.once("error", (error) => {
    if (error.code === "EADDRINUSE" && port < basePort + 20) {
      listen(port + 1);
      return;
    }

    throw error;
  });

  server.listen(port, host, () => {
    process.stdout.write(`Maxx skill prototype listening on http://127.0.0.1:${port}\n`);
  });
}

listen(basePort);
