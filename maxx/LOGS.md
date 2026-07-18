# maxx centralized budget — wire contract

Subscription budget (5h + weekly %) is observable **only** from an interactive
Claude Code client (the laptop statusline's `rate_limits`). Cloud routines can't
read `/usage` at all. So we don't ship the *percentage* from every surface — we
ship the *raw token counts* every surface can see, tally them centrally, and
**anchor** the tally to the authoritative % whenever an interactive session
observes one. See [[maxx-cloud-cannot-self-derive-budget]].

Two producers, one store, one reader:

```
 laptop/on-box ──emit.mjs──┐
                           ├──▶  meetmaxx.co  ──(tally + windows + anchor)──▶  /budget  ──▶ gate
 cloud routines ──MCP──────┘        (keyed by user handle)
```

- **Laptop** ships via `maxx/emit.mjs` (exact usage from `~/.claude/projects/**`).
- **Cloud** ships via the **account-wide `maxx` MCP connector** — NOT a repo skill
  (a skill only exists in routines that clone that repo; a connector is attached
  once to the claude.ai account and available to every session). The connector
  exposes `maxx_emit` + `maxx_budget`, talking this same contract.

**Privacy invariant:** only token/usage **metadata** ever leaves a surface —
counts, timestamps, model family, session title/branch. Never prompt or message
content. The emitter enforces this by construction (it reads only `usage` blocks).

---

## 1. Emit — `POST /api/u/{handle}/logs`

`Authorization: Bearer {secret}` · body:

```jsonc
{
  "v": 1,
  "surface": "laptop:3b1cc3c3" | "cloud:<routine-or-session>",
  "install_id": "<uuid or env id>",
  "handle": "reif",
  "emitted_at": "<ISO>",
  "since": "<ISO|null>",                 // cursor lower bound this batch covers
  "cursor": "<opaque str>",              // server dedupes on (surface, cursor)
  "totals": { "billed": int, "output": int, "sessions": int },
  "sessions": [
    {
      "root": "<uuid>", "project": "nonprofit-atlas",
      "name": "<title>", "branch": "<git>",
      "billed": int,                     // input+output+cache_creation+cache_read
      "output": int, "turns": int,
      "by_model": { "Opus": int, "Sonnet": int, "Haiku": int, "Fable": int, "other": int },
      "first_ts": "<ISO>", "last_ts": "<ISO>"
    }
  ],
  "anchor": null | {                     // only when an interactive session saw one, fresh <30m
    "five_pct": 0..1, "week_pct": 0..1,  // authoritative subscription utilization
    "five_reset": <epoch>, "week_reset": <epoch>,
    "observed_at": "<ISO>"
  }
}
```

Response: `{ "ok": true, "accepted": int, "deduped": int }`. The emitter advances
its cursor only on a 2xx.

**Idempotency:** the server keys stored batches by `(handle, surface, cursor)` and
sums per (root) so a re-sent batch (cursor not advanced after a failed send) is a
no-op. Windows are reconstructed from `last_ts` per session, not from arrival time.

---

## 2. Tally + anchor (server side)

- **Rolling 5h:** sum `billed` where `last_ts > now − 5h`, across all surfaces.
- **Weekly:** sum `billed` where `last_ts > week_reset − 7d` (fixed window).
- **Cap calibration (the anchor):** at each `anchor`, `cap = summed_tokens ÷ pct`.
  Between anchors, hold the last cap and extrapolate `pct = summed ÷ cap`.
- **Weighting:** the server may weight `by_model` (Opus drains the quota faster
  than Haiku) — mirror `limit.mjs`'s weights; raw counts are sent so the weighting
  policy lives in one place.

**Exact vs estimated (state this honestly to the gate):** token *tally* is exact
and omni-surface; *% of wall* is fresh only to the last anchor and drifts between
them. Still strictly better than the laptop-only signal, which is simply absent
when the laptop sleeps.

---

## 3. Read — `GET /api/u/{handle}/budget`

`Authorization: Bearer {secret}` · returns the shape the gate already consumes
(compatible with the board's `signals.budget`):

```jsonc
{
  "quota": 0..1, "week": 0..1,           // 5h + weekly utilization (anchored)
  "five_reset": <epoch>, "week_reset": <epoch>,
  "weekly_left_tokens": int, "session_to_spend": int,
  "verdict": "ok" | "over" | "stale",
  "fresh": bool,                         // anchor within trust window
  "anchor_age_sec": int, "stored_at": "<ISO>",
  "surfaces": [ { "surface": "...", "last_seen": "<ISO>", "billed_5h": int } ]
}
```

`verdict: "stale"` when `anchor_age_sec` exceeds the trust window — the gate then
decides fail-closed vs conservative-floor (a spend-risk policy call, not the
server's).

---

## 4. Cloud MCP connector — tool mirror

The account-wide `maxx` connector exposes the same two operations as tools any
routine can call (no repo skill needed):

- `maxx_emit({ sessions, anchor? })` → same as §1. A cloud routine self-reports the
  output tokens it generated this run (it can count its own turns; it cannot read
  `/usage`, so `anchor` is almost always null from cloud).
- `maxx_budget()` → same as §3. The routine's budget gate reads this instead of
  curling the laptop-fed dashboard.

The connector server IS the tally store — emit, read, and storage in one hosted
endpoint, keyed by handle.

---

## Config (`~/.maxx/config.json`)

Reuses the fields the pre-teardown pusher already had: `handle` (userid),
`secret` (bearer), `installId` (surface id), plus `logsUrl` (base, default
`https://meetmaxx.co`). Cursor in `~/.maxx/emit-cursor.json`.
