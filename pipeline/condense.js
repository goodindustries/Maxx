import { normalizeForMatching, splitSentences } from "./normalize.js";

const IMPORTANT_PATTERNS = [
  /\b(must|must not|need|need to|don't|do not|should|should not|avoid|only|keep|preserve|without|deadline|budget|audience)\b/i,
  /\b(fix|build|create|rewrite|refactor|compare|decide|plan|research|explain|analyze|debug|extract|organize|implement)\b/i,
  /\b(url|https?:\/\/|www\.|\.com|\.io|\.dev|\.md|\.json|\.ts|\.js|\.py|\.sql)\b/i,
  /\b(\$|€|£|\b\d+(?:\.\d+)?\b)/,
  /\b\d{4}-\d{2}-\d{2}\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\b/i,
];

function scoreSentence(sentence) {
  let score = 0;
  for (const pattern of IMPORTANT_PATTERNS) {
    if (pattern.test(sentence)) {
      score += 2;
    }
  }

  if (/\b(action|goal|problem|issue|constraint|output|deliverable|result|format)\b/i.test(sentence)) {
    score += 1;
  }

  if (sentence.split(/\s+/).length <= 4) {
    score += 1;
  }

  return score;
}

export function condensePrompt(text, options = {}) {
  const sentences = splitSentences(text);
  const seen = new Set();
  const scored = sentences.map((sentence, index) => {
    const key = normalizeForMatching(sentence);
    const score = scoreSentence(sentence);
    return { sentence, index, score, key };
  });

  const kept = scored.filter((item) => {
    if (seen.has(item.key)) {
      return false;
    }
    seen.add(item.key);
    return item.score > 0;
  });

  const maxSentences = options.maxSentences || 5;
  const selected = (kept.length ? kept : scored.slice(0, Math.min(3, scored.length)))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, maxSentences)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.sentence);

  return {
    text: selected.join("\n"),
    sentences: selected,
    keptCount: selected.length,
    droppedCount: Math.max(sentences.length - selected.length, 0),
  };
}
