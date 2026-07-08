#!/usr/bin/env node
/**
 * maxx endpoint — the data channel. Serves today's live content to every
 * installed runner. Publishing to the whole installed base = editing today.json
 * (or POSTing to it); runners poll GET /today and reflect it within ~1 tick.
 *
 *   GET /health  -> { ok: true }
 *   GET /today   -> { widget, banner, presence:{people}, ... }  (the live payload)
 *   POST /today  -> replace today.json  (bearer-guarded; how you publish)
 *   POST /ping   -> { ok, online }  heartbeat: register an install, get the live count
 *   GET /presence-> { online }      just the count
 *
 * Data only. The runner never executes anything it fetches here.
 * Presence is in-memory (single instance) — installId -> lastSeen; "online" = seen in
 * the last 5 min. Resets on restart; swap for a shared store if you run >1 instance.
 */
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const TODAY_FILE = process.env.TOKENMAXX_TODAY || join(ROOT, "today.json");
const PUBLISH_TOKEN = process.env.TOKENMAXX_PUBLISH_TOKEN || "";

const DEFAULT = { widget: "><> maxx", banner: "cleaner runs, not bigger burns" };

// live presence: installId -> { ts, handle }. "online" = pinged within the window.
const PRESENCE_WINDOW = 5 * 60_000;
const presence = new Map();
function sweep() { const cut = Date.now() - PRESENCE_WINDOW; for (const [id, v] of presence) if (v.ts < cut) presence.delete(id); }
function onlineCount() { sweep(); return presence.size; }
function onlineWho(limit = 24) {
  sweep();
  const seen = new Set();
  for (const v of presence.values()) if (v.handle) seen.add(v.handle);
  return [...seen].slice(0, limit);
}

function today() {
  try { return JSON.parse(readFileSync(TODAY_FILE, "utf8")); }
  catch { return { ...DEFAULT }; }
}
function send(res, status, obj) {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(obj));
}
function readBody(req, limit = 64_000) {
  return new Promise((resolve, reject) => {
    let d = "";
    req.on("data", (c) => { d += c; if (d.length > limit) reject(new Error("too large")); });
    req.on("end", () => resolve(d));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  // lucky reverse-proxies under /tokenmaxx/, so match by suffix
  const p = (new URL(req.url, "http://x").pathname).replace(/\/+$/, "");
  const is = (name) => p === "/" + name || p.endsWith("/" + name);

  if (req.method === "GET" && is("health")) return send(res, 200, { ok: true });
  if (req.method === "GET" && is("presence")) return send(res, 200, { online: onlineCount(), who: onlineWho() });

  // heartbeat: a client checks in with its installId (+ optional handle); we return
  // the live count and the handles of who's online right now.
  if (req.method === "POST" && is("ping")) {
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch {}
    const id = String(body.id || "").slice(0, 128);
    const handle = String(body.handle || "").slice(0, 32).replace(/[^a-zA-Z0-9_-]/g, "");
    if (id) presence.set(id, { ts: Date.now(), handle });
    return send(res, 200, { ok: true, online: onlineCount(), who: onlineWho() });
  }

  if (req.method === "GET" && is("today"))
    return send(res, 200, { ...today(), presence: { people: onlineCount(), who: onlineWho() }, served_at: new Date().toISOString() });

  if (req.method === "POST" && is("today")) {
    const auth = (req.headers["authorization"] || "").replace(/^Bearer\s+/, "");
    if (!PUBLISH_TOKEN || auth !== PUBLISH_TOKEN) return send(res, 401, { error: "unauthorized" });
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch { return send(res, 400, { error: "invalid json" }); }
    try { writeFileSync(TODAY_FILE, JSON.stringify(body, null, 2)); }
    catch (e) { return send(res, 500, { error: String(e.message || e) }); }
    return send(res, 200, { ok: true, published: body });
  }
  send(res, 404, { error: "not found" });
});

server.listen(PORT, () => process.stdout.write(`maxx endpoint on :${PORT} (today=${TODAY_FILE})\n`));
