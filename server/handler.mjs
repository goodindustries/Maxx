/**
 * maxx tally server — transport-agnostic request handler.
 *
 * Serves BOTH surfaces from one store, keyed by user handle:
 *   REST  (laptop emit.mjs):
 *     POST /api/u/:handle/logs      → ingest an envelope
 *     GET  /api/u/:handle/budget    → read the budget
 *   MCP   (account-wide cloud connector, Streamable HTTP / JSON-RPC 2.0):
 *     POST /mcp[?handle=]           → initialize | tools/list | tools/call
 *       tools: maxx_emit(envelope)  → same as POST logs
 *              maxx_budget()        → same as GET budget
 *
 * Storage-agnostic (inject a store adapter) and clock-injectable (for tests).
 * The Netlify function and a local node http server are both thin wrappers.
 */
import { applyEnvelope, computeBudget } from "./tally.mjs";

const TOOLS = [
  {
    name: "maxx_emit",
    description: "Report this session's token-usage metadata (counts only, never content) to the central maxx budget tally. Call at checkpoints during a long run and once at the end. A cloud routine cannot read /usage, so leave `anchor` unset.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        handle: { type: "string", description: "User handle (budget owner)." },
        surface: { type: "string", description: "e.g. cloud:<routine-or-session-id>" },
        sessions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              root: { type: "string" }, project: { type: "string" },
              name: { type: "string" }, branch: { type: "string" },
              billed: { type: "integer" }, output: { type: "integer" }, turns: { type: "integer" },
              by_model: { type: "object" },
              first_ts: { type: "string" }, last_ts: { type: "string" },
            },
            required: ["root", "billed"],
          },
        },
        anchor: { type: ["object", "null"] },
      },
      required: ["surface", "sessions"],
    },
  },
  {
    name: "maxx_budget",
    description: "Read the current omni-surface subscription budget (5h + weekly utilization, verdict, tokens left) from the central maxx tally. Use this to gate spend instead of reading any single machine's local signal.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: { handle: { type: "string" } },
    },
  },
];

// meetmaxx.co favicon — served from api.meetmaxx.co too, and advertised in serverInfo.
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="hsl(265 60% 94%)"/><text x="32" y="47" text-anchor="middle" font-family="ui-monospace,'SF Mono',Menlo,Consolas,monospace" font-size="44" font-weight="700" fill="hsl(264 66% 54%)">m</text></svg>`;
const ICON_URL = "https://meetmaxx.co/favicon.svg";

const json = (status, obj) => ({ status, headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });
const rpcOk = (id, result) => json(200, { jsonrpc: "2.0", id, result });
const rpcErr = (id, code, message) => json(200, { jsonrpc: "2.0", id, error: { code, message } });

export function createHandler({ store, secretFor = () => null, now = () => Date.now() / 1000 }) {
  const bearer = (headers) => {
    const h = headers.authorization || headers.Authorization || "";
    const m = /^Bearer\s+(.+)$/i.exec(h);
    return m ? m[1] : "";
  };
  // Token from the Bearer header OR a ?k= query param — the query form lets a
  // claude.ai custom connector self-authenticate via the URL alone (it can't
  // always set an Authorization header).
  const tokenOf = (headers, url) => bearer(headers) || url.searchParams.get("k") || "";
  const authed = async (handle, token) => {
    const want = await secretFor(handle);
    if (!want) return true; // no secret configured for this handle → open (local/dev)
    return token === want;
  };

  async function ingest(handle, env) {
    const s = await store.load(handle);
    const res = applyEnvelope(s, env || {});
    await store.save(handle, s);
    return res;
  }
  async function budget(handle) {
    const s = await store.load(handle);
    return computeBudget(s, now());
  }

  return async function handle(req) {
    const { method = "GET", headers = {}, body = "" } = req;
    let url;
    try { url = new URL(req.url, "http://x"); } catch { return json(400, { error: "bad url" }); }
    const p = url.pathname;

    if (method === "GET" && (p === "/" || p === "/health")) return json(200, { ok: true, service: "maxx-tally" });
    if (method === "GET" && (p === "/favicon.svg" || p === "/favicon.ico" || p === "/icon"))
      return { status: 200, headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" }, body: FAVICON };

    // ---- REST ----
    let m = p.match(/^\/api\/u\/([^/]+)\/logs$/);
    if (m && method === "POST") {
      const h = decodeURIComponent(m[1]);
      if (!(await authed(h, tokenOf(headers, url)))) return json(401, { error: "unauthorized" });
      let env; try { env = JSON.parse(body || "{}"); } catch { return json(400, { error: "bad json" }); }
      const res = await ingest(h, env);
      return json(200, { ok: true, ...res });
    }
    m = p.match(/^\/api\/u\/([^/]+)\/budget$/);
    if (m && method === "GET") {
      const h = decodeURIComponent(m[1]);
      if (!(await authed(h, tokenOf(headers, url)))) return json(401, { error: "unauthorized" });
      return json(200, await budget(h));
    }
    // Recent emit events (newest first) — the "who's emitting" feed for `maxx watch`.
    m = p.match(/^\/api\/u\/([^/]+)\/feed$/);
    if (m && method === "GET") {
      const h = decodeURIComponent(m[1]);
      if (!(await authed(h, tokenOf(headers, url)))) return json(401, { error: "unauthorized" });
      const n = Math.min(200, Math.max(1, Number(url.searchParams.get("n")) || 30));
      const s = await store.load(h);
      const events = s.events.slice(-n).reverse().map((e) => ({
        surface: e.surface, root: e.root, ts: new Date(e.ts * 1000).toISOString(),
        billed: e.billed, output: e.output || 0,
      }));
      return json(200, { count: s.events.length, events });
    }

    // ---- MCP (JSON-RPC 2.0 over Streamable HTTP) ----
    if (p === "/mcp" && method === "POST") {
      let rpc; try { rpc = JSON.parse(body || "{}"); } catch { return rpcErr(null, -32700, "parse error"); }
      const { id = null, method: rm, params = {} } = rpc;
      if (rm === "initialize")
        return rpcOk(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: {
            name: "Maxx", version: "1", title: "Maxx",
            websiteUrl: "https://meetmaxx.co",
            icons: [{ src: ICON_URL, mimeType: "image/svg+xml", sizes: ["any"] }],
          },
          // Server-level directive injected wherever the Maxx connector is enabled —
          // the closest MCP gets to a mandatory gate (still advisory; a PreToolUse
          // hook is the hard block).
          instructions:
            "BUDGET GATE — before doing any token-expensive work (spawning agents/subagents, " +
            "long generations, builds, large batches), you MUST first call `maxx_budget`. " +
            "It returns the whole account's live remaining budget (all machines + cloud combined). " +
            "STOP and do not proceed if: verdict is \"over\" or \"stale\", or session_to_spend is 0. " +
            "If verdict is \"ok\", session_to_spend is roughly how many tokens you may safely use this window. " +
            "This is a hard budget gate, not a suggestion — check it first, every run.",
        });
      if (rm === "notifications/initialized" || rm === "notifications/cancelled")
        return { status: 202, headers: {}, body: "" };
      if (rm === "ping") return rpcOk(id, {});
      if (rm === "tools/list") return rpcOk(id, { tools: TOOLS });
      if (rm === "tools/call") {
        const name = params.name;
        const args = params.arguments || {};
        const h = args.handle || url.searchParams.get("handle") || "";
        if (!h) return rpcOk(id, { isError: true, content: [{ type: "text", text: "no handle (pass args.handle or ?handle=)" }] });
        if (!(await authed(h, tokenOf(headers, url))))
          return rpcOk(id, { isError: true, content: [{ type: "text", text: "unauthorized" }] });
        try {
          if (name === "maxx_emit") {
            const res = await ingest(h, { handle: h, ...args });
            return rpcOk(id, { content: [{ type: "text", text: JSON.stringify({ ok: true, ...res }) }] });
          }
          if (name === "maxx_budget") {
            return rpcOk(id, { content: [{ type: "text", text: JSON.stringify(await budget(h)) }] });
          }
          return rpcOk(id, { isError: true, content: [{ type: "text", text: `unknown tool ${name}` }] });
        } catch (e) {
          return rpcOk(id, { isError: true, content: [{ type: "text", text: `error: ${e.message}` }] });
        }
      }
      return rpcErr(id, -32601, `method not found: ${rm}`);
    }

    return json(404, { error: "not found" });
  };
}

export { TOOLS };
