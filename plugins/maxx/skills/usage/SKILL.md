---
name: usage
description: Show or configure the user's Codex usage fuel gauge, rate-limit resets, local token history, cache reuse, context health, or streak. Use for Maxx, Codex usage, token stats, quota, rate limits, context optimization, or status-line setup.
---

# Maxx for Codex

Use the deterministic scripts bundled beside this file. They inspect usage metadata only; do not reimplement their parsers or infer missing numbers.

## Route the request

- Default, `card`, or `status`: run `node scripts/usage.mjs`.
- `json`: run `node scripts/usage.mjs --json` and return the JSON verbatim.
- `optimize`: run `node scripts/optimize.mjs` and return the report verbatim.
- `optimize json`: run `node scripts/optimize.mjs --json`.
- `setup`, `install`, or status-line configuration: run `node scripts/setup.mjs`.
- If the user only wants to preview the config change: run `node scripts/setup.mjs --dry-run`.

Resolve each script to an absolute path relative to this `SKILL.md`, but keep the user's current workspace as the command working directory. That lets Maxx select the correct Codex session when other repos or subagents are active. Show normal card and optimizer output verbatim. If a script errors, report the error instead of guessing.

## Trust and privacy

- The local-history fallback reads only `session_meta`, `turn_context`, and `event_msg.token_count` records under `$CODEX_HOME/sessions` (normally `~/.codex/sessions`).
- It does not retain or emit prompts, assistant messages, reasoning, tool inputs, commands, or tool outputs. It uses session working-directory metadata only to select the invoking workspace; the optimizer may label its card with that project's folder name.
- The card may keep a short-lived stats cache under `$PLUGIN_DATA` when available, otherwise `$CODEX_HOME/maxx`; source rollout files remain read-only.
- The live account card asks the user's local `codex app-server` for the same account usage and rate-limit data that Codex exposes. Maxx has no analytics endpoint and sends nothing to Maxx or another third party.
- Rate-limit windows vary by account. Preserve their actual durations; never invent five-hour or weekly limits when Codex does not return them.
- Codex input token counts already include cached input, and output counts already include reasoning output. Never add those subset fields twice.

## Native footer

Codex does not expose Claude Code's arbitrary executable status-line renderer. Maxx setup therefore configures Codex's native footer fields for model, context remaining, five-hour and weekly limits, used tokens, and git branch. The richer Maxx card remains available through `$maxx:usage`.
