#!/usr/bin/env node
/**
 * Maxx account card for Codex.
 *
 * Live usage comes from the user's local `codex app-server`; local context and
 * history come from tracker.mjs. Maxx has no remote endpoint.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { collectStats } from "./tracker.mjs";

const VERSION = "0.1.0";

function normalizeWindow(raw) {
  if (!raw || typeof raw !== "object") return null;
  const usedPercent = Number.isFinite(raw.usedPercent) ? Math.max(0, Math.min(100, raw.usedPercent)) : null;
  const windowMinutes = Number.isFinite(raw.windowDurationMins) && raw.windowDurationMins > 0 ? raw.windowDurationMins : null;
  const resetsAt = Number.isFinite(raw.resetsAt) && raw.resetsAt > 0 ? raw.resetsAt : null;
  return {
    usedPercent,
    remainingPercent: usedPercent == null ? null : Math.max(0, 100 - usedPercent),
    windowMinutes,
    resetsAt,
    resetsAtIso: resetsAt == null ? null : new Date(resetsAt * 1000).toISOString(),
  };
}

export function normalizeAccountRateLimits(raw, observedAt = new Date().toISOString()) {
  if (!raw || typeof raw !== "object") return null;
  return {
    observedAt,
    limitId: typeof raw.limitId === "string" ? raw.limitId : null,
    limitName: typeof raw.limitName === "string" ? raw.limitName : null,
    planType: typeof raw.planType === "string" ? raw.planType : null,
    reachedType: typeof raw.rateLimitReachedType === "string" ? raw.rateLimitReachedType : null,
    primary: normalizeWindow(raw.primary),
    secondary: normalizeWindow(raw.secondary),
    credits: raw.credits && typeof raw.credits === "object" ? {
      hasCredits: Boolean(raw.credits.hasCredits),
      unlimited: Boolean(raw.credits.unlimited),
      balance: raw.credits.balance == null ? null : String(raw.credits.balance),
    } : null,
  };
}

/** Read current account usage through the local Codex app-server protocol. */
export function readAccountUsage(options = {}) {
  const command = options.command || process.env.MAXX_CODEX_BIN || "codex";
  const args = options.args || ["app-server", "--listen", "stdio://"];
  const timeoutMs = options.timeoutMs ?? 5000;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let account = null;
    let rateLimits = null;
    let initialized = false;

    const stop = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.stdin.end(); } catch {}
      if (error) {
        try { child.kill(); } catch {}
        reject(error);
      } else {
        // stdin EOF asks app-server to exit cleanly. Do not keep this CLI alive
        // if a future server version takes longer to notice the close.
        const killTimer = setTimeout(() => { try { child.kill(); } catch {} }, 250);
        killTimer.unref?.();
        resolve(value);
      }
    };

    const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);
    const onMessage = (message) => {
      if (message?.id === 0) {
        if (message.error) return stop(new Error(`Codex initialize failed: ${message.error.message || "unknown error"}`));
        if (!initialized) {
          initialized = true;
          send({ method: "initialized", params: {} });
          send({ method: "account/rateLimits/read", id: 1, params: {} });
          send({ method: "account/usage/read", id: 2, params: {} });
        }
      } else if (message?.id === 1) {
        if (message.error) return stop(new Error(`Codex rate limits failed: ${message.error.message || "unknown error"}`));
        rateLimits = message.result || {};
      } else if (message?.id === 2) {
        if (message.error) return stop(new Error(`Codex usage failed: ${message.error.message || "unknown error"}`));
        account = message.result || {};
      }
      if (account && rateLimits) stop(null, { account, rateLimits });
    };

    const timer = setTimeout(() => stop(new Error(`Codex account usage timed out after ${timeoutMs}ms`)), timeoutMs);
    child.once("error", (error) => stop(new Error(`could not start Codex app-server: ${error.message}`)));
    child.stderr.on("data", (chunk) => { if (stderr.length < 4000) stderr += chunk.toString(); });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      let newline;
      while ((newline = stdout.indexOf("\n")) >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        try { onMessage(JSON.parse(line)); } catch { /* ignore non-protocol noise */ }
      }
    });
    child.once("close", (code) => {
      if (!settled) stop(new Error(`Codex app-server exited before usage was ready (code ${code})${stderr ? `: ${stderr.trim().slice(0, 300)}` : ""}`));
    });

    send({ method: "initialize", id: 0, params: { clientInfo: { name: "maxx", version: VERSION } } });
  });
}

function duration(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return "window unknown";
  if (minutes % 10080 === 0) return `${minutes / 10080}w`;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function human(number) {
  const n = Number(number) || 0;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return Math.round(n).toLocaleString("en-US");
}

function resetIn(epochSeconds, now = Date.now()) {
  if (!Number.isFinite(epochSeconds)) return null;
  const minutes = Math.max(0, Math.round((epochSeconds * 1000 - now) / 60000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`;
}

function meter(usedPercent, width = 18) {
  if (!Number.isFinite(usedPercent)) return "░".repeat(width);
  const used = Math.max(0, Math.min(width, Math.round((usedPercent / 100) * width)));
  return "█".repeat(used) + "░".repeat(width - used);
}

function limitLine(label, limit, now) {
  if (!limit) return `  ${label.padEnd(10)} unavailable`;
  const pct = Number.isFinite(limit.usedPercent) ? limit.usedPercent : null;
  const reset = resetIn(limit.resetsAt, now);
  return `  ${label.padEnd(10)} ${meter(pct)}  ${pct == null ? "—" : `${pct.toFixed(0)}%`} used · ${duration(limit.windowMinutes)}${reset ? ` · resets in ${reset}` : ""}`;
}

export function buildUsagePayload(local, live = null, liveError = null) {
  const accountRateLimits = live?.rateLimits?.rateLimits || null;
  return {
    generatedAt: new Date().toISOString(),
    schema: "maxx.codex.usage.v1",
    live: live ? {
      available: true,
      source: "codex-app-server",
      summary: live.account?.summary || null,
      dailyUsageBuckets: Array.isArray(live.account?.dailyUsageBuckets) ? live.account.dailyUsageBuckets : [],
      rateLimits: normalizeAccountRateLimits(accountRateLimits),
      rateLimitsByLimitId: live.rateLimits?.rateLimitsByLimitId || {},
    } : {
      available: false,
      source: null,
      error: liveError?.message || String(liveError || "unavailable"),
    },
    rateLimits: accountRateLimits ? normalizeAccountRateLimits(accountRateLimits) : local.rateLimits,
    local,
  };
}

export function formatUsageCard(payload, now = Date.now()) {
  const local = payload.local;
  const summary = payload.live.available ? payload.live.summary : null;
  const accountHistoryAvailable = Number.isFinite(summary?.lifetimeTokens) && summary.lifetimeTokens > 0;
  const lifetime = accountHistoryAvailable ? summary.lifetimeTokens : local.totals.tokens;
  const lines = [
    "",
    "  ⚡ maxx · codex",
    "  ───────────────────────────────────────────────────────────",
    limitLine("primary", payload.rateLimits?.primary, now),
  ];
  if (payload.rateLimits?.secondary) lines.push(limitLine("secondary", payload.rateLimits.secondary, now));
  lines.push("  ───────────────────────────────────────────────────────────");
  lines.push(`  lifetime tokens   ${human(lifetime)}${accountHistoryAvailable ? "  (Codex account)" : "  (local rollouts)"}`);
  if (accountHistoryAvailable && Number.isFinite(summary?.peakDailyTokens)) lines.push(`  peak day          ${human(summary.peakDailyTokens)}`);
  const streak = accountHistoryAvailable ? summary.currentStreakDays : local.streak;
  const longestStreak = accountHistoryAvailable ? summary.longestStreakDays : local.longestStreak;
  if (Number.isFinite(streak)) lines.push(`  streak            ${streak}d   (longest ${longestStreak || 0}d)`);
  lines.push(`  local cache-hit   ${(local.cacheHitRate * 100).toFixed(1)}%`);
  lines.push(`  local sessions    ${local.sessions}   ·   turns ${local.turns}`);
  if (local.currentContext) {
    const context = local.currentContext;
    lines.push("  ───────────────────────────────────────────────────────────");
    lines.push(`  current context   ${meter(context.usedPercent)}  ${context.usedPercent == null ? "—" : `${context.usedPercent.toFixed(0)}%`} · ${human(context.usedTokens)} / ${human(context.windowTokens)}`);
  }
  if (!payload.live.available) {
    lines.push("  ───────────────────────────────────────────────────────────");
    lines.push("  live account data unavailable · local fallback shown · try /usage");
  }
  lines.push("");
  return lines.join("\n");
}

export async function collectUsage(options = {}) {
  const codexHome = options.codexHome || process.env.CODEX_HOME || path.join(homedir(), ".codex");
  const sessionsDir = path.resolve(options.sessionsDir || path.join(codexHome, "sessions"));
  const contextCwd = path.resolve(options.cwd || process.cwd());
  const cacheRoot = process.env.PLUGIN_DATA || path.join(codexHome, "maxx");
  const cachePath = options.cachePath || path.join(cacheRoot, "usage-cache.json");
  const ttlMs = options.cacheTtlMs ?? Number(process.env.MAXX_CACHE_TTL_MS || 60_000);
  const localPromise = (async () => {
    if (!options.refresh && existsSync(cachePath)) {
      try {
        const cache = JSON.parse(readFileSync(cachePath, "utf8"));
        if (cache?.sessionRoot === sessionsDir && cache?.contextCwd === contextCwd && cache?.stats?.schema === "maxx.codex.stats.v1" && Date.now() - cache.cachedAt <= ttlMs) return cache.stats;
      } catch {}
    }
    const stats = await collectStats({ ...options, sessionsDir, codexHome, cwd: contextCwd });
    try {
      mkdirSync(path.dirname(cachePath), { recursive: true });
      const temporary = `${cachePath}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify({ cachedAt: Date.now(), sessionRoot: sessionsDir, contextCwd, stats }));
      renameSync(temporary, cachePath);
    } catch {}
    return stats;
  })();
  const livePromise = readAccountUsage(options.account || {})
    .then((live) => ({ live, error: null }))
    .catch((error) => ({ live: null, error }));
  const [local, account] = await Promise.all([localPromise, livePromise]);
  return buildUsagePayload(local, account.live, account.error);
}

export async function main(argv = process.argv.slice(2)) {
  const json = argv.includes("json") || argv.includes("--json");
  const dirAt = argv.indexOf("--dir");
  const homeAt = argv.indexOf("--codex-home");
  const payload = await collectUsage({
    sessionsDir: dirAt >= 0 ? argv[dirAt + 1] : undefined,
    codexHome: homeAt >= 0 ? argv[homeAt + 1] : undefined,
    refresh: argv.includes("--refresh"),
  });
  process.stdout.write(json ? `${JSON.stringify(payload, null, 2)}\n` : `${formatUsageCard(payload)}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main().catch((error) => {
  process.stderr.write(`maxx usage: ${error.message}\n`);
  process.exitCode = 1;
});
