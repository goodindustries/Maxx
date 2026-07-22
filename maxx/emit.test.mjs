// maxx emit — account cutover: burn from each Claude login root (~/.claude,
// ~/.claude-*) ships to the handle of the account THAT root is signed into, and
// an anchor never calibrates another account's timeline. Run: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EMIT = path.join(HERE, "emit.mjs");

const A = "aaaa1111-0000-0000-0000-000000000001";
const B = "bbbb2222-0000-0000-0000-000000000002";

// A laptop with two logins: default root on account A, ~/.claude-alt on account B.
function makeHome({ accounts } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), "maxx-emit-"));
  const row = (id) => JSON.stringify({
    timestamp: new Date().toISOString(), requestId: id,
    message: { model: "claude-sonnet-5", usage: { input_tokens: 100, output_tokens: 50 } },
  }) + "\n";
  writeFileSync(path.join(home, ".claude.json"),
    JSON.stringify({ oauthAccount: { accountUuid: A, emailAddress: "a@x.com" } }));
  mkdirSync(path.join(home, ".claude", "projects", "-proja"), { recursive: true });
  writeFileSync(path.join(home, ".claude", "projects", "-proja", "s1.jsonl"), row("r1"));
  mkdirSync(path.join(home, ".claude-alt", "projects", "-projb"), { recursive: true });
  writeFileSync(path.join(home, ".claude-alt", ".claude.json"),
    JSON.stringify({ oauthAccount: { accountUuid: B, emailAddress: "b@y.com" } }));
  writeFileSync(path.join(home, ".claude-alt", "projects", "-projb", "s2.jsonl"), row("r2"));
  mkdirSync(path.join(home, ".maxx"), { recursive: true });
  writeFileSync(path.join(home, ".maxx", "config.json"),
    JSON.stringify({ handle: "ha", secret: "sa", logsUrl: "https://example.invalid", accounts }));
  return home;
}

function emitJson(home) {
  const out = execFileSync("node", [EMIT, "--json"], { env: { ...process.env, HOME: home }, encoding: "utf8" });
  return JSON.parse(out.slice(out.indexOf("[")));
}

test("emit: each login root ships to its own account's handle", () => {
  const home = makeHome({ accounts: {
    [A]: { handle: "ha", secret: "sa" },
    [B]: { handle: "hb", secret: "sb" },
  } });
  const envs = emitJson(home);
  const byHandle = Object.fromEntries(envs.map((e) => [e.handle, e]));
  assert.ok(byHandle.ha && byHandle.hb, `expected envelopes for ha AND hb, got ${envs.map((e) => e.handle)}`);
  assert.equal(byHandle.ha.account, A);
  assert.equal(byHandle.hb.account, B);
  assert.equal(byHandle.ha.sessions[0].project, "proja");
  assert.equal(byHandle.hb.sessions[0].project, "projb");
  assert.ok(byHandle.hb.totals.billed > 0);
});

test("emit: an account with no handle is skipped — never poured into the pinned handle", () => {
  const home = makeHome({ accounts: { [A]: { handle: "ha", secret: "sa" } } });
  const envs = emitJson(home);
  assert.equal(envs.length, 1);
  assert.equal(envs[0].handle, "ha");
  assert.ok(envs[0].sessions.every((s) => s.project !== "projb"), "account-B burn leaked into ha's envelope");
});

test("emit: anchor only attaches to the account that observed it", () => {
  const home = makeHome({ accounts: {
    [A]: { handle: "ha", secret: "sa" },
    [B]: { handle: "hb", secret: "sb" },
  } });
  // a guest login's statusline writes SUFFIXED session caches (rl-alt.json); a
  // stale unsuffixed rl.json stamped with a foreign account must protect ha too
  writeFileSync(path.join(home, ".maxx", "rl.json"), JSON.stringify({
    quota: 0.05, week: 0.01, fiveResetAt: 1, weekResetAt: 1, ts: Date.now(), account: B,
  }));
  writeFileSync(path.join(home, ".maxx", "rl-alt.json"), JSON.stringify({
    quota: 0.05, week: 0.01, fiveResetAt: 1, weekResetAt: 1, ts: Date.now(), account: B,
  }));
  const envs = emitJson(home);
  const byHandle = Object.fromEntries(envs.map((e) => [e.handle, e]));
  assert.equal(byHandle.ha.anchor, null, "account B's anchor must not calibrate account A's timeline");
  assert.ok(byHandle.hb.anchor, "the observing account keeps its anchor (from its suffixed rl file)");
  assert.equal(byHandle.hb.anchor.five_pct, 0.05);
});
