import { normalizeText, splitSentences } from "./normalize.js";

const LEADIN_PATTERNS = [
  /^(hey|hi|hello|yo)\b[\s,]*/i,
  /^(claude|chatgpt|maxx)\b[\s,]*/i,
  /^(can you|could you|would you|please)\b[\s,]*/i,
  /^(i was wondering(?: if)?|i’m wondering(?: if)?|i am wondering(?: if)?|i need|i want to|im trying to|i’m trying to)\b[\s,]*/i,
];

const HEDGE_PATTERNS = [
  /^(maybe|probably|sort of|kind of|honestly|frankly)\b[\s,]*/i,
  /\b(maybe|probably|sort of|kind of|honestly|frankly)\b(?=,|\s)/gi,
];

function removeLeadIns(sentence) {
  let value = sentence;
  let changed = true;
  let passes = 0;

  while (changed && passes < 4) {
    changed = false;
    passes += 1;
    for (const pattern of LEADIN_PATTERNS) {
      const next = value.replace(pattern, "");
      if (next !== value) {
        value = next;
        changed = true;
      }
    }
  }

  return value.trim();
}

function shouldTrimHedges(sentence) {
  return /\b(action|build|create|fix|compare|decide|recommend|rewrite|refactor|plan|explain|analyze|debug|need|must|should)\b/i.test(
    sentence,
  );
}

function removeHedges(sentence) {
  if (!shouldTrimHedges(sentence)) {
    return sentence;
  }

  let value = sentence;
  for (const pattern of HEDGE_PATTERNS) {
    value = value.replace(pattern, "");
  }
  return value.replace(/\s+/g, " ").replace(/\s+,/g, ",").trim();
}

function cleanSentence(sentence) {
  const leadless = removeLeadIns(sentence);
  const hedgeless = removeHedges(leadless);
  return hedgeless.replace(/\s+/g, " ").trim();
}

export function cleanPromptText(text) {
  const value = normalizeText(text);
  const cleanedSentences = splitSentences(value)
    .map(cleanSentence)
    .filter(Boolean);

  return cleanedSentences.join("\n");
}
