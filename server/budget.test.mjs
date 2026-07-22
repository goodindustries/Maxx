// The 5h limit is a fixed window (zeroes at five_reset), not a rolling sum — burn
// from before the wall reset must not count against the fresh window.
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyStore, computeBudget, applyEnvelope } from "./tally.mjs";

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

// A sleeping laptop is the only thing that stops /usage anchors — it must not blind the
// account, because the server owns the full billed ledger and the weekly caps it
// calibrated move on a 7-day window.
test("aged anchor degrades (weekly standing live) instead of going stale", () => {
  const s = emptyStore();
  s.events.push(
    { surface: "laptop:a", root: "r1", ts: T - 5 * H, billed: 40e6 },
    { surface: "cloud:mcloud", root: "r2", ts: T - 600, billed: 2e6 },
  );
  // anchor 3h old — past the 45m trust window, well inside the 12h degrade window
  s.anchors.push({
    ts: T - 3 * H, five_pct: 0.1, week_pct: 0.2, five_reset: T - 2 * H, week_reset: T + 3 * 86400,
    sl: { five_used: 8e6, five_cap: 80e6, to_spend: 30e6, week_used: 120e6, week_cap: 1300e6 },
  });
  const b = computeBudget(s, T);
  assert.equal(b.verdict, "degraded");
  assert.equal(b.fresh, false);
  assert.ok(b.anchor_age_sec >= 3 * H - 1, `anchor age reported, got ${b.anchor_age_sec}`);
  // the weekly numbers callers are told to steer by are real, not null
  assert.ok(b.weekly_left_tokens > 0, `weekly tank readable, got ${b.weekly_left_tokens}`);
  assert.ok(b.session_to_spend > 0, `paced standing readable, got ${b.session_to_spend}`);
});

test("degraded still yields to the weekly wall (over beats degraded)", () => {
  const s = emptyStore();
  // 99%+ of the anchored weekly cap already billed
  s.events.push({ surface: "laptop:a", root: "r1", ts: T - 4 * H, billed: 99e6 });
  s.anchors.push({ ts: T - 3 * H, five_pct: 0.5, week_pct: 0.99, five_reset: T + H, week_reset: T + 86400 });
  assert.equal(computeBudget(s, T).verdict, "over");
});

test("anchor past the degrade window is genuinely blind → stale", () => {
  const s = emptyStore();
  s.events.push({ surface: "laptop:a", root: "r1", ts: T - 600, billed: 2e6 });
  s.anchors.push({ ts: T - 20 * H, five_pct: 0.1, week_pct: 0.2, five_reset: T - 19 * H, week_reset: T + 86400 });
  assert.equal(computeBudget(s, T).verdict, "stale");
});

test("no anchor at all is still stale, never degraded", () => {
  const s = emptyStore();
  s.events.push({ surface: "cloud:mcloud", root: "r1", ts: T - 600, billed: 2e6 });
  assert.equal(computeBudget(s, T).verdict, "stale");
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

// An emit whose sessions carry no first_ts/last_ts, in an envelope with no emitted_at,
// used to store ts: 0. Zero fails every `e.ts > lo` test in windowedBilled, so the spend
// vanished from the 5h and weekly windows while still landing in the lifetime odometer —
// the gate reported MORE headroom than the account actually had. Observed in production:
// surface "cloud:mcloud-dispatch-20260721-1650" billed 8,000,000 at ts 1970-01-01.
test("an emit with no timestamps is stamped at receipt, not dropped into 1970", () => {
  const s = emptyStore();
  applyEnvelope(s, { surface: "cloud:dispatch", cursor: "c1", sessions: [{ root: "r1", billed: 8e6 }] }, T);
  assert.equal(s.events[0].ts, T, "ts falls back to receipt time");
  assert.equal(s.events[0].ts0, T, "ts0 falls back to receipt time");

  // No anchor: five_billed is then the raw ledger window, which is exactly what the
  // ts fallback has to land inside. With the old ts 0 this read 0 — the spend was real
  // but the 5h gate could not see a token of it.
  const b = computeBudget(s, T);
  assert.equal(b.five_billed, 8e6, "the spend is visible to the 5h gate");
  assert.equal(b.lifetime_billed, 8e6, "and is not double-counted in lifetime");
});

// The emit reply is what a chat session shows its human — counts of batches alone
// ("accepted: 1") say nothing. It must echo the billed tokens it just recorded,
// and dedupes must not re-count.
test("applyEnvelope returns the billed sum it accepted", () => {
  const s = emptyStore();
  const r1 = applyEnvelope(s, { surface: "cloud:chat", cursor: "c1", sessions: [{ root: "a", billed: 12000 }, { root: "b", billed: 5000 }] }, T);
  assert.equal(r1.billed, 17000, "sum of accepted sessions");
  const r2 = applyEnvelope(s, { surface: "cloud:chat", cursor: "c1", sessions: [{ root: "a", billed: 12000 }] }, T);
  assert.equal(r2.billed, 0, "deduped batch re-counts nothing");
});

// Garbage timestamps must not poison ts with NaN, which fails every comparison silently.
test("unparseable timestamps fall back to receipt time rather than NaN", () => {
  const s = emptyStore();
  applyEnvelope(s, { surface: "s", cursor: "c", emitted_at: "not-a-date", sessions: [{ root: "r", billed: 1e6, last_ts: "garbage" }] }, T);
  assert.equal(s.events[0].ts, T);
  assert.ok(Number.isFinite(s.events[0].ts0));
});

// STALE means "no signal". It was firing while the server still held a perfectly good
// weekly cap, because the anchor's sl block — which carries that cap — was gated on
// `fresh` (45m). Past 45m the cap was discarded and re-derived from week_pct, and
// week_pct <= 0.005 (early in a week, or just after a wall reset) yields no cap at all,
// so session_to_spend went null and degradable collapsed to stale. A laptop napping a
// couple of hours then stopped the entire cloud fleet.
const SL = { five_used: 40e6, five_cap: 500e6, to_spend: 60e6, over: 0, week_used: 300e6, week_cap: 1500e6, bank: 20e6, net_per_min: 300000 };

test("a 2.7h-old anchor with a tiny week_pct degrades, it does not go stale", () => {
  const s = emptyStore();
  s.events.push({ surface: "laptop:a", root: "r1", ts: T - 3 * H, billed: 5e6 });
  s.anchors.push({ ts: T - 9613, five_pct: 0.001, week_pct: 0.001, five_reset: T + 2 * H, week_reset: T + 3 * 86400, sl: SL });
  const b = computeBudget(s, T);
  assert.equal(b.verdict, "degraded", `expected degraded, got ${b.verdict}`);
  assert.ok(b.weekly_left_tokens > 0, `weekly standing must survive, got ${b.weekly_left_tokens}`);
  assert.ok(b.session_to_spend != null, "session_to_spend must be computable from the weekly wall");
});

test("an anchor older than the 12h degrade window is still stale", () => {
  const s = emptyStore();
  s.anchors.push({ ts: T - 13 * H, five_pct: 0.2, week_pct: 0.3, five_reset: T + 2 * H, week_reset: T + 3 * 86400, sl: SL });
  assert.equal(computeBudget(s, T).verdict, "stale");
});

test("no anchor at all is still stale", () => {
  assert.equal(computeBudget(emptyStore(), T).verdict, "stale");
});

test("a fresh anchor is unaffected and still reads ok", () => {
  const s = emptyStore();
  s.events.push({ surface: "laptop:a", root: "r1", ts: T - 600, billed: 1e6 });
  s.anchors.push({ ts: T - 300, five_pct: 0.1, week_pct: 0.2, five_reset: T + 2 * H, week_reset: T + 3 * 86400, sl: SL });
  const b = computeBudget(s, T);
  assert.equal(b.verdict, "ok");
  assert.ok(b.session_to_spend > 0);
});
