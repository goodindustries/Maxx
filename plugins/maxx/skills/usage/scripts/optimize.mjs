#!/usr/bin/env node
/** Codex session context/cache optimizer. Metadata only; no pricing guesses. */
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findSessionFiles } from "./tracker.mjs";

function positive(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

async function rolloutCwd(file) {
  let handle;
  try {
    handle = await open(file, "r");
    const buffer = Buffer.alloc(1024 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const prefix = buffer.toString("utf8", 0, bytesRead);
    for (const line of prefix.split("\n")) {
      if (!line.startsWith("{")) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record.type === "session_meta" && typeof record.payload?.cwd === "string") return path.resolve(record.payload.cwd);
    }
    // session_meta can be a very large single JSONL record. Its cwd is near
    // the front in current Codex builds, so recover that one JSON string even
    // when the record extends beyond this bounded prefix.
    if (/"type"\s*:\s*"session_meta"/.test(prefix)) {
      const match = prefix.match(/"cwd"\s*:\s*"((?:\\.|[^"\\])*)"/);
      if (match) {
        try { return path.resolve(JSON.parse(`"${match[1]}"`)); } catch {}
      }
    }
  } catch {}
  finally { try { await handle?.close(); } catch {} }
  return null;
}

export async function newestSession(sessionsDir, workspaceCwd = null) {
  const candidates = [];
  for (const file of await findSessionFiles(sessionsDir)) {
    try {
      const info = await stat(file);
      candidates.push({ file, mtimeMs: info.mtimeMs });
    } catch {}
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (workspaceCwd) {
    const wanted = path.resolve(workspaceCwd);
    for (const candidate of candidates) if (await rolloutCwd(candidate.file) === wanted) return candidate.file;
    return null;
  }
  return candidates[0]?.file || null;
}

export async function readSessionSeries(file) {
  const events = [];
  let model = "unknown";
  let project = "current project";
  let cumulative = null;
  let input;
  try { input = createReadStream(file, { encoding: "utf8" }); }
  catch { return { project, events }; }
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line || line[0] !== "{") continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record.type === "session_meta") {
      const cwd = record.payload?.cwd;
      if (typeof cwd === "string" && cwd) project = path.basename(cwd);
    } else if (record.type === "turn_context") {
      if (typeof record.payload?.model === "string") model = record.payload.model;
    } else if (record.type === "event_msg" && record.payload?.type === "token_count") {
      const info = record.payload?.info;
      const usage = info?.last_token_usage;
      if (!usage || typeof usage !== "object") continue;
      const timestamp = Date.parse(record.timestamp);
      const contextInputTokens = positive(usage.input_tokens);
      const contextOutputTokens = positive(usage.output_tokens);
      const total = info.total_token_usage && typeof info.total_token_usage === "object" ? {
        inputTokens: positive(info.total_token_usage.input_tokens),
        cachedInputTokens: positive(info.total_token_usage.cached_input_tokens),
        outputTokens: positive(info.total_token_usage.output_tokens),
        reasoningOutputTokens: positive(info.total_token_usage.reasoning_output_tokens),
        totalTokens: positive(info.total_token_usage.total_tokens),
      } : null;
      let measured;
      if (total && cumulative && total.totalTokens >= cumulative.totalTokens) {
        measured = Object.fromEntries(Object.keys(total).map((key) => [key, Math.max(0, total[key] - cumulative[key])]));
      } else if (total && !cumulative) {
        measured = total;
      } else {
        measured = {
          inputTokens: contextInputTokens,
          cachedInputTokens: positive(usage.cached_input_tokens),
          outputTokens: contextOutputTokens,
          reasoningOutputTokens: positive(usage.reasoning_output_tokens),
          totalTokens: positive(usage.total_tokens) || contextInputTokens + contextOutputTokens,
        };
      }
      if (total) cumulative = total;
      if (measured.totalTokens <= 0) continue; // repeated cumulative notification
      events.push({
        timestamp: Number.isFinite(timestamp) ? timestamp : null,
        model,
        inputTokens: measured.inputTokens,
        cachedInputTokens: Math.min(measured.inputTokens, measured.cachedInputTokens),
        outputTokens: measured.outputTokens,
        reasoningOutputTokens: Math.min(measured.outputTokens, measured.reasoningOutputTokens),
        totalTokens: measured.totalTokens || measured.inputTokens + measured.outputTokens,
        contextInputTokens,
        contextOutputTokens,
        contextWindow: positive(info.model_context_window) || null,
      });
    }
  }
  return { project, events };
}

export function analyzeSession({ project, events }) {
  if (!events.length) return null;
  const totals = events.reduce((acc, event) => {
    acc.tokens += event.totalTokens;
    acc.input += event.inputTokens;
    acc.cachedInput += event.cachedInputTokens;
    acc.output += event.outputTokens;
    acc.reasoningOutput += event.reasoningOutputTokens;
    return acc;
  }, { tokens: 0, input: 0, cachedInput: 0, output: 0, reasoningOutput: 0 });
  const timed = events.filter((event) => Number.isFinite(event.timestamp));
  const durationMs = timed.length > 1 ? Math.max(0, timed.at(-1).timestamp - timed[0].timestamp) : 0;
  const latest = events.at(-1);
  const contextWindow = latest.contextWindow || [...events].reverse().find((event) => event.contextWindow)?.contextWindow || null;
  const contextSize = (event) => (event.contextInputTokens ?? event.inputTokens) + (event.contextOutputTokens ?? event.outputTokens);
  const currentContext = contextSize(latest);
  const currentPercent = contextWindow ? currentContext / contextWindow : null;
  const peakContext = Math.max(...events.map(contextSize));
  const cacheHitRate = totals.input ? totals.cachedInput / totals.input : 0;

  const recent = events.slice(-10).map((event) => event.contextInputTokens ?? event.inputTokens);
  const positiveGrowth = [];
  for (let i = 1; i < recent.length; i++) {
    const delta = recent[i] - recent[i - 1];
    if (delta > 0) positiveGrowth.push(delta);
  }
  const growthPerCall = positiveGrowth.length
    ? positiveGrowth.reduce((sum, value) => sum + value, 0) / positiveGrowth.length
    : 0;
  const target = contextWindow ? contextWindow * 0.8 : null;
  const callsToEightyPercent = target && growthPerCall > 0
    ? Math.max(0, Math.floor((target - currentContext) / growthPerCall))
    : null;

  const recommendations = [];
  if (currentPercent != null && currentPercent >= 0.8) {
    recommendations.push({ severity: "high", title: "Compact at the next clean boundary", detail: `Context is ${(currentPercent * 100).toFixed(0)}% full.` });
  } else if (currentPercent != null && currentPercent >= 0.65) {
    recommendations.push({ severity: "medium", title: "Plan the next compact", detail: `Context is ${(currentPercent * 100).toFixed(0)}% full; finish the current unit before switching tasks.` });
  } else {
    recommendations.push({ severity: "ok", title: "Context runway is healthy", detail: currentPercent == null ? "Codex did not report a context-window size." : `Context is ${(currentPercent * 100).toFixed(0)}% full.` });
  }
  if (events.length >= 4 && cacheHitRate < 0.5) {
    recommendations.push({ severity: "medium", title: "Keep related work in one thread", detail: `Local cache reuse is ${(cacheHitRate * 100).toFixed(0)}%; task switching and cold starts can reduce reuse.` });
  }
  if (callsToEightyPercent != null && callsToEightyPercent <= 3 && currentPercent < 0.8) {
    recommendations.push({ severity: "medium", title: "A context boundary is close", detail: `At the recent growth rate, 80% is about ${callsToEightyPercent} model call${callsToEightyPercent === 1 ? "" : "s"} away.` });
  }

  return {
    generatedAt: new Date().toISOString(),
    schema: "maxx.codex.optimize.v1",
    project,
    calls: events.length,
    durationMs,
    totals,
    cacheHitRate: Number(cacheHitRate.toFixed(4)),
    context: {
      currentTokens: currentContext,
      peakTokens: peakContext,
      windowTokens: contextWindow,
      usedPercent: currentPercent == null ? null : Number((currentPercent * 100).toFixed(2)),
      growthPerCall: Math.round(growthPerCall),
      callsToEightyPercent,
    },
    recommendations,
  };
}

function human(number) {
  const n = Number(number) || 0;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

function duration(ms) {
  const minutes = Math.round((ms || 0) / 60000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}

function bar(percent, width = 18) {
  if (!Number.isFinite(percent)) return "░".repeat(width);
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

export function formatOptimization(report) {
  const context = report.context;
  const lines = [
    "",
    "  ⚡ maxx · codex optimizer",
    `  ${report.project} · ${report.calls} model calls · ${duration(report.durationMs)}`,
    "  ───────────────────────────────────────────────────────────",
    `  context      ${bar(context.usedPercent)}  ${context.usedPercent == null ? "—" : `${context.usedPercent.toFixed(0)}%`} · ${human(context.currentTokens)} / ${human(context.windowTokens)}`,
    `  cache-hit    ${(report.cacheHitRate * 100).toFixed(0)}%`,
    `  tokens       ${human(report.totals.tokens)}  (${human(report.totals.input)} in · ${human(report.totals.output)} out)`,
  ];
  if (context.callsToEightyPercent != null) lines.push(`  runway      ~${context.callsToEightyPercent} calls to 80% at recent growth`);
  lines.push("  ───────────────────────────────────────────────────────────");
  for (const item of report.recommendations) lines.push(`  → ${item.title} — ${item.detail}`);
  lines.push("");
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  const json = argv.includes("json") || argv.includes("--json");
  const dirAt = argv.indexOf("--dir");
  const codexHome = process.env.CODEX_HOME || path.join(homedir(), ".codex");
  const sessionsDir = dirAt >= 0 ? argv[dirAt + 1] : path.join(codexHome, "sessions");
  const file = await newestSession(sessionsDir, process.cwd());
  if (!file) throw new Error(`no Codex session rollouts found under ${sessionsDir}`);
  const report = analyzeSession(await readSessionSeries(file));
  if (!report) throw new Error("the latest Codex session has no token metadata yet");
  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : `${formatOptimization(report)}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main().catch((error) => {
  process.stderr.write(`maxx optimize: ${error.message}\n`);
  process.exitCode = 1;
});
