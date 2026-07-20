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
  // webhooks: [{url, secret, headers, format}] · leases: [{id, tokens, expires, label}]
  // signal: last-notified state for transition webhooks · config: per-handle overrides
  // directives: [{id, session, surface, action, note, created, expires, delivered_to}]
  return { events: [], anchors: [], seen: {}, webhooks: [], leases: [], signal: null, config: {}, directives: [], ops: [] };
}

// Ops ring: everything that happens ON the tally besides emits — MCP budget checks,
// reserve leases, directives, auth events. Capped so it can never bloat the store.
export function logOp(store, op, detail = "", now) {
  store.ops = store.ops || [];
  store.ops.push({ ts: Math.round(now), op, d: String(detail).slice(0, 120) });
  if (store.ops.length > 300) store.ops = store.ops.slice(-300);
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
      // attribution + analytics metadata (optional on the wire, counts only)
      project: s.project || null,
      name: s.name || null,
      branch: s.branch || null,
      raw: s.raw || 0,
      cache_read: s.cache_read || 0,
      cache_write: s.cache_write || 0,
      tool_calls: s.tool_calls || 0,
      agent_turns: s.agent_turns || 0,
      errors: s.errors || 0,
      turns: s.turns || 0,
      ctx: s.ctx || 0,
      cost_per_action: s.cost_per_action || 0,
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
      // statusline passthrough (its units) — number-sanitized, everything optional
      sl: env.anchor.sl && Number(env.anchor.sl.week_cap) > 0 ? {
        five_used: Number(env.anchor.sl.five_used) || 0,
        five_cap: Number(env.anchor.sl.five_cap) || 0,
        to_spend: Number(env.anchor.sl.to_spend) || 0,
        over: Number(env.anchor.sl.over) || 0,
        week_used: Number(env.anchor.sl.week_used) || 0,
        week_cap: Number(env.anchor.sl.week_cap),
      } : null,
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

  // The 5h limit is ALSO a fixed window (zeroes at five_reset), not a rolling sum — a
  // rolling 5h right after a wall reset still carries the pre-wall burn and shows a
  // fresh window as ~full (dash said "+146,460k · 0 left" while the statusline was at
  // 8.5M). Window start = five_reset − 5h when the anchor's reset is still ahead of us;
  // stale/absent reset falls back to rolling (and the verdict is stale then anyway).
  const fr = a?.five_reset || 0;
  // fr ahead → current window began at fr−5h. fr already PASSED (wall reset since the
  // last anchor, no fresh one yet) → the new window began AT fr: count only events
  // after it, never the pre-reset burn. No usable fr → rolling fallback.
  const fiveLo = fr > now ? fr - FIVE_H : fr && now - fr < FIVE_H ? fr : undefined;
  let five = windowedBilled(store.events, now, FIVE_H, fiveLo);
  const wr = a?.week_reset || 0;
  let week = windowedBilled(store.events, now, WEEK, wr ? weekLoFor(wr, now) : undefined);

  // Anchor the caps: cap = tokens-in-window ÷ observed-pct, measured at anchor time.
  // Use the anchor's own windowed sums so cap reflects the same window the % described.
  let fiveCap = null, weekCap = null, quota = null, weekPct = null;
  // floors at >0.005 so a 1% wall reading calibrates: right after an account switch that's the
  // only anchor there is, and refusing it left session_to_spend null — cloud gates saw "unknown"
  // instead of the real availability.
  if (a) {
    if (a.five_pct > 0.005) {
      // same fixed window the anchor's % described
      const fiveAtAnchor = windowedBilled(store.events, a.ts, FIVE_H, fr > a.ts ? fr - FIVE_H : undefined);
      fiveCap = Math.round(fiveAtAnchor / a.five_pct);
    }
    if (a.week_pct > 0.005) {
      const weekAtAnchor = windowedBilled(store.events, a.ts, WEEK, wr ? weekLoFor(wr, a.ts) : undefined);
      weekCap = Math.round(weekAtAnchor / a.week_pct);
    }
    // Live utilization = current windowed sum ÷ anchored cap (extrapolated forward).
    quota = fiveCap ? Math.min(1, five / fiveCap) : a.five_pct;
    weekPct = weekCap ? Math.min(1, week / weekCap) : a.week_pct;
  }

  // Statusline passthrough: when the anchor carries the CLI bar's own computed numbers
  // (sl — ITS units), those become the ruler and every surface posts what the CLI posts.
  // Between anchors we extrapolate with server-billed-since-anchor; anchors ship every
  // interactive turn, so the drift window is small (and the % anchor path above remains
  // the fallback for old emitters / stale sl).
  let slSpend = null, slOver = 0;
  if (a && fresh && a.sl) {
    const since = windowedBilled(store.events, now, WEEK, a.ts);
    // 5h-window fields are only valid while the window the anchor described is still
    // current (fr ahead of now) — after a wall reset they describe a dead window and
    // the fixed-window sum above (events since fr) is the truth until the next anchor.
    const windowCurrent = fr > now;
    if (windowCurrent && a.sl.five_cap > 0) { fiveCap = a.sl.five_cap; five = a.sl.five_used + since; }
    weekCap = a.sl.week_cap;
    week = a.sl.week_used + since;
    quota = fiveCap ? Math.min(1, five / fiveCap) : quota;
    weekPct = Math.min(1, week / weekCap);
    // the CLI's roll-session numbers are the governor's — reconstruct its realMax
    // (five_used + toSpend − over covers both sides of the share) and re-derive
    // toSpend/over at NOW, so the gate and the bars agree with the CLI exactly
    if (windowCurrent) {
      const realMax = a.sl.five_used + a.sl.to_spend - (a.sl.over || 0);
      slSpend = Math.max(0, realMax - five);
      slOver = Math.max(0, five - realMax);
    }
  }

  const weeklyLeft = weekCap != null ? Math.max(0, weekCap - week) : null;
  // sessions-left-this-week paces the weekly headroom over the 5h windows remaining,
  // capped at the 5h wall, MINUS what this window already spent (limit.mjs rollSession).
  const windowsLeft = wr ? Math.max(1, (wr - now) / FIVE_H) : 1;
  const sessionSafe = weeklyLeft != null
    ? Math.min(fiveCap ?? Infinity, Math.round(weeklyLeft / windowsLeft)) : null;
  const sessionToSpend = slSpend != null ? slSpend : sessionSafe != null ? Math.max(0, sessionSafe - five) : null;

  // #4 reservation leases: active leases subtract from the allowance other
  // callers see (the grantee tracks its own lease). Expired leases are ignored
  // here and pruned on write in the handler.
  const activeLeases = (store.leases || []).filter((l) => l.expires > now);
  const reservedTokens = activeLeases.reduce((s, l) => s + l.tokens, 0);
  const spendAfterReserve = sessionToSpend != null ? Math.max(0, sessionToSpend - reservedTokens) : null;

  let verdict = "ok";
  if (!a || !fresh) verdict = "stale";
  else if ((weekPct != null && weekPct >= 0.99) || (quota != null && quota >= 0.99) || spendAfterReserve === 0) verdict = "over";

  // Channel = surface × project: two CC instances on one laptop (different project
  // dirs) are distinct channels, not one blob. Events without a project (cloud
  // routines — already unique per surface — and legacy rows) stay surface-only.
  // Owner-facing (authed budget/dash); the public card never sees these keys.
  const surfaces = {};
  for (const e of store.events) {
    if (e.ts > now - FIVE_H) {
      const key = e.project ? `${e.surface} · ${e.project}` : e.surface;
      surfaces[key] = (surfaces[key] || 0) + e.billed;
    }
  }

  // lifetime odometer: the whole store, backfill included (weighted units)
  const lifetime = store.events.reduce((s, e) => s + e.billed, 0);

  // #5 burn rate (account-wide, last 5m) + time-to-empty at that rate
  const burn5m = store.events.reduce((s, e) => (e.ts > now - 300 && e.ts <= now + 60 ? s + e.billed : s), 0);
  const ratePerSec = burn5m / 300;
  const emptiesAt =
    ratePerSec > 3 && spendAfterReserve != null
      ? Math.round(now + spendAfterReserve / ratePerSec)
      : null;

  // #2 attribution: heaviest sessions of the last hour, with live 5m rate
  const burners = new Map();
  for (const e of store.events) {
    if (e.ts <= now - 3600 || e.ts > now + 60) continue;
    const key = `${e.surface}|${e.root}`;
    let b = burners.get(key);
    if (!b) { b = { surface: e.surface, session: e.root, project: null, name: null, tokens_1h: 0, rate_5m: 0, ctx: 0, cost_per_action: 0, _ts: 0 }; burners.set(key, b); }
    b.tokens_1h += e.billed;
    if (e.ts > now - 300) b.rate_5m += e.billed;
    if (e.project) b.project = e.project;
    if (e.name) b.name = e.name;
    if (e.ts >= b._ts && e.ctx) { b._ts = e.ts; b.ctx = e.ctx; b.cost_per_action = e.cost_per_action || 0; }
  }
  const topBurners = [...burners.values()].sort((x, y) => y.tokens_1h - x.tokens_1h).slice(0, 3);

  // when tokens come back: session_to_spend refills at five_reset (next 5h
  // window); a weekly wall only lifts at week_reset. Shipped as countdowns so
  // an agent doesn't have to do epoch math to answer "how long until tokens?".
  const fiveReset = a?.five_reset || null;
  const resetIn = (t) => (t && t > now ? Math.round(t - now) : null);

  return {
    quota, week: weekPct,
    five_reset: fiveReset, week_reset: wr || null,
    five_reset_in_sec: resetIn(fiveReset), week_reset_in_sec: resetIn(wr),
    tokens_again:
      (weekPct != null && weekPct >= 0.99)
        ? `weekly cap — tokens at week_reset (${resetIn(wr) != null ? Math.round(resetIn(wr) / 3600) + "h" : "?"})`
        : `next 5h window (${resetIn(fiveReset) != null ? Math.round(resetIn(fiveReset) / 60) + "m" : "?"}) refills session_to_spend`,
    weekly_left_tokens: weeklyLeft, session_to_spend: spendAfterReserve,
    session_over: slOver,
    session_safe: sessionSafe,
    reserved_tokens: reservedTokens, leases: activeLeases.length,
    burn_5m: burn5m, empties_at: emptiesAt,
    top_burners: topBurners,
    verdict, fresh,
    anchor_age_sec: Number.isFinite(anchorAge) ? Math.round(anchorAge) : null,
    stored_at: new Date(now * 1000).toISOString(),
    five_billed: five, week_billed: week, lifetime_billed: lifetime,
    surfaces: Object.entries(surfaces)
      .sort((x, y) => y[1] - x[1])
      .map(([surface, billed_5h]) => ({ surface, billed_5h })),
  };
}

// ---- directive channel: orchestrator → specific session commands ----------
// Actions: clear (advise /clear — injected as context, one-shot per session),
// pause (deny expensive tools until ttl/resume — sticky, re-delivered every
// read), resume (lifts pending pauses immediately, never queued).
// session "*" = broadcast. Every create/delivery lands in the feed as a
// billed:0 event (visible in maxx watch, never counted — same as gate notes).

const feedNote = (store, root, text, now) =>
  store.events.push({ surface: "directive", root, ts: now, billed: 0, name: text });

const pruneDirectives = (store, now) => {
  store.directives = (store.directives || []).filter((d) => d.expires > now);
};

export function addDirective(store, d, now) {
  const session = String(d.session || "").trim();
  const action = String(d.action || "");
  if (!session) return { ok: false, error: "session required ('*' = broadcast)" };
  if (!/^(clear|pause|resume)$/.test(action)) return { ok: false, error: "action must be clear|pause|resume" };
  pruneDirectives(store, now);
  if (action === "resume") {
    const before = store.directives.length;
    store.directives = store.directives.filter(
      (x) => !(x.action === "pause" && (session === "*" || x.session === session)),
    );
    const lifted = before - store.directives.length;
    feedNote(store, session, `▶ resume — ${lifted} pause${lifted === 1 ? "" : "s"} lifted`, now);
    return { ok: true, action, lifted };
  }
  const ttl = Math.min(Math.max(Number(d.ttl_sec) || 3600, 60), 24 * 3600);
  const dir = {
    id: `d${Math.round(now)}-${(store.directives.length + 1).toString(36)}`,
    session, surface: d.surface || null, action, note: d.note || null,
    created: Math.round(now), expires: Math.round(now + ttl), delivered_to: [],
  };
  store.directives.push(dir);
  feedNote(store, session, `⌘ ${action}→${session === "*" ? "all" : session.slice(0, 8)}${dir.note ? `: ${dir.note}` : ""}`, now);
  return { ok: true, id: dir.id, action, session, expires: dir.expires };
}

/**
 * Directives pending for one session; reading IS consuming (unless peek).
 * clear → delivered once per session; pause → sticky until expiry/resume.
 */
export function pendingDirectives(store, { session, surface = null, peek = false }, now) {
  pruneDirectives(store, now);
  const hits = store.directives.filter(
    (d) =>
      (d.session === "*" || d.session === session) &&
      (!d.surface || !surface || d.surface === surface) &&
      !(d.action === "clear" && (d.delivered_to || []).includes(session)),
  );
  if (!peek)
    for (const d of hits) {
      d.delivered_to = d.delivered_to || [];
      if (!d.delivered_to.includes(session)) {
        d.delivered_to.push(session);
        feedNote(store, d.session, `✓ ${d.action} delivered→${String(session).slice(0, 8)}`, now);
      }
    }
  return hits.map(({ id, session: s, surface: sf, action, note, created, expires }) =>
    ({ id, session: s, surface: sf, action, note, created, expires }));
}

// #3 runaway detection — sessions burning ≥ rate for ≥ sustain minutes.
// Pure: returns the CURRENT offenders; the caller (notifier) diffs against
// store.signal.runaway to fire exactly one event per episode and clear on stop.
export function runawaySessions(store, now, config = {}) {
  const rate = config.runaway_rate_5m || 500_000;      // tokens per 5m
  const sustainMin = config.runaway_min || 30;
  const need = rate * (sustainMin / 5);                // sustained total over the window
  const per = new Map();
  for (const e of store.events) {
    if (e.ts <= now - sustainMin * 60 || e.ts > now + 60) continue;
    const key = `${e.surface}|${e.root}`;
    let p = per.get(key);
    if (!p) { p = { surface: e.surface, session: e.root, project: null, tokens: 0, last5: 0 }; per.set(key, p); }
    p.tokens += e.billed;
    if (e.ts > now - 300) p.last5 += e.billed;
    if (e.project) p.project = e.project;
  }
  return [...per.values()]
    .filter((p) => p.last5 >= rate && p.tokens >= need)
    .map((p) => ({ surface: p.surface, session: p.session, project: p.project, rate_5m: p.last5, duration_min: sustainMin }));
}

// #1 push on state transitions — diff current state against store.signal and
// return the webhook events to fire. Mutates store.signal (persist after).
// First observation baselines silently (no event storm on deploy).
export function transitionEvents(store, budget, now) {
  const weekBand = budget.week == null ? 0 : budget.week >= 0.95 ? 95 : budget.week >= 0.9 ? 90 : budget.week >= 0.8 ? 80 : 0;
  const runaway = runawaySessions(store, now, store.config || {});
  const runawayKeys = runaway.map((r) => `${r.surface}|${r.session}`).sort();
  const prev = store.signal;
  const cur = { verdict: budget.verdict, weekBand, runaway: runawayKeys };
  store.signal = cur;
  if (!prev) return [];                                 // baseline, fire nothing
  const events = [];
  if (prev.verdict === "ok" && budget.verdict === "over") events.push({ event: "over" });
  if (prev.verdict === "over" && budget.verdict === "ok") events.push({ event: "refill" });
  if (weekBand > (prev.weekBand || 0)) events.push({ event: `week-${weekBand}` });
  for (const r of runaway)
    if (!(prev.runaway || []).includes(`${r.surface}|${r.session}`))
      events.push({ event: "runaway", ...r });
  return events.map((e) => ({
    handle: null, // filled by the notifier
    ...e,
    verdict: budget.verdict, session_to_spend: budget.session_to_spend,
    week: budget.week, ts: Math.round(now),
  }));
}
