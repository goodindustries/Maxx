import { normalizeForMatching } from "./normalize.js";

function countMatches(text, patterns) {
  return patterns.reduce((sum, pattern) => sum + (pattern.test(text) ? 1 : 0), 0);
}

function baseMetrics(text) {
  const normalized = normalizeForMatching(text);
  const tokens = normalized.match(/\b[\p{L}\p{N}_]+\b/gu) || [];
  const constraints = countMatches(normalized, [
    /\b(must|must not|need|need to|don't|do not|avoid|only|keep|preserve|without|deadline|budget|audience)\b/i,
  ]);
  const actionWords = countMatches(normalized, [
    /\b(fix|build|create|rewrite|refactor|compare|decide|plan|research|explain|analyze|debug|extract|organize|implement|recommend)\b/i,
  ]);
  const explicitOutput = countMatches(normalized, [
    /\b(output|deliverable|return|provide|recommend|steps|plan|patch|rewrite|explain|answer)\b/i,
  ]);
  const specificity = countMatches(normalized, [
    /\b(https?:\/\/|www\.|\.com|\.io|\.dev|\.md|\.json|\.ts|\.js|\.py|\.sql)\b/i,
    /\b\d{4}-\d{2}-\d{2}\b/i,
    /\b(\$|€|£|\b\d+(?:\.\d+)?\b)/i,
  ]);
  const noise = countMatches(normalized, [
    /\b(hey|hi|hello|yo|please|maybe|probably|sort of|kind of|honestly|frankly|ugh)\b/i,
  ]);

  return {
    length: tokens.length,
    constraints,
    actionWords,
    explicitOutput,
    specificity,
    noise,
  };
}

export function scorePromptQuality(text) {
  const metrics = baseMetrics(text);
  const clarity = Math.max(0, 100 - metrics.noise * 12 - (metrics.length > 120 ? 18 : 0));
  const specificity = Math.min(100, 18 + metrics.specificity * 18 + metrics.constraints * 8);
  const format = Math.min(100, 20 + metrics.explicitOutput * 18);
  const missingContext = Math.max(0, 100 - (metrics.constraints * 20 + metrics.specificity * 10));
  const actionability = Math.min(100, 20 + metrics.actionWords * 15 + metrics.explicitOutput * 12);

  return {
    clarity,
    specificity,
    outputFormat: format,
    missingContext,
    actionability,
  };
}

export function compareQuality(beforeText, afterText) {
  const before = scorePromptQuality(beforeText);
  const after = scorePromptQuality(afterText);

  return {
    before,
    after,
    delta: {
      clarity: after.clarity - before.clarity,
      specificity: after.specificity - before.specificity,
      outputFormat: after.outputFormat - before.outputFormat,
      missingContext: after.missingContext - before.missingContext,
      actionability: after.actionability - before.actionability,
    },
  };
}

export function buildFallbackQuestion({ missing = [], intentLabel = "" } = {}) {
  if (missing.includes("framework")) {
    return "Which framework should I assume?";
  }
  if (missing.includes("language")) {
    return "Which language should I assume?";
  }
  if (missing.includes("runtime or environment")) {
    return "What runtime or environment should I optimize for?";
  }
  if (intentLabel) {
    return `What missing detail would make this ${intentLabel.toLowerCase()} prompt executable?`;
  }
  return "What missing detail should I preserve before rewriting this prompt?";
}
