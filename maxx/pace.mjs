/**
 * The WEEK line's pace token — pure decision, extracted so it's testable (render.mjs
 * runs main() and reads homedir() at import, so it can't be unit-tested in place).
 *
 * The week line answers ONE question: am I over? The "X left" token already answers it
 * (left > 0 → not over). This SECOND token is a PACE signal only: the even-pace bank,
 * cap×elapsed − used = how far ahead of / behind a straight-line burn through the week.
 *
 * It used to render as the word "over" in RED — the same word and colour the real,
 * fleet-halting cap verdict uses. So a −3.6M pace wobble against a 289M week (1.3%, pure
 * noise) read as "you breached your weekly cap" while 91% of the tank was still there.
 * That is the exact confusion that made the week status unreadable on 2026-07-24.
 *
 * Rules, so that can't happen again:
 *  - never the word "over" — "ahead pace" / "behind pace" (over belongs to the verdict);
 *  - behind pace is AMBER, not RED — RED is reserved for the actual over-budget verdict;
 *  - dead-banded: a deviation under 5% of the weekly cap is even-pace noise → show nothing.
 *
 * bankTokens and capTokens are in the same units. Returns null when nothing should render.
 */
export function weekPaceToken(bankTokens, capTokens) {
  if (!capTokens || capTokens <= 0) return null;
  if (Math.abs(bankTokens) <= capTokens * 0.05) return null; // on pace → no token at all
  const ahead = bankTokens >= 0;
  return {
    ahead,
    label: ahead ? "ahead pace" : "behind pace",
    role: ahead ? "good" : "warn", // good→green, warn→amber — never "danger"/red
    magnitude: Math.abs(bankTokens),
  };
}
