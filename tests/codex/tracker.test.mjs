import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  collectStats,
  findSessionFiles,
  formatCard,
  parseArgs,
  parseSessionFile,
} from "../../plugins/maxx/skills/usage/scripts/tracker.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_HOME = path.join(HERE, "fixtures", "home");
const TRACKER = path.resolve(HERE, "../../plugins/maxx/skills/usage/scripts/tracker.mjs");

test("collectStats aggregates Codex token metadata without double-counting subsets", async () => {
  const stats = await collectStats({ codexHome: FIXTURE_HOME });

  assert.equal(stats.schema, "maxx.codex.stats.v1");
  assert.deepEqual(stats.totals, {
    tokens: 500,
    input: 400,
    cachedInput: 165,
    output: 100,
    reasoningOutput: 22,
  });
  assert.equal(stats.cacheHitRate, 0.4125);
  assert.equal(stats.sessions, 2);
  assert.equal(stats.turns, 3);
  assert.equal(stats.activeDays, 2);
  assert.equal(stats.tokensPerActiveDay, 250);
  assert.equal(stats.longestStreak, 2);
  assert.equal(stats.firstDay, "2026-07-10");
  assert.equal(stats.lastDay, "2026-07-11");

  assert.deepEqual(stats.perDay.map(({ day, tokens, turns }) => ({ day, tokens, turns })), [
    { day: "2026-07-10", tokens: 370, turns: 2 },
    { day: "2026-07-11", tokens: 130, turns: 1 },
  ]);
  assert.deepEqual(stats.models.map(({ model, tokens, turns }) => ({ model, tokens, turns })), [
    { model: "gpt-5.4", tokens: 250, turns: 2 },
    { model: "gpt-5.5", tokens: 250, turns: 1 },
  ]);
});

test("repeated cumulative token notifications are counted once", async () => {
  const stats = await collectStats({ codexHome: FIXTURE_HOME });
  assert.equal(stats.totals.tokens, 500);
  assert.equal(stats.totals.input, 400);
  assert.equal(stats.totals.output, 100);
});

test("exports reusable file discovery and single-session parsing", async () => {
  const sessionsDir = path.join(FIXTURE_HOME, "sessions");
  const files = await findSessionFiles(sessionsDir);
  assert.equal(files.length, 2);
  assert.deepEqual(files, [...files].sort());

  const stats = await parseSessionFile(files[0]);
  assert.equal(stats.sessions, 1);
  assert.equal(stats.turns, 2);
  assert.equal(stats.totals.tokens, 370);
  assert.equal(stats.rateLimits.primary.usedPercent, 30);
});

test("latest event supplies dynamic context and primary/secondary rate limits", async () => {
  const stats = await collectStats({ codexHome: FIXTURE_HOME });

  assert.deepEqual(stats.currentContext, {
    observedAt: "2026-07-11T16:00:20.000Z",
    model: "gpt-5.4",
    usedTokens: 130,
    inputTokens: 100,
    outputTokens: 30,
    windowTokens: 1000,
    usedPercent: 13,
  });
  assert.equal(stats.rateLimits.observedAt, "2026-07-11T16:00:20.000Z");
  assert.equal(stats.rateLimits.limitName, "Codex");
  assert.equal(stats.rateLimits.planType, "team");
  assert.equal(stats.rateLimits.primary.usedPercent, 35);
  assert.equal(stats.rateLimits.primary.windowMinutes, 300);
  assert.equal(stats.rateLimits.secondary.usedPercent, 5);
  assert.equal(stats.rateLimits.secondary.windowMinutes, 1440);
});

test("current context is selected from the invoking workspace", async () => {
  const stats = await collectStats({ codexHome: FIXTURE_HOME, cwd: "/projects/a" });
  assert.equal(stats.currentContext.observedAt, "2026-07-11T00:00:20.000Z");
  assert.equal(stats.currentContext.model, "gpt-5.5");
  assert.equal(stats.currentContext.usedTokens, 250);
  // Account-level rate limits still use the freshest observation globally.
  assert.equal(stats.rateLimits.primary.usedPercent, 35);
});

test("an unknown workspace never inherits another repo's context", async () => {
  const stats = await collectStats({ codexHome: FIXTURE_HOME, cwd: "/projects/new" });
  assert.equal(stats.currentContext, null);
  assert.equal(stats.totals.tokens, 500);
});

test("ignores malformed JSON and all prompt, message, and tool content", async () => {
  const stats = await collectStats({ codexHome: FIXTURE_HOME });
  const serialized = JSON.stringify(stats);

  assert.doesNotMatch(serialized, /SECRET|PROMPT|TOOL/);
  const card = formatCard(stats);
  assert.match(card, /maxx · codex/);
  assert.match(card, /primary\s+35% used · 5h/);
  assert.match(card, /secondary\s+5% used · 1d/);
  assert.doesNotMatch(card, /SECRET|PROMPT|TOOL/);
});

test("missing sessions directory returns a valid empty payload", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "maxx-codex-test-"));
  try {
    const stats = await collectStats({ codexHome: root });
    assert.equal(stats.totals.tokens, 0);
    assert.equal(stats.sessions, 0);
    assert.equal(stats.turns, 0);
    assert.equal(stats.currentContext, null);
    assert.equal(stats.rateLimits, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI supports json, --json, and CODEX_HOME", () => {
  for (const command of ["json", "--json"]) {
    const result = spawnSync(process.execPath, [TRACKER, command], {
      encoding: "utf8",
      env: { ...process.env, CODEX_HOME: FIXTURE_HOME },
    });
    assert.equal(result.status, 0, result.stderr);
    const stats = JSON.parse(result.stdout);
    assert.equal(stats.totals.tokens, 500);
    assert.equal(stats.rateLimits.primary.usedPercent, 35);
  }
  assert.deepEqual(parseArgs(["--json", "--dir", "/tmp/sessions"]), {
    json: true,
    sessionsDir: "/tmp/sessions",
    codexHome: null,
  });
});
