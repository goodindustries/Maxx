/**
 * maxx tally — the pure server-side brain behind centralized budget.
 *
 * Ingests emit envelopes (from emit.mjs on-box, or the maxx MCP connector in the
 * cloud) into a per-handle store, and computes the budget the gate reads. No I/O,
 * no HTTP — the Netlify function / MCP server is a thin wrapper that persists the
 * store (e.g. Netlify Blobs keyed by handle) and calls these functions. Kept pure
 * so the whole pipeline is testable on-box with a real envelope.
 *
 * Design notes:
 * - The emitter ships DELTAS per root (new tokens since its cursor). The server
 *   SUMS them, deduped by (surface, cursor, root) so a re-sent batch is a no-op.
 * - First run ships ALL history (bulk backfill). Old records carry old `last_ts`,
 *   so they fall OUTSIDE the live 5h/weekly windows and never distort live budget —
 *   they're retained for true-up: reconciling cap estimates against past anchors.
 * - A token's effective time is its session-delta `last_ts`. For frequent deltas
 *   (last_ts ≈ now) this is accurate; for the one-time backfill it's coarse, but
 *   backfill records are historical and out-of-window anyway.
 * - Cap is anchored: at each observed `anchor`, cap = windowed_tokens ÷ pct. The
 *   latest fresh anchor wins; between anchors we hold the cap and extrapolate.
 */

const FIVE_H = 5 * 3600;
const WEEK = 7 * 24 * 3600;
const ANCHOR_TRUST_SEC = 45 * 60; // matches the routines' staleness gate

const sec = (iso) => (iso ? Date.parse(iso) / 1000 : 0);

export function emptyStore() {
  return { events: [], anchors: [], seen: {} };
}

/**
 * Merge one envelope into the store. Idempotent on (surface, cursor, root).
 * Returns { accepted, deduped }.
 */
export function applyEnvelope(store, env) {
  let accepted = 0, deduped = 0;
  const surface = env.surface || "unknown";
  const cursor = String(env.cursor ?? "");
  for (const s of env.sessions || []) {
    const key = `${surface}|${cursor}|${s.root}`;
    if (store.seen[key]) { deduped++; continue; }
    store.seen[key] = 1;
    store.events.push({
      surface,
      root: s.root,
      ts: sec(s.last_ts) || sec(env.emitted_at),
      billed: s.billed || 0,
      output: s.output || 0,
      by_model: s.by_model || {},
    });
    accepted++;
  }
  if (env.anchor && (env.anchor.five_pct != null || env.anchor.week_pct != null)) {
    store.anchors.push({
      ts: sec(env.anchor.observed_at) || sec(env.emitted_at),
      five_pct: env.anchor.five_pct,
      week_pct: env.anchor.week_pct,
      five_reset: env.anchor.five_reset,
      week_reset: env.anchor.week_reset,
    });
  }
  return { accepted, deduped };
}

const latestAnchor = (store) =>
  store.anchors.length ? store.anchors.reduce((a, b) => (b.ts > a.ts ? b : a)) : null;

// Sum billed across all surfaces whose effective ts is within (lo, now].
const windowedBilled = (events, now, win, lo = now - win) => {
  let sum = 0;
  for (const e of events) if (e.ts > lo && e.ts <= now + 60) sum += e.billed;
  return sum;
};

// Anthropic's weekly limit is a FIXED window that zeroes at week_reset, not a rolling
// sum (limit.mjs computes weekUsed the same way — this is what makes tally == statusline).
// Start = week_reset − 7d, rolled forward if the reset has already passed.
const weekLoFor = (weekReset, now) => {
  let lo = weekReset - WEEK;
  while (lo + WEEK < now) lo += WEEK;
  return lo;
};

/**
 * Compute the budget the gate consumes. Shape-compatible with the board's
 * signals.budget. `now` in seconds.
 */
export function computeBudget(store, now) {
  const a = latestAnchor(store);
  const anchorAge = a ? now - a.ts : Infinity;
  const fresh = anchorAge <= ANCHOR_TRUST_SEC;

  const five = windowedBilled(store.events, now, FIVE_H);
  const wr = a?.week_reset || 0;
  const week = windowedBilled(store.events, now, WEEK, wr ? weekLoFor(wr, now) : undefined);

  // Anchor the caps: cap = tokens-in-window ÷ observed-pct, measured at anchor time.
  // Use the anchor's own windowed sums so cap reflects the same window the % described.
  let fiveCap = null, weekCap = null, quota = null, weekPct = null;
  if (a) {
    if (a.five_pct > 0.01) {
      const fiveAtAnchor = windowedBilled(store.events, a.ts, FIVE_H);
      fiveCap = Math.round(fiveAtAnchor / a.five_pct);
    }
    if (a.week_pct > 0.01) {
      const weekAtAnchor = windowedBilled(store.events, a.ts, WEEK, wr ? weekLoFor(wr, a.ts) : undefined);
      weekCap = Math.round(weekAtAnchor / a.week_pct);
    }
    // Live utilization = current windowed sum ÷ anchored cap (extrapolated forward).
    quota = fiveCap ? Math.min(1, five / fiveCap) : a.five_pct;
    weekPct = weekCap ? Math.min(1, week / weekCap) : a.week_pct;
  }

  const weeklyLeft = weekCap != null ? Math.max(0, weekCap - week) : null;
  // sessions-left-this-week paces the weekly headroom over the 5h windows remaining.
  const windowsLeft = wr ? Math.max(1, (wr - now) / FIVE_H) : 1;
  const sessionToSpend = weeklyLeft != null ? Math.max(0, Math.round(weeklyLeft / windowsLeft)) : null;

  let verdict = "ok";
  if (!a || !fresh) verdict = "stale";
  else if ((weekPct != null && weekPct >= 0.99) || sessionToSpend === 0) verdict = "over";

  const surfaces = {};
  for (const e of store.events) {
    if (e.ts > now - FIVE_H) surfaces[e.surface] = (surfaces[e.surface] || 0) + e.billed;
  }

  return {
    quota, week: weekPct,
    five_reset: a?.five_reset || null, week_reset: wr || null,
    weekly_left_tokens: weeklyLeft, session_to_spend: sessionToSpend,
    verdict, fresh,
    anchor_age_sec: Number.isFinite(anchorAge) ? Math.round(anchorAge) : null,
    stored_at: new Date(now * 1000).toISOString(),
    five_billed: five, week_billed: week,
    surfaces: Object.entries(surfaces)
      .sort((x, y) => y[1] - x[1])
      .map(([surface, billed_5h]) => ({ surface, billed_5h })),
  };
}
