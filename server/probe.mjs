/**
 * Pull-on-miss anchor.
 *
 * The anchor is a CACHE of Anthropic's own limit state. Normally the laptop PUSHES it
 * (emit.mjs ships five_pct/week_pct/sl every interactive turn). When that push stops —
 * laptop asleep, account switched, machine off — the anchor ages out and the whole
 * fleet reads `stale`, which is a hard stop for every cloud routine. A budget sitting
 * untouched behind a dead signal is the failure we keep paying for (2026-07-23: 1.15B
 * weekly tokens stranded because no fresh anchor landed after a weekly reset).
 *
 * So when the push is missing, PULL it. Every response to an inference call made with a
 * subscription OAuth token carries the live limit state in headers:
 *
 *   anthropic-ratelimit-unified-5h-utilization  0..1
 *   anthropic-ratelimit-unified-5h-reset        unix seconds
 *   anthropic-ratelimit-unified-7d-utilization  0..1
 *   anthropic-ratelimit-unified-7d-reset        unix seconds
 *
 * A max_tokens:1 Haiku call costs ~1 output token, and the shape it yields is exactly
 * the pre-`sl` anchor that tally.mjs already consumes (cap = ledger ÷ pct) — no new
 * math, no new verdict states. Fractions only, so this is a FALLBACK anchor, not a
 * replacement for the statusline's absolute token counts.
 *
 * Cost is zero while the laptop is healthy: nothing calls this until an anchor is stale.
 */

const PROBE_URL = "https://api.anthropic.com/v1/messages";
const PROBE_MODEL = "claude-haiku-4-5-20251001";

// Number(null) and Number("") are both 0 — a missing header must read as ABSENT, not
// as "0% used", or a 401 would look like a wide-open account.
const num = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * One probe. Returns an anchor row (tally.mjs shape) or null if the headers weren't
 * usable. Never throws — a dead probe must not take the budget route down with it.
 *
 * `token` is a setup-token (sk-ant-oat…, user:inference scope). The short-lived OAuth
 * access token from a live CLI login also works but expires in hours.
 */
export async function probeAnchor(token, { now, fetchImpl = fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(PROBE_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: PROBE_MODEL, max_tokens: 1, messages: [{ role: "user", content: "." }] }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return null;
  }
  // Headers are what we came for, and a 429 still carries them — read them whatever
  // the status says. Only a response with no usable numbers is a failed probe.
  const g = (k) => num(res.headers?.get?.(`anthropic-ratelimit-unified-${k}`));
  const five_pct = g("5h-utilization");
  const week_pct = g("7d-utilization");
  if (five_pct == null && week_pct == null) return null;
  return {
    ts: Math.round(now),
    five_pct: five_pct ?? 0,
    week_pct: week_pct ?? 0,
    five_reset: g("5h-reset") ?? 0,
    week_reset: g("7d-reset") ?? 0,
    // no `sl`: headers give fractions, not the CLI's absolute token counts. The
    // pct path in computeBudget derives caps from our own ledger.
    sl: null,
    src: "probe",
  };
}

export { PROBE_MODEL };
