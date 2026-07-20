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

test("five window falls back to rolling when the anchored reset already passed", () => {
  const s = emptyStore();
  s.events.push({ surface: "laptop:a", root: "r1", ts: T - 2 * H, billed: 5e6 });
  s.anchors.push({ ts: T - 6 * H, five_pct: 0.5, week_pct: 0.2, five_reset: T - H, week_reset: T + 3 * 86400 });
  const b = computeBudget(s, T);
  assert.equal(b.five_billed, 5e6); // rolling 5h still sees it
  assert.equal(b.verdict, "stale"); // and an anchor that old is not trusted anyway
});
