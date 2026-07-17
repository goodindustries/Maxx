// prices.mjs — daily refresh of per-model quota weights from Anthropic's public pricing page.
// Writes ~/.maxx/prices.json; limit.mjs reads it and falls back to built-in weights if absent
// or stale-parse. This is maxx's ONE egress: a read-only GET of public docs, no user data sent.
// Run via cron (installed by install.sh / crontab): 0 9 * * *  node .../maxx/prices.mjs
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const URL = "https://docs.anthropic.com/en/docs/about-claude/pricing.md";
const OUT = path.join(os.homedir(), ".maxx", "prices.json");
const FAMILIES = ["fable", "mythos", "opus", "sonnet", "haiku"];

async function main() {
  const res = await fetch(URL, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const md = await res.text();

  // first $-price seen per family, in document order = standard-pricing table, newest model first
  const input = {};
  for (const line of md.split("\n")) {
    const m = line.match(/\b(Fable|Mythos|Opus|Sonnet|Haiku)\b[^|]*\|[^|$]*\$\s*([0-9.]+)\s*\/\s*MTok/i);
    if (!m) continue;
    const fam = m[1].toLowerCase();
    if (!(fam in input)) input[fam] = parseFloat(m[2]);
    if (FAMILIES.every(f => f in input)) break;
  }

  // sanity: refuse to overwrite good data with a bad parse (page redesign, partial fetch)
  const got = FAMILIES.filter(f => input[f] > 0);
  if (got.length < 4 || !(input.sonnet > 0)) throw new Error(`parse failed: ${JSON.stringify(input)}`);

  // weights relative to sonnet=1 — only ratios matter (limit.mjs's cap anchor cancels scale)
  const weights = {};
  for (const f of got) weights[f] = +(input[f] / input.sonnet).toFixed(4);

  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ ts: Date.now(), url: URL, input, weights }, null, 2) + "\n");
  console.log("prices.json updated:", JSON.stringify(weights));
}

main().catch(e => {
  // keep the previous file on any failure; note the failed attempt for staleness display
  try {
    const prev = JSON.parse(readFileSync(OUT, "utf8"));
    prev.lastError = { ts: Date.now(), message: e.message };
    writeFileSync(OUT, JSON.stringify(prev, null, 2) + "\n");
  } catch {}
  console.error("prices refresh failed (kept previous weights):", e.message);
  process.exit(1);
});
