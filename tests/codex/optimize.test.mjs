import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  analyzeSession,
  formatOptimization,
  newestSession,
  readSessionSeries,
} from "../../plugins/maxx/skills/usage/scripts/optimize.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SESSION = path.join(HERE, "fixtures/home/sessions/2026/07/10/session-a.jsonl");

test("optimizer reads only Codex token metadata", async () => {
  const parsed = await readSessionSeries(SESSION);
  assert.equal(parsed.events.length, 2);
  assert.equal(JSON.stringify(parsed).includes("SECRET"), false);
  const report = analyzeSession(parsed);
  assert.equal(report.totals.tokens, 370);
  assert.equal(report.totals.input, 300);
  assert.equal(report.totals.cachedInput, 140);
  assert.equal(report.totals.output, 70);
  assert.equal(report.cacheHitRate, 0.4667);
});

test("optimizer selects the newest rollout for the invoking workspace", async () => {
  const sessions = path.join(HERE, "fixtures/home/sessions");
  assert.equal(await newestSession(sessions, "/projects/a"), SESSION);
  assert.match(await newestSession(sessions, "/projects/b"), /session-b\.jsonl$/);
  assert.equal(await newestSession(sessions, "/projects/new"), null);
});

test("optimizer does not double-count cache or reasoning subsets", () => {
  const report = analyzeSession({ project: "x", events: [{
    timestamp: 1,
    model: "gpt",
    inputTokens: 100,
    cachedInputTokens: 80,
    outputTokens: 20,
    reasoningOutputTokens: 10,
    totalTokens: 120,
    contextWindow: 1000,
  }] });
  assert.equal(report.totals.tokens, 120);
  assert.equal(report.context.usedPercent, 12);
});

test("optimizer gives context advice without dollar estimates", () => {
  const events = Array.from({ length: 5 }, (_, index) => ({
    timestamp: index * 1000,
    model: "gpt",
    inputTokens: 680 + index * 30,
    cachedInputTokens: 500,
    outputTokens: 20,
    reasoningOutputTokens: 5,
    totalTokens: 700 + index * 30,
    contextWindow: 1000,
  }));
  const report = analyzeSession({ project: "x", events });
  assert.equal(report.context.usedPercent, 82);
  assert.equal(report.recommendations[0].severity, "high");
  const output = formatOptimization(report);
  assert.match(output, /Compact at the next clean boundary/);
  assert.doesNotMatch(output, /\$|cost|spend/);
});
