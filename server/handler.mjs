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
function renderCard(h, s, b, setup = null) {
  // hero = RAW lifetime (the number a human recognizes); weighted units stay on the weekly row.
  const rawOf = (e) => e.raw || e.billed || 0;
  const lifetime = s.events.reduce((a, e) => a + rawOf(e), 0);
  const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const humanDay = (t) => { const d = new Date(t); return `${MO[d.getUTCMonth()]} ${d.getUTCDate()}`; };
  // ---- range series for the chart toggle: hourly / daily / monthly / all time.
  // Buckets are computed server-side so the public page embeds aggregates only, never raw events.
  const evs = s.events.filter((e) => e.ts > 0).map((e) => ({ ts: e.ts * 1000, v: rawOf(e) }));
  const nowMs = Date.now();
  const bucketed = (startMs, stepMs, count, fmt) => {
    const vals = new Array(count).fill(0), labels = [];
    for (let i = 0; i < count; i++) labels.push(fmt(startMs + i * stepMs));
    for (const e of evs) { const i = Math.floor((e.ts - startMs) / stepMs); if (i >= 0 && i < count) vals[i] += e.v; }
    return { labels, vals };
  };
  const HOUR = 3600e3, DAY = 86400e3;
  const hourStart = Math.floor(nowMs / HOUR) * HOUR - 47 * HOUR;
  const dayStart = Math.floor(nowMs / DAY) * DAY - 29 * DAY;
  const fmtHour = (t) => `${humanDay(t)} ${String(new Date(t).getUTCHours()).padStart(2, "0")}:00`;
  // monthly: last 12 calendar months (UTC), irregular steps → bucket by month key
  const monthly = (() => {
    const nowD = new Date(nowMs);
    const keys = [], labels = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth() - i, 1));
      keys.push(d.toISOString().slice(0, 7));
      labels.push(`${MO[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`);
    }
    const vals = new Array(12).fill(0);
    for (const e of evs) { const i = keys.indexOf(new Date(e.ts).toISOString().slice(0, 7)); if (i >= 0) vals[i] += e.v; }
    return { labels, vals };
  })();
  // all time: dense daily since first event so idle days show as dips, not skipped
  const firstTs = evs.length ? Math.min(...evs.map((e) => e.ts)) : nowMs;
  const allDays = Math.max(2, Math.floor((Math.floor(nowMs / DAY) * DAY - Math.floor(firstTs / DAY) * DAY) / DAY) + 1);
  const RANGES = {
    hourly: { ...bucketed(hourStart, HOUR, 48, fmtHour), sub: "tokens · last 48 hours" },
    daily: { ...bucketed(dayStart, DAY, 30, humanDay), sub: "tokens · last 30 days" },
    monthly: { ...monthly, sub: "tokens · last 12 months" },
    all: { ...bucketed(Math.floor(firstTs / DAY) * DAY, DAY, allDays, humanDay), sub: "lifetime tokens" },
  };
  const avail = b.session_to_spend, weekLeft = b.weekly_left_tokens;
  const refillMin = b.five_reset_in_sec != null ? Math.round(b.five_reset_in_sec / 60) : null;
  // honesty: a stale anchor means "last known", not "available right now"; tiny anchors (<5%)
  // mean the cap estimate is still calibrating (integer-% reports → big relative error).
  const refillTxt = !b.fresh
    ? ` · last anchored ${b.anchor_age_sec != null ? Math.round(b.anchor_age_sec / 3600) + "h" : "?"} ago — stale`
    : refillMin != null ? ` · window refills in ${Math.floor(refillMin / 60)}h ${refillMin % 60}m` : "";
  const calibTxt = b.week != null && b.week < 0.05 ? " · calibrating" : "";
  // badge: "live" only when data actually flows; a retired handle says so
  const lastEvt = s.events.reduce((a, e) => (e.ts > a ? e.ts : a), 0);
  const idleDays = lastEvt ? (Date.now() / 1000 - lastEvt) / 86400 : Infinity;
  const badge = idleDays < 2 ? "✓ Verified usage · live" : `✓ Verified usage · idle ${Math.round(idleDays)}d`;
  // where it burns: lifetime split by surface class (public — classes and magnitudes only)
  const bySurf = new Map();
  for (const e of s.events) { const k = String(e.surface || "unknown").split(":")[0]; bySurf.set(k, (bySurf.get(k) || 0) + rawOf(e)); }
  const surfSplit = [...bySurf.entries()].sort((a, b2) => b2[1] - a[1])
    .map(([k, v]) => `${k} ${lifetime ? Math.round(v / lifetime * 100) : 0}% (${humanN(v)})`).join(" · ");
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const url = `https://meetmaxx.co/u/${h}`;
  // owner-only setup panel (present when the page was opened with ?k=<secret>)
  const agoTxt = (sec) => sec == null ? "never" : sec < 90 ? `${sec}s ago` : sec < 5400 ? `${Math.round(sec / 60)}m ago` : sec < 172800 ? `${Math.round(sec / 3600)}h ago` : `${Math.round(sec / 86400)}d ago`;
  const setupRow = (ok, label, ago, fix) =>
    `<li><span>${ok ? "✅" : "❌"} <b>${label}</b> <span class="sub">· ${agoTxt(ago)}</span></span>${ok ? "" : `<span class="fix">${fix}</span>`}</li>`;
  const setupHtml = !setup ? "" : `
 <div class="setup"><h3>Setup check <span class="sub">— only you can see this (opened with your secret)</span></h3><ul>
  ${setupRow(setup.cli.ok, "Claude CLI shipping", setup.cli.ago, `run: <code>curl -fsSL https://meetmaxx.co/install | MAXX_HANDLE=${h} MAXX_SECRET=&lt;your-secret&gt; bash</code>`)}
  ${setupRow(setup.connector.ok, "claude.ai connector", setup.connector.ago, `add the connector at <a href="https://claude.ai/settings/connectors" target="_blank" rel="noopener">claude.ai → Connectors</a> (name Maxx, your mcp URL)`)}
  ${setupRow(setup.anchor.ok, "Anchor fresh (/usage)", setup.anchor.ago, `open a Claude Code session on the linked machine — the statusline ships the authoritative %`)}
 </ul></div>`;
  const desc = `${humanN(lifetime)} lifetime Claude tokens · live tally, anchored to Anthropic /usage · verified by Maxx`;
  const shareTxt = `${humanN(lifetime)} lifetime Claude tokens, verified by @meetmaxx`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h} — Verified token usage · Maxx</title>
<meta property="og:title" content="${h} — verified Claude token usage">
<meta property="og:description" content="${desc}">
<meta property="og:url" content="${url}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Maxx">
<meta property="og:image" content="https://meetmaxx.co/og-card.png">
<meta property="og:image:type" content="image/png">
<meta property="og:image:alt" content="Maxx — verified Claude token usage, every machine and cloud session">
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
.top{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:21px}
.brand .m{color:var(--accent);font-size:24px}
.who{font-family:var(--mono);font-size:14px;color:var(--ink-2);font-weight:400}
.badge{display:inline-flex;align-items:center;gap:7px;background:#f0f4ff;color:var(--accent);border:1px solid #dfe5ff;border-radius:999px;padding:7px 16px;font-size:14.5px;font-weight:600}
.hero{margin-top:28px;display:flex;align-items:baseline;gap:18px;flex-wrap:wrap}
.hero .n{font-size:clamp(34px,6vw,76px);font-weight:700;letter-spacing:-.03em;line-height:1;font-variant-numeric:tabular-nums}
.hero .l{color:var(--ink-2);font-size:16.5px}
.ranges{margin-top:18px;display:flex;gap:6px}
.ranges button{border:1px solid var(--line);background:var(--card);color:var(--ink-2);border-radius:999px;padding:5px 14px;font-size:13px;font-weight:600;cursor:pointer;font-family:var(--sans)}
.ranges button.on{background:var(--accent);border-color:var(--accent);color:#fff}
.chart{margin-top:14px;position:relative}
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
.tip{position:absolute;pointer-events:none;display:none;background:var(--ink);color:#fff;font-family:var(--mono);font-size:12.5px;padding:6px 10px;border-radius:8px;white-space:nowrap;transform:translate(-50%,-130%);z-index:2}
.guide{position:absolute;top:0;bottom:24px;width:1px;background:var(--accent);opacity:.4;display:none;pointer-events:none}
.setup{margin-top:16px;border:1px solid #dfe5ff;background:#f7f8ff;border-radius:12px;padding:14px 18px}
.setup h3{font-size:14px;font-weight:700;color:var(--ink)}
.setup ul{list-style:none;margin-top:8px;font-size:14.5px}
.setup li{display:flex;justify-content:space-between;gap:14px;padding:5px 0;flex-wrap:wrap}
.setup .fix{color:var(--ink-2);font-size:13px}
.setup code{font-family:var(--mono);font-size:12px;background:#eef1f6;padding:2px 6px;border-radius:6px}
.feed{margin-top:16px;border-top:1px solid var(--line);padding-top:12px}
.feed h3{font-size:13px;color:var(--ink-3);font-weight:600;letter-spacing:.04em;text-transform:uppercase;display:flex;align-items:center;gap:8px}
.feed h3 .dot{width:7px;height:7px;border-radius:50%;background:#2fbf71;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
.feed ul{list-style:none;margin-top:8px;font-family:var(--mono);font-size:13.5px;color:var(--ink-2)}
.feed li{display:flex;justify-content:space-between;padding:4px 0}
.feed li b{color:var(--ink);font-weight:600}
@media (max-width:640px){.hero .n{font-size:34px}.badge{font-size:12.5px;padding:5px 12px}.peak{display:none}}
</style></head><body>
<div class="card">
 <div class="top">
  <div class="brand"><span class="m">⩗</span> maxx <span class="who">· @${h}</span></div>
  <div class="badge">${badge}</div>
 </div>
 <div class="hero"><div class="n" id="hero">${fmtN(lifetime)}</div><div class="l" id="heroSub">lifetime tokens</div></div>
 <div class="ranges" id="ranges">
  <button data-r="hourly">Hourly</button><button data-r="daily">Daily</button><button data-r="monthly">Monthly</button><button data-r="all" class="on">All time</button>
 </div>
 <div class="chart" id="chart">
  <svg width="100%" viewBox="0 0 1080 150" preserveAspectRatio="none" style="display:block">
   <path id="cArea" d="" fill="#635bff" opacity=".12"/>
   <path id="cLine" d="" fill="none" stroke="#635bff" stroke-width="2"/>
   <g id="cDots"></g>
  </svg>
  <div class="guide" id="guide"></div><div class="tip" id="tip"></div>
  <div class="peak" id="peak" style="display:none"></div>
  <div class="cap"><span id="capL"></span><span>all machines &amp; cloud · this Claude account</span><span id="capR">today</span></div>
 </div>
 <div class="rows">
  <div class="r"><span class="k">Available right now</span><span class="v"><span id="avail">${avail != null ? humanN(avail) : "—"}</span> <span class="sub">${refillTxt}</span></span></div>
  <div class="r"><span class="k">Weekly limit remaining</span><span class="v">${weekLeft != null ? humanN(weekLeft) : "—"} <span class="sub">· ${b.week != null ? Math.round(b.week * 100) + "% used ·" : ""} quota units${b.week_reset_in_sec != null ? " · resets in " + Math.round(b.week_reset_in_sec / 3600) + "h" : ""}${calibTxt}</span></span></div>
 </div>
${setupHtml}
 <div class="feed"><h3><span class="dot"></span> live feed</h3><ul id="feed"><li><span class="sub">listening…</span></li></ul></div>
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
// range toggle + chart: draw the selected series client-side (hourly/daily/monthly/all time)
(function(){
  var R=${JSON.stringify(Object.fromEntries(Object.entries(RANGES).map(([k, r]) => [k, { labels: r.labels, vals: r.vals.map((v) => Math.round(v)), sub: r.sub }])))};
  var LIFE=${Math.round(lifetime)};
  var cur='all',labels=[],vals=[];
  var hum=function(n){return n>=1e9?(n/1e9).toFixed(1)+'B':n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(1)+'K':''+n};
  var W=1080,H=150;
  function draw(key){
    cur=key;var r=R[key];labels=r.labels;vals=r.vals;
    var n=Math.max(2,vals.length),peak=Math.max.apply(null,[1].concat(vals));
    var pts=vals.map(function(v,i){return [(i*W/(n-1)),(H-(v/peak)*(H-6))]});
    var line='M'+pts.map(function(p){return p[0].toFixed(1)+','+p[1].toFixed(1)}).join('L');
    document.getElementById('cLine').setAttribute('d',line);
    document.getElementById('cArea').setAttribute('d',line+'L'+W+','+H+'L0,'+H+'Z');
    document.getElementById('cDots').innerHTML=n<=60?pts.map(function(p){
      return '<circle cx="'+p[0].toFixed(1)+'" cy="'+p[1].toFixed(1)+'" r="2.5" fill="#635bff" stroke="#fff" stroke-width="1"/>'}).join(''):'';
    var pi=vals.indexOf(Math.max.apply(null,vals)),pk=document.getElementById('peak');
    if(vals[pi]>0){pk.style.display='block';pk.style.left=(pi/(n-1)*100).toFixed(1)+'%';pk.style.top='-6px';
      pk.style.transform='translateX(-'+(pi/(n-1)>0.7?105:0)+'%)';pk.textContent='peak '+hum(vals[pi])+' · '+labels[pi];}
    else pk.style.display='none';
    document.getElementById('capL').textContent=labels[0]||'';
    document.getElementById('capR').textContent=key==='hourly'?'now':labels[labels.length-1]||'today';
    var total=vals.reduce(function(a,v){return a+v},0);
    document.getElementById('hero').textContent=(key==='all'?LIFE:total).toLocaleString('en-US');
    document.getElementById('heroSub').textContent=r.sub;
    var bs=document.querySelectorAll('#ranges button');
    for(var i=0;i<bs.length;i++)bs[i].className=bs[i].getAttribute('data-r')===key?'on':'';
  }
  document.getElementById('ranges').addEventListener('click',function(ev){
    var k=ev.target.getAttribute&&ev.target.getAttribute('data-r');if(k)draw(k);
  });
  draw('all');
  // hover: nearest-bucket tooltip + guide line
  var chart=document.getElementById('chart'),tip=document.getElementById('tip'),guide=document.getElementById('guide');
  chart.addEventListener('mousemove',function(ev){
    var r=chart.getBoundingClientRect(),x=ev.clientX-r.left;
    var i=Math.max(0,Math.min(labels.length-1,Math.round(x/r.width*(labels.length-1))));
    var cx=i/(labels.length-1)*r.width;
    tip.style.display='block';tip.style.left=Math.max(60,Math.min(r.width-60,cx))+'px';tip.style.top='34px';
    tip.textContent=labels[i]+' · '+hum(vals[i])+' tokens';
    guide.style.display='block';guide.style.left=cx+'px';
  });
  chart.addEventListener('mouseleave',function(){tip.style.display='none';guide.style.display='none';});
  window.__setLife=function(n){LIFE=n;if(cur==='all')document.getElementById('hero').textContent=Math.round(n).toLocaleString('en-US')};
})();
// live feed: poll the public counts-only endpoint; one row PER CHANNEL (cloud, machine 1, …),
// not per turn — tick the hero odometer + availability in place
(function(){
  var avail=document.getElementById('avail'),feed=document.getElementById('feed');
  var hum=function(n){return n>=1e9?(n/1e9).toFixed(1)+'B':n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(1)+'K':''+n};
  var ago=function(s){return s<60?s+'s':s<3600?Math.round(s/60)+'m':s<86400?Math.round(s/3600)+'h':Math.round(s/86400)+'d'};
  function tick(){
    fetch('/u/${h}/live.json').then(function(r){return r.json()}).then(function(j){
      if(j.lifetime&&window.__setLife)window.__setLife(j.lifetime);
      if(j.available!=null&&avail)avail.textContent=hum(j.available);
      if(j.feed&&j.feed.length)feed.innerHTML=j.feed.slice(0,8).map(function(e){
        return '<li><span>'+e.channel+' · '+ago(e.ago_sec)+' ago</span><b>'+(e.tokens_1h>0?'+'+hum(e.tokens_1h)+' <span class="sub">/1h</span>':'<span class="sub">idle</span>')+'</b></li>';}).join('');
      document.getElementById('stamp').textContent=new Date().toISOString().slice(0,16).replace('T',' ')+' UTC';
    }).catch(function(){});
  }
  tick();setInterval(tick,15000);
})();
setTimeout(function(){location.reload()},300000);
</script>
</body></html>`;
}

// ---- owner dashboard (GET /u/{handle}/dash?k={secret}) ------------------------------------
// "What's running right now, and where is the budget going" — top_burners carry session and
// project NAMES, so this page is owner-only: no valid ?k= → 401, nothing rendered.
// The shell is static; the data comes from the already-authed /api endpoints (budget + feed),
// polled every 10s, so the page and the API can never disagree.
// Unauthenticated dash hit → paste-your-secret form. POSTs the secret in the request
// BODY to /api/u/:h/login (never a URL), gets the HttpOnly cookie back, reloads.
function renderLogin(h) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h} — owner login · Maxx</title>
<meta name="robots" content="noindex">
<link rel="icon" href="https://meetmaxx.co/favicon.svg" type="image/svg+xml">
<style>
:root{--bg:#f6f9fc;--card:#fff;--line:#e6ebf1;--ink:#0a2540;--ink-2:#425466;--ink-3:#8898aa;--accent:#635bff;--sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;--mono:ui-monospace,"SF Mono",Menlo,monospace}
*{box-sizing:border-box;margin:0}
body{background:var(--bg);color:var(--ink);font-family:var(--sans);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.card{width:440px;max-width:100%;background:var(--card);border:1px solid var(--line);border-radius:20px;box-shadow:0 15px 35px rgba(60,66,87,.08),0 5px 15px rgba(0,0,0,.06);padding:36px 40px}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:20px}
.brand .m{color:var(--accent);font-size:23px}
.who{font-family:var(--mono);font-size:14px;color:var(--ink-2);font-weight:400}
p{color:var(--ink-2);font-size:14.5px;margin-top:14px;line-height:1.5}
input{width:100%;margin-top:16px;padding:11px 14px;border:1px solid var(--line);border-radius:10px;font-family:var(--mono);font-size:14px;color:var(--ink)}
input:focus{outline:2px solid var(--accent);border-color:var(--accent)}
button{width:100%;margin-top:12px;padding:11px;border:none;border-radius:10px;background:var(--accent);color:#fff;font-size:15px;font-weight:600;cursor:pointer;font-family:var(--sans)}
.err{color:#c0392b;font-size:13.5px;margin-top:10px;display:none}
.hint{color:var(--ink-3);font-size:12.5px;margin-top:14px}
.hint code{font-family:var(--mono);background:#eef1f6;padding:2px 6px;border-radius:6px;font-size:11.5px}
</style></head><body>
<form class="card" id="f">
 <div class="brand"><span class="m">⩗</span> maxx <span class="who">· @${h} · owner dashboard</span></div>
 <p>Paste your secret to sign in. It's sent once in the request body and stored as an HttpOnly cookie — it never appears in a URL.</p>
 <input id="s" type="password" placeholder="your maxx secret" autocomplete="current-password" autofocus>
 <button>Sign in</button>
 <div class="err" id="err">Wrong secret.</div>
 <div class="hint">On your machine it lives in <code>~/.maxx/config.json</code></div>
</form>
<script>
document.getElementById('f').addEventListener('submit',function(ev){
  ev.preventDefault();
  fetch('/api/u/${h}/login',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({secret:document.getElementById('s').value.trim()})})
  .then(function(r){if(r.ok)location.replace('/u/${h}/dash');else document.getElementById('err').style.display='block';})
  .catch(function(){document.getElementById('err').style.display='block';});
});
</script>
</body></html>`;
}

function renderDash(h) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h} — owner dashboard · Maxx</title>
<meta name="robots" content="noindex">
<link rel="icon" href="https://meetmaxx.co/favicon.svg" type="image/svg+xml">
<style>
:root{--bg:#f6f9fc;--card:#fff;--line:#e6ebf1;--ink:#0a2540;--ink-2:#425466;--ink-3:#8898aa;--accent:#635bff;--sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;--mono:ui-monospace,"SF Mono",Menlo,monospace}
*{box-sizing:border-box;margin:0}
body{background:var(--bg);color:var(--ink);font-family:var(--sans);min-height:100vh;padding:24px;display:flex;flex-direction:column;align-items:center;gap:14px}
.card{width:1100px;max-width:100%;background:var(--card);border:1px solid var(--line);border-radius:20px;box-shadow:0 15px 35px rgba(60,66,87,.08),0 5px 15px rgba(0,0,0,.06);padding:36px 44px}
.top{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:20px}
.brand .m{color:var(--accent);font-size:23px}
.who{font-family:var(--mono);font-size:14px;color:var(--ink-2);font-weight:400}
.badge{display:inline-flex;align-items:center;gap:7px;border-radius:999px;padding:6px 14px;font-size:14px;font-weight:600;background:#f0f4ff;color:var(--accent);border:1px solid #dfe5ff}
.badge.over{background:#fff1f0;color:#c0392b;border-color:#f5c6c2}
.badge.stale{background:#fff8e6;color:#9a6b00;border-color:#f0e0b0}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-top:22px}
.stat{border:1px solid var(--line);border-radius:12px;padding:12px 16px}
.stat .k{color:var(--ink-3);font-size:12.5px;text-transform:uppercase;letter-spacing:.04em;font-weight:600}
.stat .v{font-size:24px;font-weight:700;font-variant-numeric:tabular-nums;margin-top:4px}
.stat .sub{color:var(--ink-3);font-size:12.5px;margin-top:2px}
h2{font-size:13px;color:var(--ink-3);font-weight:600;letter-spacing:.04em;text-transform:uppercase;margin-top:26px;display:flex;align-items:center;gap:8px}
h2 .dot{width:7px;height:7px;border-radius:50%;background:#2fbf71;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
table{width:100%;border-collapse:collapse;margin-top:8px;font-size:14.5px}
th{text-align:left;color:var(--ink-3);font-size:12px;text-transform:uppercase;letter-spacing:.04em;font-weight:600;padding:6px 10px;border-bottom:1px solid var(--line)}
td{padding:8px 10px;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums}
td.mono{font-family:var(--mono);font-size:13px;color:var(--ink-2)}
td.num,th.num{text-align:right}
td b{font-weight:600}
.empty{color:var(--ink-3);padding:10px;font-size:14px}
.foot{margin-top:20px;color:var(--ink-3);font-size:13px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px}
.foot a{color:var(--accent);font-weight:600;text-decoration:none}
</style></head><body>
<div class="card">
 <div class="top">
  <div class="brand"><span class="m">⩗</span> maxx <span class="who">· @${h} · owner dashboard</span></div>
  <div class="badge" id="verdict">loading…</div>
 </div>
 <div class="stats" id="stats"></div>
 <h2><span class="dot"></span> Agents right now <span style="text-transform:none;letter-spacing:0;font-weight:400">— heaviest sessions, last hour</span></h2>
 <table><thead><tr><th>Session</th><th>Surface</th><th class="num">Tokens 1h</th><th class="num">Rate 5m</th><th class="num">Ctx</th><th class="num">Cost/action</th></tr></thead>
 <tbody id="agents"><tr><td colspan="6" class="empty">loading…</td></tr></tbody></table>
 <h2>Channels <span style="text-transform:none;letter-spacing:0;font-weight:400">— per machine / cloud, not per turn</span></h2>
 <table><thead><tr><th>Channel</th><th>Last update</th><th class="num">+1h</th><th class="num">Billed 5h</th><th style="width:35%"></th></tr></thead>
 <tbody id="channels"><tr><td colspan="5" class="empty">loading…</td></tr></tbody></table>
 <div class="foot">
  <span>Owner-only — session and project names never appear on the public card · <span id="stamp"></span></span>
  <a href="/u/${h}">public card →</a>
 </div>
</div>
<script>
// scrub one-time tokens / legacy secrets out of the address bar AND this history entry
if(location.search)history.replaceState(null,'',location.pathname);
(function(){
  var esc=function(s){var d=document.createElement('span');d.textContent=s==null?'':String(s);return d.innerHTML};
  var hum=function(n){return n==null?'—':n>=1e9?(n/1e9).toFixed(1)+'B':n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(1)+'K':''+Math.round(n)};
  var ago=function(s){return s<60?Math.round(s)+'s':s<3600?Math.round(s/60)+'m':s<86400?Math.round(s/3600)+'h':Math.round(s/86400)+'d'};
  var stat=function(k,v,sub){return '<div class="stat"><div class="k">'+k+'</div><div class="v">'+v+'</div>'+(sub?'<div class="sub">'+sub+'</div>':'')+'</div>'};
  function tick(){
    fetch('/api/u/${h}/budget').then(function(r){return r.json()}).then(function(b){
      var vd=document.getElementById('verdict');
      vd.textContent=b.verdict==='ok'?'✓ verdict ok':b.verdict;
      vd.className='badge'+(b.verdict==='ok'?'':' '+esc(b.verdict));
      var refill=b.five_reset_in_sec!=null?'refills in '+ago(b.five_reset_in_sec):'';
      document.getElementById('stats').innerHTML=
        stat('Available now',hum(b.session_to_spend),refill)+
        stat('Weekly left',hum(b.weekly_left_tokens),b.week!=null?Math.round(b.week*100)+'% used · resets in '+(b.week_reset_in_sec!=null?ago(b.week_reset_in_sec):'?'):'')+
        stat('Burn 5m',hum(b.burn_5m),b.empties_at?'empties in '+ago(b.empties_at-Date.now()/1000):'')+
        stat('Reserved',hum(b.reserved_tokens),(b.leases||0)+' lease'+(b.leases===1?'':'s'));
      var ag=(b.top_burners||[]).filter(function(a){return a.tokens_1h>0});
      document.getElementById('agents').innerHTML=ag.length?ag.map(function(a){
        return '<tr><td><b>'+esc(a.name||a.project||(a.session||'').slice(0,8))+'</b>'+(a.project&&a.name?' <span class="mono">'+esc(a.project)+'</span>':'')+'</td>'+
          '<td class="mono">'+esc(a.surface)+'</td><td class="num">'+hum(a.tokens_1h)+'</td>'+
          '<td class="num">'+(a.rate_5m>0?'<b>'+hum(a.rate_5m)+'</b>':'idle')+'</td>'+
          '<td class="num">'+(a.ctx?hum(a.ctx):'—')+'</td>'+
          '<td class="num">'+(a.cost_per_action?hum(a.cost_per_action):'—')+'</td></tr>';
      }).join(''):'<tr><td colspan="6" class="empty">nothing burning in the last hour</td></tr>';
      window.__sf=b.surfaces||[];renderChannels();
      document.getElementById('stamp').textContent=new Date().toISOString().slice(0,16).replace('T',' ')+' UTC';
    }).catch(function(){});
    fetch('/api/u/${h}/feed?n=100').then(function(r){return r.json()}).then(function(j){
      window.__ev=(j.events||[]).filter(function(e){return e.billed>0&&e.surface!=='directive'});
      renderChannels();
    }).catch(function(){});
  }
  // channels = budget.surfaces (billed this 5h window) merged with the feed (last-seen + 1h burn),
  // keyed by full surface id — one row per machine / cloud routine, never per turn
  function renderChannels(){
    var sf=window.__sf||[],ev=window.__ev||[],t=Date.now()/1000;
    var by={};
    sf.forEach(function(s){by[s.surface]={surface:s.surface,b5:s.billed_5h,last:0,h1:0}});
    ev.forEach(function(e){
      var c=by[e.surface]||(by[e.surface]={surface:e.surface,b5:0,last:0,h1:0});
      var ts=new Date(e.ts).getTime()/1000;
      if(ts>c.last)c.last=ts;
      if(ts>t-3600)c.h1+=e.billed;
    });
    var rows=Object.keys(by).map(function(k){return by[k]}).sort(function(a,b2){return b2.b5-a.b5});
    var max=Math.max.apply(null,[1].concat(rows.map(function(c){return c.b5})));
    document.getElementById('channels').innerHTML=rows.length?rows.map(function(c){
      return '<tr><td class="mono">'+esc(c.surface)+'</td>'+
        '<td>'+(c.last?ago(Math.max(0,t-c.last))+' ago':'—')+'</td>'+
        '<td class="num">'+(c.h1>0?'<b>+'+hum(c.h1)+'</b>':'idle')+'</td>'+
        '<td class="num">'+hum(c.b5)+'</td>'+
        '<td><div style="height:8px;border-radius:4px;background:#635bff;opacity:.7;width:'+Math.max(2,Math.round(c.b5/max*100))+'%"></div></td></tr>';
    }).join(''):'<tr><td colspan="5" class="empty">no channels yet</td></tr>';
  }
  tick();setInterval(tick,10000);
})();
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
  // Browser auth: HttpOnly cookie set by POST /api/u/:h/login, so the secret never
  // has to appear in a URL (history, logs, screenshots). Honored for GET READS ONLY
  // — mutating endpoints stay bearer/?k=, which closes the CSRF door (SameSite=Lax
  // is the backstop). The cookie carries the secret itself: single owner per handle,
  // stateless, nothing server-side to expire.
  const cookieK = (headers) => {
    const m = /(?:^|;\s*)maxx_k=([^;]+)/.exec(headers.cookie || headers.Cookie || "");
    return m ? decodeURIComponent(m[1]) : "";
  };
  const readTokenOf = (headers, url) => tokenOf(headers, url) || cookieK(headers);
  const setCookie = (v) => `maxx_k=${encodeURIComponent(v)}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`;
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
    const mc = p.match(/^\/u\/([a-z0-9][a-z0-9_-]{2,31})(\/live\.json)?\/?$/);
    if (mc && method === "GET") {
      const h = mc[1];
      const s = await store.load(h);
      if (!s.events.length) return mc[2]
        ? json(404, { error: "no data" })
        : { status: 404, headers: { "content-type": "text/html" }, body: `<!doctype html><meta charset="utf-8"><title>maxx</title><p style="font-family:sans-serif;padding:40px">No usage for <b>@${h}</b> yet — <a href="https://meetmaxx.co">claim your handle</a>.</p>` };
      const budget = computeBudget(s, now());
      // live.json — PUBLIC, counts-only poll target for the card's live feed: lifetime odometer,
      // availability, and the last events as {ago_sec, surface CLASS, tokens}. Never session/project
      // names here — those stay behind auth; the public card leaks no content, only magnitudes.
      if (mc[2]) {
        const t = now();
        // real burn only: zero-ts / zero-token / directive rows are bookkeeping, not usage
        // (legacy events surfaced as "cloud · 20655d ago +0" — epoch-0 timestamps).
        // One row PER CHANNEL (a stable surface id = one machine / one cloud routine), not per
        // turn. Labels are anonymized by first-seen order ("machine 1", "cloud 1") — real surface
        // ids stay behind auth; the public card leaks no content, only magnitudes.
        const real = s.events.filter((e) => e.ts > 0 && (e.raw || e.billed) > 0 && e.surface !== "directive");
        const chans = new Map(); // surface → rollup, insertion order = first-seen order
        let mi = 0, ci = 0;
        for (const e of real) {
          let c = chans.get(e.surface);
          if (!c) {
            const cls = String(e.surface || "").split(":")[0];
            c = { channel: cls === "cloud" ? `cloud ${++ci}` : `machine ${++mi}`, last: 0, h1: 0 };
            chans.set(e.surface, c);
          }
          if (e.ts > c.last) c.last = e.ts;
          if (e.ts > t - 3600) c.h1 += e.raw || e.billed;
        }
        const feed = [...chans.values()].sort((a, b2) => b2.last - a.last)
          .map((c) => ({ channel: c.channel, ago_sec: Math.max(0, Math.round(t - c.last)), tokens_1h: c.h1 }));
        const lifetime = s.events.reduce((a, e) => a + (e.raw || e.billed || 0), 0);
        return { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" },
          body: JSON.stringify({ lifetime, available: budget.session_to_spend, burn_5m: budget.burn_5m, feed }) };
      }
      // owner view: /u/{h}?k={secret} adds the private setup-check panel — "is my install right?"
      // Three signals, each with its fix: CLI shipping (laptop events), connector connected (authed
      // mcp ping), anchor fresh (an interactive session saw /usage recently).
      let setup = null;
      const tok = readTokenOf(headers, url);
      if (tok && (await authed(h, tok))) {
        const t = now();
        const lastOf = (pfx) => s.events.reduce((a, e) => (String(e.surface || "").startsWith(pfx) && e.ts > a ? e.ts : a), 0);
        const lastLaptop = lastOf("laptop"), lastCloud = Math.max(s.mcp_seen || 0, lastOf("cloud"));
        setup = {
          cli: { ok: t - lastLaptop < 1800, ago: lastLaptop ? Math.round(t - lastLaptop) : null },
          connector: { ok: t - lastCloud < 7 * 86400, ago: lastCloud ? Math.round(t - lastCloud) : null },
          anchor: { ok: budget.fresh, ago: budget.anchor_age_sec },
        };
      }
      return { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": setup ? "no-store" : "public, max-age=60" }, body: renderCard(h, s, budget, setup) };
    }

    // ---- owner dashboard: GET /u/{handle}/dash?k={secret}. Session/project NAMES render here,
    // so unlike the public card this is auth-required — no valid secret, no page.
    const md = p.match(/^\/u\/([a-z0-9][a-z0-9_-]{2,31})\/dash\/?$/);
    if (md && method === "GET") {
      const h = md[1];
      // magic link (?m=): single-use, short-TTL token minted by POST /api/u/:h/magic.
      // Consume it → set the auth cookie → clean redirect. Being one-shot makes the
      // URL harmless in history/logs the moment it's used.
      // NO server-side redirects here: the Netlify proxy re-appends the original query
      // string to Location headers, which turns a strip-the-token redirect into a loop.
      // Instead: serve the dash directly with Set-Cookie, and the page itself cleans the
      // address bar via history.replaceState — the token/secret URL never even survives
      // as a history entry.
      const dashPage = (cookieVal) => ({
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...(cookieVal ? { "set-cookie": setCookie(cookieVal) } : {}) },
        body: renderDash(h),
      });
      const mtok = url.searchParams.get("m");
      if (mtok) {
        const s = await store.load(h);
        const t = now();
        const live = (s.magic || []).filter((x) => x.exp > t);
        const hit = live.find((x) => x.t === mtok);
        s.magic = live.filter((x) => x !== hit);
        await store.save(h, s);
        if (hit) {
          const want = (await store.getSecret?.(h)) || (await secretFor(h)) || fallbackSecret;
          return dashPage(want);
        } // invalid/expired → fall through to cookie check / login form
      }
      const tok = readTokenOf(headers, url);
      if (!tok || !(await authed(h, tok)))
        return { status: 401, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }, body: renderLogin(h) };
      // legacy ?k= link: convert the secret to the cookie; replaceState scrubs it client-side
      const qk = url.searchParams.get("k");
      return dashPage(qk || null);
    }

    // ---- magic link mint: CLI (holding the secret as bearer) asks for a one-time
    // sign-in URL — single-use, 120s TTL, opens the dash with zero copy-paste.
    const mg = p.match(/^\/api\/u\/([^/]+)\/magic$/);
    if (mg && method === "POST") {
      const h = decodeURIComponent(mg[1]);
      if (!(await authed(h, tokenOf(headers, url)))) return json(401, { error: "unauthorized" }); // bearer/?k= only, never cookie
      const s = await store.load(h);
      const t = now();
      const tok = randomBytes(16).toString("base64url");
      s.magic = [...(s.magic || []).filter((x) => x.exp > t), { t: tok, exp: Math.round(t + 120) }].slice(-5);
      await store.save(h, s);
      const host = headers["x-forwarded-host"] || headers.host || "api.meetmaxx.co";
      // hand back the public-site URL when minted against the api host — same page, prettier link
      const site = host === "api.meetmaxx.co" ? "meetmaxx.co" : host;
      return json(200, { url: `https://${site}/u/${h}/dash?m=${tok}`, expires_in_sec: 120 });
    }

    // ---- browser login: secret arrives in the BODY, leaves as an HttpOnly cookie ----
    const ml = p.match(/^\/api\/u\/([^/]+)\/login$/);
    if (ml && method === "POST") {
      const h = decodeURIComponent(ml[1]);
      let b; try { b = JSON.parse(body || "{}"); } catch { return json(400, { error: "bad json" }); }
      const secret = String(b.secret || "");
      if (!secret || !(await authed(h, secret))) return json(401, { error: "wrong secret" });
      return { status: 200, headers: { "content-type": "application/json", "set-cookie": setCookie(secret) }, body: JSON.stringify({ ok: true }) };
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
      // cookie accepted: GET read, powers the owner dashboard
      if (!(await authed(h, readTokenOf(headers, url)))) return json(401, { error: "unauthorized" });
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
      // cookie accepted: GET read, powers the owner dashboard
      if (!(await authed(h, readTokenOf(headers, url)))) return json(401, { error: "unauthorized" });
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
      // Setup-check heartbeat: claude.ai pings initialize the moment the connector is added, and
      // every session opens with one — so an AUTHED mcp hit is proof "the connector looks correct".
      // Stamped only when the token matches (an unauthenticated ping proves nothing).
      {
        const hh = url.searchParams.get("handle");
        if (hh && (rm === "initialize" || rm === "tools/call") && (await authed(hh, tokenOf(headers, url)))) {
          try { const sh = await store.load(hh); sh.mcp_seen = now(); await store.save(hh, sh); } catch {}
        }
      }
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
