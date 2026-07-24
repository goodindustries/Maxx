// The week line's pace token. The bug (2026-07-24): a tiny even-pace wobble rendered as
// the word "over" in RED — the same word/colour the fleet-halting cap verdict uses — so
// "263M left · −3.6M over" read as a weekly breach when 91% of the tank remained.
import { test } from "node:test";
import assert from "node:assert/strict";
import { weekPaceToken } from "./pace.mjs";

const CAP = 289e6; // reif_tgp's real weekly cap the day of the bug

test("the reproducer: a 3.6M behind-pace wobble is NOT called 'over' and is NOT red", () => {
  const t = weekPaceToken(-3.6e6, CAP); // 1.3% of cap — the exact screenshot number
  // 3.6M is inside the 5%-of-cap dead-band → it should not render at all
  assert.equal(t, null, "sub-band pace noise must print nothing, not a red 'over'");
});

test("behind pace beyond the band: amber, compact signed %, never 'over'/red", () => {
  const t = weekPaceToken(-30e6, CAP); // ~10% behind
  assert.ok(t, "a real deviation renders");
  assert.equal(t.role, "warn", "behind pace is amber (warn), never red (danger)");
  assert.notEqual(t.role, "danger");
  assert.equal(t.ahead, false);
  assert.equal(t.pct, 10, "30M / 289M ≈ 10% — the compact display unit");
  assert.equal(/over/.test(t.label), false, "the word 'over' must never appear");
});

test("ahead of pace beyond the band: green, signed % of cap", () => {
  const t = weekPaceToken(40e6, CAP);
  assert.equal(t.role, "good");
  assert.equal(t.ahead, true);
  assert.equal(t.pct, 14, "40M / 289M ≈ 14%");
});

test("dead-band: anything within ±5% of cap prints nothing (on pace)", () => {
  assert.equal(weekPaceToken(0, CAP), null);
  assert.equal(weekPaceToken(14e6, CAP), null);   // 4.8% ahead → still noise
  assert.equal(weekPaceToken(-14e6, CAP), null);  // 4.8% behind → still noise
  assert.ok(weekPaceToken(15e6, CAP), "5.2% ahead crosses the band");
  assert.ok(weekPaceToken(-15e6, CAP), "5.2% behind crosses the band");
});

test("no cap (uncalibrated) → no token, never a divide-by-zero deviation", () => {
  assert.equal(weekPaceToken(-30e6, 0), null);
  assert.equal(weekPaceToken(-30e6, null), null);
});
