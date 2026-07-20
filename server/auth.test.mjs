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
  const bridge = await h(get(`/u/testy/dash?k=${SECRET}`));
  assert.equal(bridge.status, 302);
  assert.equal(bridge.headers.location, "/u/testy/dash");
  assert.match(bridge.headers["set-cookie"], /^maxx_k=/);
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
