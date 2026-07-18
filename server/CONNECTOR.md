# Maxx connector — deploy + wire-up

The account-wide **Maxx** connector is how every Claude Code cloud routine reports
its token burn to the central tally (and reads budget back). It's a standard
custom MCP connector added through Claude's official connector setup — one MCP
endpoint that also serves the laptop's REST emit. Both talk the [LOGS.md](../maxx/LOGS.md)
contract to one per-handle store.

Why a connector and not a repo skill: a skill only exists in routines that clone
that repo; a connector is attached once to your claude.ai account and reaches
**every** session you enable it on, regardless of repo. It must include the cloud
routines or their burn is invisible — and a missing surface biases the tally
optimistically (see [[maxx-cloud-cannot-self-derive-budget]]).

## 1. Deploy the server (meetmaxx.co, Netlify)

The server is transport-agnostic; the Netlify wrapper is `server/netlify-fn.mjs`.

1. Place `server/netlify-fn.mjs` in the site's functions dir (e.g.
   `netlify/functions/maxx.mjs`) with `handler.mjs` / `tally.mjs` / `store.mjs`
   reachable by its imports; ensure `@netlify/blobs` is available.
2. Set env in Netlify: `MAXX_SECRET` (shared bearer) or `MAXX_SECRET_<HANDLE>`
   (per user, e.g. `MAXX_SECRET_REIF`). This must match the `secret` in the
   laptop's `~/.maxx/config.json`.
3. Deploy (manual, per project convention): `netlify deploy --prod --dir site …`.
4. Verify: `curl https://meetmaxx.co/health` → `{"ok":true,"service":"maxx-tally"}`.

Endpoints once live:
- `POST /api/u/{handle}/logs` · `GET /api/u/{handle}/budget` (laptop emit)
- `POST /mcp` (the connector; Streamable HTTP / JSON-RPC 2.0)

## 2. Add the official connector in Claude

claude.ai → **Settings → Connectors → Add custom connector**:
- **Name:** `Maxx`
- **URL:** `https://meetmaxx.co/mcp?handle=<yourhandle>` (the `handle` query pins
  the budget owner; alternatively pass `handle` in each tool call's arguments)
- **Auth:** Bearer — the same secret as the server env / laptop config.

It exposes two tools:
- `maxx_emit({ surface, sessions[], anchor? })` — report usage metadata (counts
  only). Cloud routines leave `anchor` unset (they can't read /usage).
- `maxx_budget()` — read the omni-surface budget to gate spend.

## 3. Enable it on the routines + gate on it

For each cloud routine (claude.ai/code/routines → the routine → connectors),
include **Maxx**, and update the routine prompt:

- **Report burn** (so the tally is complete): near the end of the run, and at
  checkpoints in a long run, call `maxx_emit` with `surface:"cloud:<routine>"` and
  a `sessions` entry carrying the output tokens generated this run (best-effort;
  the anchor trues it up). This is the live-stream from cloud.
- **Gate on the central budget** instead of the laptop-fed dashboard: replace the
  `curl …/api/pm/board … signals.budget` gate with a `maxx_budget()` call, and
  apply the same FAIL-CLOSED rule on `verdict` in `("over","stale")` /
  `session_to_spend == 0`.

## 4. Keep the laptop shipping (the anchor source)

The laptop is the only surface that carries the authoritative `/usage` anchor.
Keep it streaming:
- one-shot: `node maxx/emit.mjs --send` (cron/launchd every few minutes), or
- live: `node maxx/emit.mjs --watch` (tails `.jsonl` appends, ships each turn as
  it lands during a running session).

Config in `~/.maxx/config.json`: `handle`, `secret`, `installId`, `logsUrl`
(default `https://meetmaxx.co`). Cursor in `~/.maxx/emit-cursor.json`.
