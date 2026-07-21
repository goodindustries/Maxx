// The 5h limit is a fixed window (zeroes at five_reset), not a rolling sum — burn
// from before the wall reset must not count against the fresh window.
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyStore, computeBudget } from "./tally.mjs";

const T = 1_800_000_000, H = 3600;

test("five window is anchor-aligned: pre-reset burn does not carry over", () => {
  const s = emptyStore();
  // window started 1h ago (resets in 4h); 100M burned before it, 8M inside it
  s.events.push(
    { surface: "laptop:a", root: "r1", ts: T - 2 * H, billed: 100e6 },
    { surface: "laptop:a", root: "r2", ts: T - 0.5 * H, billed: 8e6 },
  );
  s.anchors.push({ ts: T - 600, five_pct: 0.1, week_pct: 0.2, five_reset: T + 4 * H, week_reset: T + 3 * 86400 });
  const b = computeBudget(s, T);
  assert.equal(b.five_billed, 8e6);
  // cap anchored against the same window: 8M at anchor / 10% = 80M
  assert.ok(Math.abs(b.five_billed / 0.1 - 80e6) < 1e5, `cap sane, got quota=${b.quota}`);
});

test("statusline passthrough: sl numbers become the ruler, extrapolated since anchor", () => {
  const s = emptyStore();
  s.events.push(
    { surface: "laptop:a", root: "r1", ts: T - 2 * H, billed: 50e6 },   // before anchor
    { surface: "laptop:a", root: "r2", ts: T - 100, billed: 2e6 },      // after anchor
  );
  s.anchors.push({
    ts: T - 600, five_pct: 0.1, week_pct: 0.2, five_reset: T + 4 * H, week_reset: T + 3 * 86400,
    sl: { five_used: 8e6, five_cap: 80e6, to_spend: 30e6, week_used: 120e6, week_cap: 1300e6 },
  });
  const b = computeBudget(s, T);
  // five = sl.five_used + billed since anchor (2M), NOT the server's own 52M window sum
  assert.equal(b.five_billed, 10e6);
  assert.equal(b.week_billed, 122e6);
  assert.equal(b.weekly_left_tokens, 1300e6 - 122e6);
  assert.ok(Math.abs(b.week - 122e6 / 1300e6) < 1e-9);
  // the CLI's toSpend governs, minus since-anchor burn: 30M − 2M
  assert.equal(b.session_to_spend, 28e6);
});

test("net_per_min = sustainable weekly pace − recent burn (the pace model)", () => {
  const s = emptyStore();
  const wr = T + 100000; // week resets in 100000s
  s.events.push(
    { surface: "laptop:a", root: "r1", ts: T - 3000, billed: 20e6 },  // in 5h window, not last 5m
    { surface: "laptop:a", root: "r2", ts: T - 100, billed: 1.5e6 },  // last 5m → burn_5m
  );
  s.anchors.push({
    ts: T - 600, five_pct: 0.1, week_pct: 0.2, five_reset: T + 4 * H, week_reset: wr,
    sl: { five_used: 8e6, five_cap: 80e6, to_spend: 30e6, week_used: 100e6, week_cap: 1300e6 },
  });
  const b = computeBudget(s, T);
  assert.equal(b.burn_5m, 1.5e6);
  // sustainable = weekly_left ÷ minutes-to-week-reset; net = sustainable − burn_5m/5
  const sustainable = b.weekly_left_tokens / ((wr - T) / 60);
  assert.equal(b.sustainable_per_min, Math.round(sustainable));
  assert.equal(b.net_per_min, Math.round(sustainable - b.burn_5m / 5));
});

test("session_burst = the hard 5h ceiling (≥ the paced safe-to-spend)", () => {
  const s = emptyStore();
  s.events.push({ surface: "laptop:a", root: "r2", ts: T - 100, billed: 1.5e6 });
  s.anchors.push({
    ts: T - 600, five_pct: 0.1, week_pct: 0.2, five_reset: T + 4 * H, week_reset: T + 3 * 86400,
    sl: { five_used: 8e6, five_cap: 80e6, to_spend: 30e6, week_used: 100e6, week_cap: 1300e6 },
  });
  const b = computeBudget(s, T);
  // five = sl.five_used + since-anchor (1.5M) = 9.5M; burst = five_cap − five = 70.5M
  assert.equal(b.session_burst, 80e6 - 9.5e6);
  // the hard ceiling is never below the weekly-paced safe number
  assert.ok(b.session_burst >= b.session_to_spend, `burst ${b.session_burst} >= safe ${b.session_to_spend}`);
});

test("wall reset since last anchor: only post-reset burn counts, sl session fields ignored", () => {
  const s = emptyStore();
  s.events.push(
    { surface: "laptop:a", root: "r1", ts: T - 2 * H, billed: 50e6 },  // pre-reset (dead window)
    { surface: "laptop:a", root: "r2", ts: T - 600, billed: 3e6 },     // post-reset (new window)
  );
  // anchor 30m old (still FRESH) but its five_reset passed 20m ago
  s.anchors.push({
    ts: T - 1800, five_pct: 0.9, week_pct: 0.2, five_reset: T - 1200, week_reset: T + 3 * 86400,
    sl: { five_used: 70e6, five_cap: 80e6, to_spend: 0, week_used: 120e6, week_cap: 1300e6 },
  });
  const b = computeBudget(s, T);
  assert.equal(b.five_billed, 3e6, "new window counts from the known reset, not the dead window");
  // sl to_spend=0 described the DEAD window — must not gate the fresh one to zero
  assert.ok(b.session_to_spend > 0, `fresh window has allowance, got ${b.session_to_spend}`);
  // week fields still ride the anchor (weekly window survives 5h resets)
  assert.equal(b.week_billed, 120e6 + 3e6);
});
