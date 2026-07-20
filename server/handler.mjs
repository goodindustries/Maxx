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
import { randomBytes } from "node:crypto";
import { applyEnvelope, computeBudget, transitionEvents, addDirective, pendingDirectives } from "./tally.mjs";

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
  {
    name: "maxx_reserve",
    description: "Reserve part of session_to_spend before spawning agents, so concurrent dispatchers don't double-spend the same allowance. Granted leases subtract from the session_to_spend other callers see and auto-expire at ttl_sec. Returns {granted, lease_id, remaining}. Call before a fan-out; size tokens to the fleet you're about to spawn.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        handle: { type: "string" },
        tokens: { type: "integer", description: "Tokens to reserve" },
        ttl_sec: { type: "integer", description: "Lease lifetime (default 3600)" },
        label: { type: "string", description: "Who/what this lease is for" },
      },
      required: ["tokens"],
    },
  },
  {
    name: "maxx_directive",
    description:
      "Send a command to a specific live session (or '*' broadcast) through the fleet command plane. " +
      "Actions: pause (deny that session's expensive tool calls until ttl or resume — use to throttle a runaway or protect budget), " +
      "resume (lift pauses), clear (advise the session to /clear — injected as context when its context is bloated). " +
      "Target sessions come from maxx_budget top_burners or the feed. Delivery + consumption are audited in the feed.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        handle: { type: "string" },
        session: { type: "string", description: "Target session id, or '*' for all" },
        action: { type: "string", enum: ["clear", "pause", "resume"] },
        note: { type: "string", description: "Why — shown to the target session" },
        ttl_sec: { type: "integer", description: "Directive lifetime (default 3600, max 86400)" },
        surface: { type: "string", description: "Optional surface filter, e.g. laptop:abc123" },
      },
      required: ["session", "action"],
    },
  },
];

// meetmaxx.co favicon — served from api.meetmaxx.co too, and advertised in serverInfo.
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="hsl(265 60% 94%)"/><text x="32" y="47" text-anchor="middle" font-family="ui-monospace,'SF Mono',Menlo,Consolas,monospace" font-size="44" font-weight="700" fill="hsl(264 66% 54%)">m</text></svg>`;

// Browser callers (the meetmaxx.co signup form) live on a different origin than the API — open
// CORS is safe here: auth is the bearer/`?k=` secret, never cookies, and only usage metadata moves.
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, OPTIONS" };

// ---- live card page (GET /u/{handle}) ------------------------------------------------------
const fmtN = (n) => Math.round(n).toLocaleString("en-US");
const humanN = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + "B" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "K" : String(Math.round(n)));
function renderCard(h, s, b) {
  // hero = RAW lifetime (the number a human recognizes); weighted units stay on the weekly row.
  const rawOf = (e) => e.raw || e.billed || 0;
  const lifetime = s.events.reduce((a, e) => a + rawOf(e), 0);
  // daily buckets (UTC) for the area chart
  const byDay = new Map();
  for (const e of s.events) {
    if (!e.ts) continue;
    const d = new Date(e.ts * 1000).toISOString().slice(0, 10);
    byDay.set(d, (byDay.get(d) || 0) + rawOf(e));
  }
  const days = [...byDay.keys()].sort();
  const first = days[0], today = new Date().toISOString().slice(0, 10);
  // dense series first→today so idle days show as dips, not skipped
  const series = [];
  if (first) for (let t = new Date(first + "T00:00:00Z").getTime(); ; t += 86400000) {
    const d = new Date(t).toISOString().slice(0, 10);
    series.push(byDay.get(d) || 0);
    if (d >= today) break;
  }
  const peak = Math.max(1, ...series);
  const W = 1080, H = 150, n = Math.max(2, series.length);
  const pts = series.map((v, i) => `${(i * W / (n - 1)).toFixed(1)},${(H - (v / peak) * (H - 6)).toFixed(1)}`);
  const line = "M" + pts.join("L");
  const area = line + `L${W},${H}L0,${H}Z`;
  const peakI = series.indexOf(Math.max(...series));
  const peakDay = days.length ? new Date(new Date(first + "T00:00:00Z").getTime() + peakI * 86400000).toISOString().slice(5, 10).replace("-", "/") : "";
  const [px, py] = (pts[peakI] || "0,0").split(",");
  const avail = b.session_to_spend, weekLeft = b.weekly_left_tokens;
  const refillMin = b.five_reset_in_sec != null ? Math.round(b.five_reset_in_sec / 60) : null;
  const refillTxt = refillMin != null ? `${Math.floor(refillMin / 60)}h ${refillMin % 60}m` : "?";
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const url = `https://meetmaxx.co/u/${h}`;
  const desc = `${humanN(lifetime)} lifetime Claude tokens · live tally, anchored to Anthropic /usage · verified by Maxx`;
  const shareTxt = `${humanN(lifetime)} lifetime Claude tokens, verified by @meetmaxx`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h} — Verified token usage · Maxx</title>
<meta property="og:title" content="${h} — verified Claude token usage">
<meta property="og:description" content="${desc}">
<meta property="og:url" content="${url}">
<meta property="og:type" content="website">
<meta property="og:image" content="https://meetmaxx.co/og-card.png">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${h} — verified Claude token usage">
<meta name="twitter:description" content="${desc}">
<meta name="twitter:image" content="https://meetmaxx.co/og-card.png">
<link rel="icon" href="https://meetmaxx.co/favicon.svg" type="image/svg+xml">
<style>
:root{--bg:#f6f9fc;--card:#fff;--line:#e6ebf1;--ink:#0a2540;--ink-2:#425466;--ink-3:#8898aa;--accent:#635bff;--sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;--mono:ui-monospace,"SF Mono",Menlo,monospace}
*{box-sizing:border-box;margin:0}
body{background:var(--bg);color:var(--ink);font-family:var(--sans);min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;gap:14px}
.card{width:1200px;max-width:100%;background:var(--card);border:1px solid var(--line);border-radius:20px;box-shadow:0 15px 35px rgba(60,66,87,.08),0 5px 15px rgba(0,0,0,.06);padding:46px 60px 40px;display:flex;flex-direction:column}
.top{display:flex;align-items:center;justify-content:space-between}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:21px}
.brand .m{color:var(--accent);font-size:24px}
.who{font-family:var(--mono);font-size:14px;color:var(--ink-2);font-weight:400}
.badge{display:inline-flex;align-items:center;gap:7px;background:#f0f4ff;color:var(--accent);border:1px solid #dfe5ff;border-radius:999px;padding:7px 16px;font-size:14.5px;font-weight:600}
.hero{margin-top:28px;display:flex;align-items:baseline;gap:18px;flex-wrap:wrap}
.hero .n{font-size:clamp(34px,6vw,76px);font-weight:700;letter-spacing:-.03em;line-height:1;font-variant-numeric:tabular-nums}
.hero .l{color:var(--ink-2);font-size:16.5px}
.chart{margin-top:22px;position:relative}
.chart .cap{display:flex;justify-content:space-between;color:var(--ink-3);font-size:13px;margin-top:6px}
.peak{position:absolute;font-size:12.5px;color:var(--ink-2);font-weight:600;white-space:nowrap}
.rows{margin-top:18px;border-top:1px solid var(--line)}
.r{display:flex;justify-content:space-between;align-items:baseline;padding:12.5px 0;border-bottom:1px solid var(--line);font-size:16px;gap:12px;flex-wrap:wrap}
.r .k{color:var(--ink-2)}.r .v{font-weight:600;font-variant-numeric:tabular-nums}
.r .sub{color:var(--ink-3);font-weight:400;font-size:14px}
.foot{margin-top:22px;display:flex;justify-content:space-between;align-items:baseline;color:var(--ink-3);font-size:13.5px;gap:10px;flex-wrap:wrap}
.foot a{color:var(--accent);font-weight:600;text-decoration:none}
.share{display:flex;gap:10px}
.share button,.share a{border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:10px;padding:9px 18px;font-size:14.5px;font-weight:600;cursor:pointer;text-decoration:none;font-family:var(--sans)}
.share .primary{background:var(--accent);border-color:var(--accent);color:#fff}
</style></head><body>
<div class="card">
 <div class="top">
  <div class="brand"><span class="m">⩗</span> maxx <span class="who">· @${h}</span></div>
  <div class="badge">✓ Verified usage · live</div>
 </div>
 <div class="hero"><div class="n">${fmtN(lifetime)}</div><div class="l">lifetime tokens</div></div>
 <div class="chart">
  <svg width="100%" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="display:block">
   <path d="${area}" fill="#635bff" opacity=".12"/>
   <path d="${line}" fill="none" stroke="#635bff" stroke-width="2"/>
   <circle cx="${px}" cy="${py}" r="4" fill="#635bff" stroke="#fff" stroke-width="2"/>
  </svg>
  ${peakDay ? `<div class="peak" style="left:${(peakI / (n - 1) * 100).toFixed(1)}%;top:-6px;transform:translateX(-${peakI > n * 0.7 ? 105 : 0}%)">peak ${humanN(Math.max(...series))} · ${peakDay}</div>` : ""}
  <div class="cap"><span>${first || ""}</span><span>daily tokens · all machines &amp; cloud · this Claude account</span><span>today</span></div>
 </div>
 <div class="rows">
  <div class="r"><span class="k">Available right now</span><span class="v">${avail != null ? humanN(avail) : "—"} <span class="sub">· window refills in ${refillTxt}</span></span></div>
  <div class="r"><span class="k">Weekly limit remaining</span><span class="v">${weekLeft != null ? humanN(weekLeft) : "—"} <span class="sub">· ${b.week != null ? Math.round(b.week * 100) + "% used ·" : ""} quota units${b.week_reset_in_sec != null ? " · resets in " + Math.round(b.week_reset_in_sec / 3600) + "h" : ""}</span></span></div>
 </div>
 <div class="foot">
  <span>⩗ Verified by Maxx — counted from session logs, anchored to Anthropic /usage · <span id="stamp">${stamp}</span></span>
  <a href="https://meetmaxx.co">See your usage at meetmaxx.co →</a>
 </div>
</div>
<div class="share">
 <button class="primary" id="sh">Share</button>
 <a href="https://twitter.com/intent/tweet?text=${encodeURIComponent(shareTxt)}&url=${encodeURIComponent(url)}" target="_blank" rel="noopener">Post on X</a>
 <button id="cp">Copy link</button>
</div>
<script>
document.getElementById('sh').addEventListener('click',function(){
  if(navigator.share)navigator.share({title:document.title,text:"${shareTxt}",url:"${url}"}).catch(function(){});
  else{navigator.clipboard.writeText("${url}");this.textContent="Copied";}
});
document.getElementById('cp').addEventListener('click',function(){navigator.clipboard.writeText("${url}");this.textContent="Copied";setTimeout(()=>this.textContent="Copy link",1500);});
setTimeout(function(){location.reload()},60000);
</script>
</body></html>`;
}

const json = (status, obj) => ({ status, headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });
const rpcOk = (id, result) => json(200, { jsonrpc: "2.0", id, result });
const rpcErr = (id, code, message) => json(200, { jsonrpc: "2.0", id, error: { code, message } });

// secretFor(handle) = PER-HANDLE secret only (e.g. MAXX_SECRET_<HANDLE> env);
// fallbackSecret = shared operator secret that also gates unclaimed handles on a
// public deploy — it must NOT make handles look "taken" to signup.
export function createHandler({ store, secretFor = () => null, fallbackSecret = null, now = () => Date.now() / 1000 }) {
  const bearer = (headers) => {
    const h = headers.authorization || headers.Authorization || "";
    const m = /^Bearer\s+(.+)$/i.exec(h);
    return m ? m[1] : "";
  };
  // Token from the Bearer header OR a ?k= query param — the query form lets a
  // claude.ai custom connector self-authenticate via the URL alone (it can't
  // always set an Authorization header).
  const tokenOf = (headers, url) => bearer(headers) || url.searchParams.get("k") || "";
  // Self-serve secrets (signup) live in the store; env secrets (MAXX_SECRET*) are
  // the operator fallback that also gates unclaimed handles on a public deploy.
  const authed = async (handle, token) => {
    const want = (await store.getSecret?.(handle)) || (await secretFor(handle)) || fallbackSecret;
    if (!want) return true; // no secret configured at all → open (local/dev)
    return token === want;
  };

  // ---- webhook push (#1/#3): fire transition events to registered URLs.
  // Fire-and-forget with a timeout; a dead consumer never blocks ingest.
  function fireWebhooks(handle, s, events) {
    for (const hook of s.webhooks || []) {
      for (const ev of events) {
        const payload = { ...ev, handle };
        const isDash = hook.format === "dash";
        const body = isDash
          ? JSON.stringify({ source: "maxx", kind: `budget-${ev.event}`, payload: { text: `maxx: ${ev.event} verdict=${ev.verdict} spend=${ev.session_to_spend} week=${Math.round((ev.week || 0) * 100)}%${ev.session ? ` session=${ev.session}` : ""}` } })
          : JSON.stringify(payload);
        fetch(hook.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(hook.secret ? { authorization: `Bearer ${hook.secret}` } : {}),
            ...(hook.headers || {}),
          },
          body,
          signal: AbortSignal.timeout(8000),
        }).catch(() => {});
      }
    }
  }

  // Recompute state + fire any transition webhooks. Used after every ingest AND
  // by the periodic sweep (refills happen on the clock, not on an ingest).
  function settle(handle, s) {
    const t = now();
    s.leases = (s.leases || []).filter((l) => l.expires > t);   // prune expired
    const b = computeBudget(s, t);
    const events = transitionEvents(s, b, t);
    if (events.length) fireWebhooks(handle, s, events);
    return { budget: b, events };
  }

  async function ingest(handle, env) {
    const s = await store.load(handle);
    const res = applyEnvelope(s, env || {});
    settle(handle, s);
    await store.save(handle, s);
    return res;
  }
  async function budget(handle) {
    const s = await store.load(handle);
    return computeBudget(s, now());
  }

  // #4: grant a lease against the CURRENT allowance (which already subtracts
  // other active leases) — two concurrent dispatchers can't double-spend.
  async function reserve(handle, { tokens, ttl_sec = 3600, label = null } = {}) {
    tokens = Math.round(Number(tokens));
    if (!(tokens > 0)) return { granted: false, error: "tokens must be > 0" };
    const s = await store.load(handle);
    const t = now();
    s.leases = (s.leases || []).filter((l) => l.expires > t);
    const b = computeBudget(s, t);
    const avail = b.session_to_spend ?? 0;
    if (b.verdict !== "ok" || tokens > avail)
      return { granted: false, remaining: avail, verdict: b.verdict };
    const lease = { id: randomBytes(8).toString("hex"), tokens, expires: Math.round(t + Math.min(Math.max(ttl_sec, 60), 6 * 3600)), label };
    s.leases.push(lease);
    await store.save(handle, s);
    return { granted: true, lease_id: lease.id, tokens, remaining: avail - tokens, expires_at: lease.expires };
  }

  // periodic sweep for time-driven transitions (refill while idle) — serve.mjs
  // calls this on an interval; handles without webhooks are skipped cheaply.
  async function sweepTransitions() {
    if (!store.listHandles) return;
    for (const h of await store.listHandles()) {
      const s = await store.load(h);
      if (!(s.webhooks || []).length) continue;
      const { events } = settle(h, s);
      await store.save(h, s);
      if (events.length) console.log(`sweep: ${h} fired ${events.map((e) => e.event).join(",")}`);
    }
  }

  // route() does the work; handle() wraps every response with CORS (and answers preflights) so the
  // web signup form can call the API cross-origin.
  async function handle(req) {
    if ((req.method || "GET") === "OPTIONS") return { status: 204, headers: { ...CORS }, body: "" };
    const r = await route(req);
    return { ...r, headers: { ...CORS, ...(r.headers || {}) } };
  }

  async function route(req) {
    const { method = "GET", headers = {}, body = "" } = req;
    let url;
    try { url = new URL(req.url, "http://x"); } catch { return json(400, { error: "bad url" }); }
    const p = url.pathname;

    if (method === "GET" && (p === "/" || p === "/health")) return json(200, { ok: true, service: "maxx-tally" });
    if (method === "GET" && (p === "/favicon.svg" || p === "/favicon.ico" || p === "/icon"))
      return { status: 200, headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" }, body: FAVICON };

    // ---- live public card: GET /u/{handle} — renders from the tally on every hit, so the page a
    // user shares is always current (the old static card went stale the moment it was deployed).
    // meetmaxx.co/u/* rewrites here. Public by design: usage totals only, same as the static card.
    const mc = p.match(/^\/u\/([a-z0-9][a-z0-9_-]{2,31})\/?$/);
    if (mc && method === "GET") {
      const h = mc[1];
      const s = await store.load(h);
      if (!s.events.length) return { status: 404, headers: { "content-type": "text/html" }, body: `<!doctype html><meta charset="utf-8"><title>maxx</title><p style="font-family:sans-serif;padding:40px">No usage for <b>@${h}</b> yet — <a href="https://meetmaxx.co">claim your handle</a>.</p>` };
      const budget = computeBudget(s, now());
      return { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" }, body: renderCard(h, s, budget) };
    }

    // ---- signup: claim a handle, mint its secret (first come, first served) ----
    if (p === "/api/signup" && method === "POST") {
      if (!store.setSecret) return json(404, { error: "signup not enabled on this deploy" });
      let b; try { b = JSON.parse(body || "{}"); } catch { return json(400, { error: "bad json" }); }
      const h = String(b.handle || "").toLowerCase();
      if (!/^[a-z0-9][a-z0-9_-]{2,31}$/.test(h))
        return json(400, { error: "handle must be 3-32 chars: a-z 0-9 - _ (no leading - or _)" });
      if ((await store.getSecret(h)) || (await secretFor(h)) || (await store.load(h)).events.length)
        return json(409, { error: `handle "${h}" is taken` });
      const secret = randomBytes(18).toString("base64url");
      await store.setSecret(h, secret);
      // Optional Claude-account binding: Claude only works logged in, so the account uuid is the one
      // identity every surface can key off. Emits carry it too; stored here so a handle is findable
      // by account later (multi-machine join, per-account timelines).
      if (b.account) { const s = await store.load(h); s.account = String(b.account).slice(0, 64); s.account_email = String(b.email || "").slice(0, 128); await store.save(h, s); }
      const base = `https://${headers["x-forwarded-host"] || headers.host || "api.meetmaxx.co"}`;
      return json(200, {
        ok: true, handle: h, secret,
        mcp_url: `${base}/mcp?handle=${h}&k=${secret}`,
        logs_url: `${base}/api/u/${h}/logs`,
        budget_url: `${base}/api/u/${h}/budget`,
        feed_url: `${base}/api/u/${h}/feed`,
        next: [
          "SAVE the secret — it is shown once and not recoverable.",
          `Cloud (optional): open https://claude.ai/settings/connectors → Add custom connector → name "Maxx", URL = mcp_url above. Every agent with it gets the budget-gate rules automatically. NOTE: it auto-attaches to NEW routines only — add it to pre-existing routines by hand.`,
          "Laptop: curl -fsSL https://raw.githubusercontent.com/goodindustries/Maxx/main/maxx/install.sh | bash",
          `Then: node ~/.claude/skills/maxx/emit.mjs --signup ${h}  (already done if you signed up via emit) and node ~/.claude/skills/maxx/emit.mjs --install-agent`,
        ],
      });
    }

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
    // ---- webhooks (#1): register push consumers for state transitions ----
    m = p.match(/^\/api\/u\/([^/]+)\/webhooks$/);
    if (m) {
      const h = decodeURIComponent(m[1]);
      if (!(await authed(h, tokenOf(headers, url)))) return json(401, { error: "unauthorized" });
      const s = await store.load(h);
      s.webhooks = s.webhooks || [];
      if (method === "GET")
        return json(200, { webhooks: s.webhooks.map((w) => ({ url: w.url, format: w.format || "json", secret: w.secret ? "(set)" : null })) });
      let b; try { b = JSON.parse(body || "{}"); } catch { return json(400, { error: "bad json" }); }
      if (method === "DELETE") {
        s.webhooks = s.webhooks.filter((w) => w.url !== b.url);
        await store.save(h, s);
        return json(200, { ok: true, webhooks: s.webhooks.length });
      }
      if (method === "POST") {
        if (!/^https?:\/\//.test(b.url || "")) return json(400, { error: "url required" });
        s.webhooks = s.webhooks.filter((w) => w.url !== b.url);
        s.webhooks.push({ url: b.url, secret: b.secret || null, headers: b.headers || null, format: b.format || null });
        await store.save(h, s);
        return json(200, { ok: true, webhooks: s.webhooks.length, events: ["over", "refill", "week-80", "week-90", "week-95", "runaway"] });
      }
    }
    // ---- reservation lease (#4) ----
    m = p.match(/^\/api\/u\/([^/]+)\/reserve$/);
    if (m && method === "POST") {
      const h = decodeURIComponent(m[1]);
      if (!(await authed(h, tokenOf(headers, url)))) return json(401, { error: "unauthorized" });
      let b; try { b = JSON.parse(body || "{}"); } catch { return json(400, { error: "bad json" }); }
      return json(200, await reserve(h, b));
    }
    m = p.match(/^\/api\/u\/([^/]+)\/release$/);
    if (m && method === "POST") {
      const h = decodeURIComponent(m[1]);
      if (!(await authed(h, tokenOf(headers, url)))) return json(401, { error: "unauthorized" });
      let b; try { b = JSON.parse(body || "{}"); } catch { return json(400, { error: "bad json" }); }
      const s = await store.load(h);
      const before = (s.leases || []).length;
      s.leases = (s.leases || []).filter((l) => l.id !== b.lease_id);
      await store.save(h, s);
      return json(200, { ok: true, released: before - s.leases.length });
    }
    // ---- per-handle config (#3 overrides: runaway_rate_5m, runaway_min) ----
    m = p.match(/^\/api\/u\/([^/]+)\/config$/);
    if (m && method === "POST") {
      const h = decodeURIComponent(m[1]);
      if (!(await authed(h, tokenOf(headers, url)))) return json(401, { error: "unauthorized" });
      let b; try { b = JSON.parse(body || "{}"); } catch { return json(400, { error: "bad json" }); }
      const s = await store.load(h);
      s.config = { ...(s.config || {}) };
      for (const k of ["runaway_rate_5m", "runaway_min"]) if (b[k] != null) s.config[k] = Number(b[k]);
      await store.save(h, s);
      return json(200, { ok: true, config: s.config });
    }
    // ---- directive channel: queue a command / agent-side consume ----
    m = p.match(/^\/api\/u\/([^/]+)\/directive$/);
    if (m && method === "POST") {
      const h = decodeURIComponent(m[1]);
      if (!(await authed(h, tokenOf(headers, url)))) return json(401, { error: "unauthorized" });
      let b; try { b = JSON.parse(body || "{}"); } catch { return json(400, { error: "bad json" }); }
      const s = await store.load(h);
      const res = addDirective(s, b, now());
      if (res.ok) await store.save(h, s);
      return json(res.ok ? 200 : 400, res);
    }
    m = p.match(/^\/api\/u\/([^/]+)\/directives$/);
    if (m && method === "GET") {
      const h = decodeURIComponent(m[1]);
      if (!(await authed(h, tokenOf(headers, url)))) return json(401, { error: "unauthorized" });
      const session = url.searchParams.get("session") || "";
      if (!session) return json(400, { error: "session query param required" });
      const peek = url.searchParams.get("peek") === "1";
      const s = await store.load(h);
      const directives = pendingDirectives(s, { session, surface: url.searchParams.get("surface"), peek }, now());
      if (!peek) await store.save(h, s);
      return json(200, { directives });
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
        project: e.project || null, name: e.name || null, branch: e.branch || null,
        by_model: e.by_model || {}, turns: e.turns || 0, tool_calls: e.tool_calls || 0,
        agent_turns: e.agent_turns || 0, raw: e.raw || 0,
        cache_read: e.cache_read || 0, cache_write: e.cache_write || 0,
        ctx: e.ctx || 0, cost_per_action: e.cost_per_action || 0,
      }));
      return json(200, { count: s.events.length, events });
    }

    // ---- MCP (JSON-RPC 2.0 over Streamable HTTP) ----
    if (p === "/mcp" && method === "POST") {
      let rpc; try { rpc = JSON.parse(body || "{}"); } catch { return rpcErr(null, -32700, "parse error"); }
      const { id = null, method: rm, params = {} } = rpc;
      if (rm === "initialize") {
        // Icon MUST be same-origin with the server URL — MCP clients (claude.ai included) reject
        // cross-origin icons, which is why the connector page showed no logo while the icon pointed
        // at meetmaxx.co from an api.meetmaxx.co server. Echo a known protocolVersion back too:
        // icons/websiteUrl only render on 2025+ revisions.
        const base = `https://${headers["x-forwarded-host"] || headers.host || "api.meetmaxx.co"}`;
        const KNOWN = ["2024-11-05", "2025-03-26", "2025-06-18"];
        return rpcOk(id, {
          protocolVersion: KNOWN.includes(params.protocolVersion) ? params.protocolVersion : "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: {
            name: "Maxx", version: "1", title: "Maxx",
            websiteUrl: "https://meetmaxx.co",
            icons: [{ src: `${base}/favicon.svg`, mimeType: "image/svg+xml", sizes: ["any"] }],
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
      }
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
          if (name === "maxx_reserve") {
            return rpcOk(id, { content: [{ type: "text", text: JSON.stringify(await reserve(h, args)) }] });
          }
          if (name === "maxx_directive") {
            const s = await store.load(h);
            const res = addDirective(s, args, now());
            if (res.ok) await store.save(h, s);
            return rpcOk(id, { content: [{ type: "text", text: JSON.stringify(res) }] });
          }
          return rpcOk(id, { isError: true, content: [{ type: "text", text: `unknown tool ${name}` }] });
        } catch (e) {
          return rpcOk(id, { isError: true, content: [{ type: "text", text: `error: ${e.message}` }] });
        }
      }
      return rpcErr(id, -32601, `method not found: ${rm}`);
    }

    return json(404, { error: "not found" });
  }

  handle.sweepTransitions = sweepTransitions;   // for the runner's interval
  return handle;
}

export { TOOLS };
