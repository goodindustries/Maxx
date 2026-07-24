/**
 * Extract a Claude setup-token from `claude setup-token` output.
 *
 * setup-token mints a LONG-LIVED (≈1yr) inference credential (sk-ant-oat…, user:inference
 * scope) that is separate from the CLI's own login — so storing it server-side lets the
 * tally PULL a fresh limit anchor when the laptop stops pushing one, without ever touching
 * or rotating the credential the CLI logs in with. This is the token /maxx set-token and
 * the installer capture and POST to /api/u/<handle>/config {probe_token}.
 *
 * The command prints human chatter around the token; we pull the token itself out. Pure so
 * the capture path is testable without a browser (the interactive OAuth leg is not).
 */
const TOKEN_RE = /sk-ant-oat[0-9A-Za-z][0-9A-Za-z._-]{40,}/;

export function extractSetupToken(text) {
  if (!text) return null;
  const m = String(text).match(TOKEN_RE);
  return m ? m[0] : null;
}
