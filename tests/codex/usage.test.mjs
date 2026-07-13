import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildUsagePayload,
  collectUsage,
  formatUsageCard,
  normalizeAccountRateLimits,
  readAccountUsage,
} from "../../plugins/maxx/skills/usage/scripts/usage.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_HOME = path.join(HERE, "fixtures", "home");

const local = {
  totals: { tokens: 500 },
  cacheHitRate: 0.5,
  sessions: 2,
  turns: 3,
  streak: 3,
  longestStreak: 7,
  currentContext: { usedTokens: 250, windowTokens: 1000, usedPercent: 25 },
  rateLimits: null,
};

test("normalizes dynamic app-server rate-limit windows", () => {
  const normalized = normalizeAccountRateLimits({
    limitId: "codex",
    planType: "pro",
    primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 2_000_000_000 },
    secondary: { usedPercent: 4, windowDurationMins: 10_080, resetsAt: 2_000_100_000 },
    credits: { hasCredits: true, unlimited: false, balance: "8" },
  }, "2026-01-01T00:00:00.000Z");
  assert.equal(normalized.primary.windowMinutes, 300);
  assert.equal(normalized.primary.remainingPercent, 80);
  assert.equal(normalized.secondary.windowMinutes, 10_080);
  assert.deepEqual(normalized.credits, { hasCredits: true, unlimited: false, balance: "8" });
});

test("normalizers treat placeholder windows as unknown and clamp percentages", () => {
  const normalized = normalizeAccountRateLimits({
    primary: { usedPercent: 130, windowDurationMins: 0, resetsAt: 0 },
    secondary: { usedPercent: -10, windowDurationMins: -1, resetsAt: -1 },
  });
  assert.deepEqual(normalized.primary, {
    usedPercent: 100,
    remainingPercent: 0,
    windowMinutes: null,
    resetsAt: null,
    resetsAtIso: null,
  });
  assert.equal(normalized.secondary.usedPercent, 0);
  assert.equal(normalized.secondary.windowMinutes, null);
  assert.equal(normalized.secondary.resetsAt, null);
});

test("app-server adapter performs the required handshake and ignores notifications", async () => {
  const fake = String.raw`
    const rl = require('node:readline').createInterface({ input: process.stdin });
    let ready = false;
    rl.on('line', (line) => {
      const m = JSON.parse(line);
      if (m.method === 'initialize') {
        if (m.params?.clientInfo?.name !== 'maxx' || !m.params?.clientInfo?.version) process.exit(9);
        process.stdout.write(JSON.stringify({ method: 'remoteControl/status/changed', params: {} }) + '\n');
        process.stdout.write(JSON.stringify({ id: 0, result: { codexHome: '/tmp' } }) + '\n');
      } else if (m.method === 'initialized') ready = true;
      else if (ready && m.method === 'account/rateLimits/read') {
        process.stdout.write(JSON.stringify({ id: 1, result: { rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 2000000000 }, secondary: null } } }) + '\n');
      } else if (ready && m.method === 'account/usage/read') {
        process.stdout.write(JSON.stringify({ id: 2, result: { summary: { lifetimeTokens: 1234, currentStreakDays: 2, longestStreakDays: 5 }, dailyUsageBuckets: [] } }) + '\n');
      }
    });
  `;
  const live = await readAccountUsage({ command: process.execPath, args: ["-e", fake], timeoutMs: 2000 });
  assert.equal(live.account.summary.lifetimeTokens, 1234);
  assert.equal(live.rateLimits.rateLimits.primary.usedPercent, 12);
});

test("payload prefers live limits and account totals", () => {
  const live = {
    account: { summary: { lifetimeTokens: 1_234, peakDailyTokens: 400, currentStreakDays: 2, longestStreakDays: 5 }, dailyUsageBuckets: [] },
    rateLimits: { rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 2_000_000_000 }, secondary: null } },
  };
  const payload = buildUsagePayload(local, live);
  assert.equal(payload.live.available, true);
  assert.equal(payload.rateLimits.primary.usedPercent, 12);
  const card = formatUsageCard(payload, 1_999_999_000_000);
  assert.match(card, /1\.2K  \(Codex account\)/);
  assert.match(card, /primary\s+██░+/);
  assert.match(card, /12% used · 5h/);
});

test("payload falls back to local data without inventing limits", () => {
  const payload = buildUsagePayload(local, null, new Error("method unavailable"));
  assert.equal(payload.live.available, false);
  assert.equal(payload.rateLimits, null);
  const card = formatUsageCard(payload);
  assert.match(card, /primary\s+unavailable/);
  assert.match(card, /500  \(local rollouts\)/);
  assert.match(card, /streak\s+3d\s+\(longest 7d\)/);
  assert.match(card, /try \/usage/);
});

test("zero-valued account history falls back to observed local history", () => {
  const payload = buildUsagePayload(local, {
    account: { summary: { lifetimeTokens: 0, currentStreakDays: 0, longestStreakDays: 0 }, dailyUsageBuckets: [] },
    rateLimits: { rateLimits: { primary: { usedPercent: 2, windowDurationMins: 10_080, resetsAt: 2_000_000_000 } } },
  });
  const card = formatUsageCard(payload);
  assert.match(card, /500  \(local rollouts\)/);
  assert.match(card, /streak\s+3d/);
});

test("history cache is keyed by the resolved sessions directory", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "maxx-cache-"));
  const cachePath = path.join(dir, "cache.json");
  const missingCommand = path.join(dir, "no-such-codex");
  const first = await collectUsage({
    codexHome: FIXTURE_HOME,
    cachePath,
    account: { command: missingCommand, timeoutMs: 100 },
  });
  assert.equal(first.local.totals.tokens, 500);
  assert.equal(JSON.parse(readFileSync(cachePath, "utf8")).sessionRoot, path.resolve(FIXTURE_HOME, "sessions"));

  const emptySessions = path.join(dir, "different-sessions");
  const second = await collectUsage({
    codexHome: FIXTURE_HOME,
    sessionsDir: emptySessions,
    cachePath,
    account: { command: missingCommand, timeoutMs: 100 },
  });
  assert.equal(second.local.totals.tokens, 0);
  assert.equal(JSON.parse(readFileSync(cachePath, "utf8")).sessionRoot, path.resolve(emptySessions));
});
