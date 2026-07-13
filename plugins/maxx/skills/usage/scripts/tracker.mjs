#!/usr/bin/env node
/**
 * maxx for Codex -- local, metadata-only usage tracker.
 *
 * Reads JSONL rollouts recursively under CODEX_HOME/sessions and consumes only:
 *   - session_meta identifiers
 *   - turn_context turn ids and model names
 *   - event_msg/token_count usage, context-window, and rate-limit metadata
 *
 * It never reads prompt/message/tool content, performs network requests, or
 * writes files.
 */
import { createReadStream, realpathSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SCHEMA = "maxx.codex.stats.v1";

function finite(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function usageFrom(raw) {
  const input = finite(raw?.input_tokens);
  const cachedInput = finite(raw?.cached_input_tokens);
  const output = finite(raw?.output_tokens);
  const reasoningOutput = finite(raw?.reasoning_output_tokens);
  // Codex includes cached input in input_tokens and reasoning in output_tokens.
  // Prefer its total when present, but never add either subset a second time.
  const tokens = finite(raw?.total_tokens) || input + output;
  return { tokens, input, cachedInput, output, reasoningOutput };
}

function emptyUsage() {
  return { tokens: 0, input: 0, cachedInput: 0, output: 0, reasoningOutput: 0 };
}

function addUsage(target, usage) {
  for (const key of Object.keys(target)) target[key] += usage[key] || 0;
}

function usageDelta(current, previous) {
  if (!previous) return current;
  // A cumulative counter should be monotonic. If an older Codex build resets it
  // mid-file, the caller falls back to last_token_usage instead of adding a
  // second cumulative prefix.
  if (current.tokens < previous.tokens || current.input < previous.input || current.output < previous.output) return null;
  const delta = {};
  for (const key of Object.keys(current)) delta[key] = Math.max(0, current[key] - (previous[key] || 0));
  return delta;
}

function dayOf(timestamp) {
  if (typeof timestamp !== "string") return null;
  const ms = Date.parse(timestamp);
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function timestampMs(timestamp) {
  const ms = typeof timestamp === "string" ? Date.parse(timestamp) : NaN;
  return Number.isFinite(ms) ? ms : -Infinity;
}

function normalizeLimit(raw) {
  if (!raw || typeof raw !== "object") return null;
  const usedPercent = Number.isFinite(raw.used_percent) ? Math.max(0, Math.min(100, raw.used_percent)) : null;
  const windowMinutes = Number.isFinite(raw.window_minutes) && raw.window_minutes > 0 ? raw.window_minutes : null;
  const resetsAt = Number.isFinite(raw.resets_at) && raw.resets_at > 0 ? raw.resets_at : null;
  return {
    usedPercent,
    remainingPercent: usedPercent == null ? null : Math.max(0, 100 - usedPercent),
    windowMinutes,
    resetsAt,
    resetsAtIso: resetsAt == null ? null : new Date(resetsAt * 1000).toISOString(),
  };
}

function normalizeRateLimits(raw, observedAt) {
  if (!raw || typeof raw !== "object") return null;
  return {
    observedAt: typeof observedAt === "string" ? observedAt : null,
    limitId: typeof raw.limit_id === "string" ? raw.limit_id : null,
    limitName: typeof raw.limit_name === "string" ? raw.limit_name : null,
    planType: typeof raw.plan_type === "string" ? raw.plan_type : null,
    reachedType: typeof raw.rate_limit_reached_type === "string" ? raw.rate_limit_reached_type : null,
    primary: normalizeLimit(raw.primary),
    secondary: normalizeLimit(raw.secondary),
  };
}

function emptyBucket() {
  return { ...emptyUsage(), turns: 0 };
}

function computeStreaks(days) {
  const sorted = [...new Set(days)].sort();
  if (!sorted.length) return { current: 0, longest: 0 };
  const dayNumber = (day) => {
    const [year, month, date] = day.split("-").map(Number);
    return Math.floor(Date.UTC(year, month - 1, date) / 86_400_000);
  };
  let longest = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    run = dayNumber(sorted[i]) - dayNumber(sorted[i - 1]) === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  const today = new Date();
  const todayNumber = dayNumber(`${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`);
  const gap = todayNumber - dayNumber(sorted.at(-1));
  let current = 0;
  if (gap <= 1) {
    current = 1;
    for (let i = sorted.length - 1; i > 0; i--) {
      if (dayNumber(sorted[i]) - dayNumber(sorted[i - 1]) !== 1) break;
      current++;
    }
  }
  return { current, longest };
}

function createAccumulator(contextCwd = null) {
  return {
    totals: emptyUsage(),
    sessions: new Set(),
    turns: new Set(),
    days: new Map(),
    models: new Map(),
    latestLimits: null,
    latestLimitsMs: -Infinity,
    latestContext: null,
    latestContextMs: -Infinity,
    fallbackContext: null,
    fallbackContextMs: -Infinity,
    contextCwd: contextCwd ? path.resolve(contextCwd) : null,
  };
}

export async function findSessionFiles(root) {
  const found = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(full);
    }
  }
  await walk(root);
  return found.sort();
}

function modelBucket(acc, model) {
  const key = model || "unknown";
  if (!acc.models.has(key)) acc.models.set(key, emptyBucket());
  return acc.models.get(key);
}

function dayBucket(acc, day) {
  if (!acc.days.has(day)) acc.days.set(day, emptyBucket());
  return acc.days.get(day);
}

function ingestRecord(record, acc, fileState) {
  if (!record || typeof record !== "object") return;

  if (record.type === "session_meta") {
    const id = record.payload?.session_id || record.payload?.id;
    if (typeof id === "string" && id) {
      fileState.sessionId = id;
      acc.sessions.add(id);
    }
    if (typeof record.payload?.cwd === "string" && record.payload.cwd) fileState.cwd = path.resolve(record.payload.cwd);
    return;
  }

  if (record.type === "turn_context") {
    const payload = record.payload || {};
    if (typeof payload.model === "string" && payload.model) fileState.model = payload.model;
    const fallback = `${fileState.fileKey}:${record.timestamp || fileState.syntheticTurn++}`;
    const turnId = typeof payload.turn_id === "string" && payload.turn_id ? payload.turn_id : fallback;
    if (!acc.turns.has(turnId)) {
      acc.turns.add(turnId);
      modelBucket(acc, fileState.model).turns += 1;
      const day = dayOf(record.timestamp);
      if (day) dayBucket(acc, day).turns += 1;
    }
    return;
  }

  if (record.type !== "event_msg" || record.payload?.type !== "token_count") return;

  // A file without session_meta still represents one local session. Keep only
  // an opaque internal fallback; file paths never enter the returned payload.
  if (!fileState.sessionId) {
    fileState.sessionId = fileState.fileKey;
    acc.sessions.add(fileState.sessionId);
  }

  const info = record.payload?.info;
  const at = record.timestamp;
  const atMs = timestampMs(at);

  const lastUsage = info?.last_token_usage && typeof info.last_token_usage === "object"
    ? usageFrom(info.last_token_usage)
    : null;
  let aggregateUsage = null;
  if (info?.total_token_usage && typeof info.total_token_usage === "object") {
    const cumulative = usageFrom(info.total_token_usage);
    aggregateUsage = usageDelta(cumulative, fileState.cumulativeUsage) || lastUsage;
    fileState.cumulativeUsage = cumulative;
  } else {
    aggregateUsage = lastUsage;
  }

  if (aggregateUsage?.tokens > 0) {
    addUsage(acc.totals, aggregateUsage);
    addUsage(modelBucket(acc, fileState.model), aggregateUsage);
    const day = dayOf(at);
    if (day) addUsage(dayBucket(acc, day), aggregateUsage);
  }

  if (lastUsage) {
    const windowTokens = finite(info.model_context_window) || null;
    const context = {
      observedAt: typeof at === "string" ? at : null,
      model: fileState.model || "unknown",
      usedTokens: lastUsage.tokens,
      inputTokens: lastUsage.input,
      outputTokens: lastUsage.output,
      windowTokens,
      usedPercent: windowTokens ? Number(((lastUsage.tokens / windowTokens) * 100).toFixed(2)) : null,
    };
    if (atMs >= acc.fallbackContextMs) {
      acc.fallbackContextMs = atMs;
      acc.fallbackContext = context;
    }
    const matchesWorkspace = !acc.contextCwd || (fileState.cwd && fileState.cwd === acc.contextCwd);
    if (matchesWorkspace && atMs >= acc.latestContextMs) {
      acc.latestContextMs = atMs;
      acc.latestContext = context;
    }
  }

  if (record.payload?.rate_limits && atMs >= acc.latestLimitsMs) {
    acc.latestLimitsMs = atMs;
    acc.latestLimits = normalizeRateLimits(record.payload.rate_limits, at);
  }
}

async function ingestFile(file, acc, fileKey) {
  const state = { fileKey, sessionId: null, model: "unknown", cwd: null, syntheticTurn: 0, cumulativeUsage: null };
  let input;
  try {
    input = createReadStream(file, { encoding: "utf8" });
  } catch {
    return;
  }
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line || line[0] !== "{") continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      ingestRecord(record, acc, state);
    }
  } catch {
    // A disappearing or unreadable session file must not break all stats.
  }
}

/** Parse one rollout file into the same stable stats shape as collectStats. */
export async function parseSessionFile(file) {
  const acc = createAccumulator();
  await ingestFile(file, acc, "session-1");
  return finalize(acc);
}

function finalize(acc) {
  const perDay = [...acc.days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, values]) => ({ day, ...values }));
  const models = [...acc.models.entries()]
    .map(([model, values]) => ({ model, ...values }))
    .sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model));
  const activeDays = perDay.filter((day) => day.tokens > 0).length;
  const streaks = computeStreaks(perDay.filter((day) => day.tokens > 0).map((day) => day.day));
  return {
    generatedAt: new Date().toISOString(),
    schema: SCHEMA,
    totals: { ...acc.totals },
    cacheHitRate: acc.totals.input > 0
      ? Number((acc.totals.cachedInput / acc.totals.input).toFixed(4))
      : 0,
    sessions: acc.sessions.size,
    turns: acc.turns.size,
    activeDays,
    tokensPerActiveDay: activeDays ? Math.round(acc.totals.tokens / activeDays) : 0,
    streak: streaks.current,
    longestStreak: streaks.longest,
    firstDay: perDay.find((day) => day.tokens > 0)?.day || null,
    lastDay: [...perDay].reverse().find((day) => day.tokens > 0)?.day || null,
    currentContext: acc.contextCwd ? acc.latestContext : (acc.latestContext || acc.fallbackContext),
    rateLimits: acc.latestLimits,
    models,
    perDay,
  };
}

/** Collect Codex usage from a sessions directory. */
export async function collectStats(options = {}) {
  if (typeof options === "string") options = { sessionsDir: options };
  const codexHome = options.codexHome || process.env.CODEX_HOME || path.join(homedir(), ".codex");
  const root = options.sessionsDir || path.join(codexHome, "sessions");
  const files = await findSessionFiles(root);
  const acc = createAccumulator(options.cwd || null);
  for (let i = 0; i < files.length; i++) await ingestFile(files[i], acc, `session-${i + 1}`);
  return finalize(acc);
}

function human(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n || 0));
}

function duration(minutes) {
  if (!Number.isFinite(minutes)) return "unknown window";
  if (minutes % 10080 === 0) return `${minutes / 10080}w`;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function limitLine(label, limit) {
  if (!limit) return `  ${label.padEnd(11)} unavailable`;
  const used = limit.usedPercent == null ? "—" : `${limit.usedPercent.toFixed(0)}% used`;
  const reset = limit.resetsAtIso ? ` · resets ${limit.resetsAtIso}` : "";
  return `  ${label.padEnd(11)} ${used} · ${duration(limit.windowMinutes)}${reset}`;
}

export function formatCard(stats) {
  const lines = [
    "",
    "  ⚡ maxx · codex",
    "  ─────────────────────────────────────────",
    `  total tokens      ${human(stats.totals.tokens)}`,
    `  cache-hit         ${(stats.cacheHitRate * 100).toFixed(1)}%`,
    `  active days       ${stats.activeDays}`,
    `  streak            ${stats.streak}d   (longest ${stats.longestStreak}d)`,
    `  sessions          ${stats.sessions}`,
    `  turns             ${stats.turns}`,
  ];
  if (stats.currentContext) {
    const c = stats.currentContext;
    lines.push("  ─────────────────────────────────────────");
    lines.push(`  context           ${human(c.usedTokens)} / ${human(c.windowTokens || 0)}${c.usedPercent == null ? "" : `  (${c.usedPercent.toFixed(1)}%)`}`);
  }
  lines.push("  ─────────────────────────────────────────");
  lines.push(limitLine("primary", stats.rateLimits?.primary));
  if (stats.rateLimits?.secondary) lines.push(limitLine("secondary", stats.rateLimits.secondary));
  lines.push("");
  return lines.join("\n");
}

export function parseArgs(argv) {
  const out = { json: false, sessionsDir: null, codexHome: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "json" || arg === "--json") out.json = true;
    else if (arg === "--dir") out.sessionsDir = argv[++i] || null;
    else if (arg === "--codex-home") out.codexHome = argv[++i] || null;
  }
  return out;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const stats = await collectStats({ sessionsDir: args.sessionsDir, codexHome: args.codexHome });
  process.stdout.write(args.json ? `${JSON.stringify(stats, null, 2)}\n` : `${formatCard(stats)}\n`);
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((error) => {
    process.stderr.write(`maxx: ${error.message}\n`);
    process.exitCode = 1;
  });
}
