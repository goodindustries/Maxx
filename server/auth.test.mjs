// Cookie login for the owner dashboard — secret in the POST body once, HttpOnly
// cookie after; cookie honored for GET reads only (CSRF: mutations stay bearer).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "./handler.mjs";
import { createMemoryStore } from "./store.mjs";

const SECRET = "shh-owner";
function mkHandler() {
  const store = createMemoryStore();
  const h = createHandler({ store, secretFor: (x) => (x === "testy" ? SECRET : null) });
  return { store, h };
}
const post = (url, body, headers = {}) => ({ method: "POST", url, headers, body: JSON.stringify(body) });
const get = (url, headers = {}) => ({ method: "GET", url, headers });
const cookieOf = (res) => (res.headers["set-cookie"] || "").split(";")[0];

test("login: wrong secret 401, right secret sets HttpOnly cookie", async () => {
  const { h } = mkHandler();
  assert.equal((await h(post("/api/u/testy/login", { secret: "nope" }))).status, 401);
  const ok = await h(post("/api/u/testy/login", { secret: SECRET }));
  assert.equal(ok.status, 200);
  assert.match(ok.headers["set-cookie"], /^maxx_k=/);
  assert.match(ok.headers["set-cookie"], /HttpOnly/);
  assert.match(ok.headers["set-cookie"], /SameSite=Lax/);
});

test("dash: no auth → login form; cookie → dashboard; ?k= → cookie + clean redirect", async () => {
  const { h } = mkHandler();
  const anon = await h(get("/u/testy/dash"));
  assert.equal(anon.status, 401);
  assert.match(anon.body, /Paste your secret/);
  const cookie = cookieOf(await h(post("/api/u/testy/login", { secret: SECRET })));
  const dash = await h(get("/u/testy/dash", { cookie }));
  assert.equal(dash.status, 200);
  assert.match(dash.body, /owner dashboard/);
  assert.ok(!dash.body.includes(SECRET), "secret must not be embedded in the page");
  // ?k= bridge: dash served directly + cookie set (no redirect — the Netlify proxy
  // re-appends the query string to Location headers, which would loop)
  const bridge = await h(get(`/u/testy/dash?k=${SECRET}`));
  assert.equal(bridge.status, 200);
  assert.match(bridge.body, /owner dashboard/);
  assert.match(bridge.headers["set-cookie"], /^maxx_k=/);
});

test("magic link: bearer-only mint, single-use, expires", async () => {
  let t = 1_800_000_000;
  const store = createMemoryStore();
  const h = createHandler({ store, secretFor: (x) => (x === "testy" ? SECRET : null), now: () => t });
  // a cookie must NOT be able to mint (mint = an action, cookie = reads only)
  const cookie = cookieOf(await h(post("/api/u/testy/login", { secret: SECRET })));
  assert.equal((await h(post("/api/u/testy/magic", {}, { cookie }))).status, 401);
  const mint = await h(post("/api/u/testy/magic", {}, { authorization: `Bearer ${SECRET}` }));
  assert.equal(mint.status, 200);
  const m = new URL(JSON.parse(mint.body).url).searchParams.get("m");
  const first = await h(get(`/u/testy/dash?m=${m}`));
  assert.equal(first.status, 200);
  assert.match(first.body, /owner dashboard/);
  assert.match(first.headers["set-cookie"], /^maxx_k=/);
  // second use: consumed → login form, no cookie
  assert.equal((await h(get(`/u/testy/dash?m=${m}`))).status, 401);
  // expired token → login form
  const mint2 = await h(post("/api/u/testy/magic", {}, { authorization: `Bearer ${SECRET}` }));
  const m2 = new URL(JSON.parse(mint2.body).url).searchParams.get("m");
  t += 200;
  assert.equal((await h(get(`/u/testy/dash?m=${m2}`))).status, 401);
});

test("cookie works for GET reads, never for mutations", async () => {
  const { h } = mkHandler();
  const cookie = cookieOf(await h(post("/api/u/testy/login", { secret: SECRET })));
  assert.equal((await h(get("/api/u/testy/budget", { cookie }))).status, 200);
  assert.equal((await h(get("/api/u/testy/feed", { cookie }))).status, 200);
  assert.equal((await h(get("/api/u/testy/budget"))).status, 401);
  // mutating endpoints must ignore the cookie
  const env = { surface: "laptop:x", sessions: [{ root: "r", billed: 1 }] };
  assert.equal((await h(post("/api/u/testy/logs", env, { cookie }))).status, 401);
  assert.equal((await h(post("/api/u/testy/directive", { session: "*", action: "pause" }, { cookie }))).status, 401);
  assert.equal((await h(post("/api/u/testy/logs", env, { cookie, authorization: `Bearer ${SECRET}` }))).status, 200);
});

test("settings mutations: cookie + same-origin Origin ok; cross-origin/no-Origin denied", async () => {
  const { h } = mkHandler();
  const cookie = cookieOf(await h(post("/api/u/testy/login", { secret: SECRET })));
  const same = { cookie, origin: "https://api.meetmaxx.co", host: "api.meetmaxx.co" };
  const dir = { session: "*", action: "pause" };
  assert.equal((await h(post("/api/u/testy/directive", dir, same))).status, 200);
  assert.equal((await h(post("/api/u/testy/config", { runaway_min: 5 }, same))).status, 200);
  assert.equal((await h(post("/api/u/testy/directive", dir, { cookie, origin: "https://evil.example", host: "api.meetmaxx.co" }))).status, 401);
  assert.equal((await h(post("/api/u/testy/directive", dir, { cookie, host: "api.meetmaxx.co" }))).status, 401);
  // settings page: auth-gated like the dash
  assert.equal((await h(get("/u/testy/settings"))).status, 401);
  const page = await h(get("/u/testy/settings", { cookie }));
  assert.equal(page.status, 200);
  assert.match(page.body, /Fleet control/);
});

test("ops ring: auth + mcp + directives land in /ops, capped and owner-only", async () => {
  const { h } = mkHandler();
  await h(post("/api/u/testy/login", { secret: "wrong" }));
  const cookie = cookieOf(await h(post("/api/u/testy/login", { secret: SECRET })));
  await h(post("/api/u/testy/directive", { session: "*", action: "pause" }, { cookie, origin: "https://api.meetmaxx.co", host: "api.meetmaxx.co" }));
  assert.equal((await h(get("/api/u/testy/ops"))).status, 401);
  const r = await h(get("/api/u/testy/ops", { cookie }));
  assert.equal(r.status, 200);
  const ops = JSON.parse(r.body).ops.map((o) => `${o.op}:${o.d}`);
  assert.ok(ops.some((o) => o.startsWith("auth:login:FAILED")), "failed login logged");
  assert.ok(ops.some((o) => o.startsWith("directive:pause")), "directive logged");
});
