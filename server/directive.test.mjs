// Directive channel — orchestrator → session commands (pause/clear/resume).
// Pure tally fns with injected time + handler-level REST/MCP round-trips on a
// memory store (no live servers — see HANDOFF gotchas). Run: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyStore, addDirective, pendingDirectives } from "./tally.mjs";
import { createHandler } from "./handler.mjs";
import { createMemoryStore } from "./store.mjs";

const T0 = 1_800_000_000; // fixed epoch seconds

test("pause targets one session; broadcast reaches all; others untouched", () => {
  const s = emptyStore();
  addDirective(s, { session: "aaa", action: "pause", note: "runaway" }, T0);
  assert.equal(pendingDirectives(s, { session: "aaa" }, T0 + 1)[0].note, "runaway");
  assert.equal(pendingDirectives(s, { session: "bbb" }, T0 + 1).length, 0);
  addDirective(s, { session: "*", action: "pause" }, T0 + 2);
  assert.equal(pendingDirectives(s, { session: "bbb" }, T0 + 3).length, 1);
});

test("pause is sticky across reads; clear is one-shot per session", () => {
  const s = emptyStore();
  addDirective(s, { session: "*", action: "pause" }, T0);
  addDirective(s, { session: "*", action: "clear" }, T0);
  assert.deepEqual(pendingDirectives(s, { session: "aaa" }, T0 + 1).map((d) => d.action).sort(), ["clear", "pause"]);
  // second read: pause re-delivered, clear consumed
  assert.deepEqual(pendingDirectives(s, { session: "aaa" }, T0 + 2).map((d) => d.action), ["pause"]);
  // a different session still gets the broadcast clear once
  assert.deepEqual(pendingDirectives(s, { session: "bbb" }, T0 + 3).map((d) => d.action).sort(), ["clear", "pause"]);
});

test("resume lifts a session's pauses; broadcast resume lifts all", () => {
  const s = emptyStore();
  addDirective(s, { session: "aaa", action: "pause" }, T0);
  addDirective(s, { session: "bbb", action: "pause" }, T0);
  const r = addDirective(s, { session: "aaa", action: "resume" }, T0 + 1);
  assert.equal(r.lifted, 1);
  assert.equal(pendingDirectives(s, { session: "aaa" }, T0 + 2).length, 0);
  assert.equal(pendingDirectives(s, { session: "bbb" }, T0 + 2).length, 1);
  assert.equal(addDirective(s, { session: "*", action: "resume" }, T0 + 3).lifted, 1);
});

test("directives expire at ttl; ttl clamped to [60, 86400]", () => {
  const s = emptyStore();
  addDirective(s, { session: "aaa", action: "pause", ttl_sec: 60 }, T0);
  assert.equal(pendingDirectives(s, { session: "aaa" }, T0 + 30).length, 1);
  assert.equal(pendingDirectives(s, { session: "aaa" }, T0 + 61).length, 0);
  const d = addDirective(s, { session: "aaa", action: "pause", ttl_sec: 999_999 }, T0);
  assert.equal(d.expires, T0 + 86400);
});

test("bad input rejected; old store docs without the field tolerated", () => {
  const s = emptyStore();
  assert.equal(addDirective(s, { session: "", action: "pause" }, T0).ok, false);
  assert.equal(addDirective(s, { session: "aaa", action: "reboot" }, T0).ok, false);
  delete s.directives; // pre-directive store doc
  assert.equal(addDirective(s, { session: "aaa", action: "pause" }, T0).ok, true);
  delete s.directives;
  assert.deepEqual(pendingDirectives(s, { session: "aaa" }, T0), []);
});

test("create + delivery audited in the feed as billed:0 events", () => {
  const s = emptyStore();
  addDirective(s, { session: "aaa", action: "pause", note: "hot" }, T0);
  pendingDirectives(s, { session: "aaa" }, T0 + 1);
  const notes = s.events.filter((e) => e.surface === "directive");
  assert.equal(notes.length, 2);
  assert.ok(notes[0].name.includes("pause"));
  assert.ok(notes[1].name.startsWith("✓"));
  assert.ok(notes.every((e) => e.billed === 0));
});

test("handler REST: POST /directive queues, GET /directives consumes, peek does not", async () => {
  let t = T0;
  const h = createHandler({ store: createMemoryStore(), now: () => t });
  const post = await h({
    method: "POST", url: "/api/u/reif/directive", headers: {},
    body: JSON.stringify({ session: "aaa", action: "clear", note: "ctx 300k" }),
  });
  assert.equal(post.status, 200);
  t += 1;
  const peek = await h({ method: "GET", url: "/api/u/reif/directives?session=aaa&peek=1", headers: {} });
  assert.equal(JSON.parse(peek.body).directives.length, 1);
  const read = await h({ method: "GET", url: "/api/u/reif/directives?session=aaa", headers: {} });
  assert.equal(JSON.parse(read.body).directives[0].note, "ctx 300k");
  const again = await h({ method: "GET", url: "/api/u/reif/directives?session=aaa", headers: {} });
  assert.equal(JSON.parse(again.body).directives.length, 0);
  const bad = await h({ method: "POST", url: "/api/u/reif/directive", headers: {}, body: '{"session":"a","action":"nope"}' });
  assert.equal(bad.status, 400);
});

test("handler MCP: maxx_directive listed and callable", async () => {
  const h = createHandler({ store: createMemoryStore(), now: () => T0 });
  const rpc = (method, params = {}) =>
    h({ method: "POST", url: "/mcp?handle=reif", headers: {}, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const list = JSON.parse((await rpc("tools/list")).body);
  assert.ok(list.result.tools.some((x) => x.name === "maxx_directive"));
  const call = JSON.parse((await rpc("tools/call", {
    name: "maxx_directive", arguments: { session: "*", action: "pause", note: "budget hold" },
  })).body);
  const res = JSON.parse(call.result.content[0].text);
  assert.equal(res.ok, true);
  assert.equal(res.action, "pause");
});
