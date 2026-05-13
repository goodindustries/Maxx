import { normalizeForMatching } from "./normalize.js";

// ─── token economics ─────────────────────────────────────────────────────────

export function estimateTokens(text) {
  return Math.ceil(text.trim().split(/\s+/).filter(Boolean).length * 1.3);
}

const PROVIDER_RATES = {
  claude:  { label: "Claude Sonnet", usdPerMillion: 3.00 },
  gpt4o:   { label: "GPT-4o",        usdPerMillion: 2.50 },
  gemini:  { label: "Gemini Pro",    usdPerMillion: 1.25 },
};

export function computeEES(rawText, optimizedText) {
  const rawTokens  = estimateTokens(rawText);
  const optTokens  = estimateTokens(optimizedText);
  const delta      = optTokens - rawTokens;

  const providers = {};
  for (const [key, p] of Object.entries(PROVIDER_RATES)) {
    providers[key] = {
      label:      p.label,
      rawCost:    +(rawTokens  / 1_000_000 * p.usdPerMillion).toFixed(6),
      optCost:    +(optTokens  / 1_000_000 * p.usdPerMillion).toFixed(6),
    };
  }

  return { rawTokens, optimizedTokens: optTokens, delta, providers };
}

// ─── PQS dimensions ───────────────────────────────────────────────────────────
// Max: actionability(20) + specificity(20) + clarity(15)
//    + constraints(20)   + context(15)     + outputDefinition(10) = 100

function scoreActionability(text) {
  const strong = (text.match(
    /\b(improve|fix|debug|write|draft|create|generate|build|design|refactor|optimize|analyze|plan|explain|compare|extract|organize|deploy|implement|migrate|convert|review|test|document|restructure|rewrite|summarize|classify|identify|evaluate|transform|integrate|configure|research|investigate|diagnose|repair|validate|sanitize|benchmark)\b/gi,
  ) || []).length;
  const hasWeak   = /\b(make|do|get|help|need|want|give|tell|show|look into|figure out|sort out|check)\b/i.test(text);
  const hasOutput = /\b(return|output|format|list|table|report|summary|draft|code|steps?|outline|document|schema|json|markdown|csv)\b/i.test(text);
  const commas    = (text.match(/,/g) || []).length;

  let score = 6; // base — something intelligible was written
  if (strong >= 3)      score += 11;
  else if (strong === 2) score += 9;
  else if (strong === 1) score += 7;
  else if (hasWeak)      score += 3;

  if (strong >= 1 && commas >= 2) score += 3; // multiple enumerated targets
  if (hasOutput) score += 2;

  return Math.min(20, score);
}

function scoreSpecificity(text) {
  const words = text.trim().split(/\s+/).length;
  let score = 5; // base

  // Length bonus
  if (words >= 40) score += 5;
  else if (words >= 25) score += 4;
  else if (words >= 15) score += 3;
  else if (words >= 8)  score += 1;

  // Technical / domain nouns
  const techCount = (text.match(
    /\b(react|vue|next\.?js|svelte|angular|node\.?js|express|fastapi|django|flask|python|typescript|javascript|golang|rust|java|sql|postgres|postgresql|sqlite|mysql|redis|mongodb|docker|kubernetes|api|rest|graphql|grpc|oauth|jwt|auth|sync|async|cron|webhook|s3|lambda|cloud|mobile|responsive|cta|hero|landing page|conversion|checkout|funnel|dashboard|admin|cms|saas|b2b|enterprise|startup|financial|legal|medical|technical|developer|designer|marketer|manager|user|customer|client|business|whitespace|hierarchy|typography)\b/gi,
  ) || []).length;
  score += Math.min(6, techCount * 2);

  // Numbers / percentages / currencies / file sizes
  const numCount = (text.match(/\b\d+(?:\.\d+)?(?:%|px|ms|kb|mb|gb|s\b)?\b|\$\d+/g) || []).length;
  score += Math.min(3, numCount);

  // Vague-only penalty: very short + only generic adjective + no tech terms
  if (words < 7 && /\b(better|good|nice|improved|great|best|optimal|proper|correct|right|fixed)\b/i.test(text) && techCount === 0) {
    score = Math.max(3, score - 3);
  }

  return Math.min(20, score);
}

function scoreClarity(text) {
  let score = 15;

  const fillerCount = (text.match(
    /\b(hey|hi|hello|yo|please|maybe|probably|sort of|kind of|honestly|frankly|basically|literally|just|simply|obviously|clearly|actually|really)\b/gi,
  ) || []).length;
  score -= Math.min(5, Math.floor(fillerCount * 1.2));

  const hedgeCount = (text.match(
    /\b(might|could|perhaps|possibly|i think|i guess|i feel|not sure|wondering|i was wondering|i'm not sure)\b/gi,
  ) || []).length;
  score -= Math.min(4, hedgeCount);

  // Multiple conflicting conjunctions = rambling
  if (/\b(but|however|although)\b.{0,60}\b(but|however|although)\b/i.test(text)) score -= 3;

  return Math.max(0, Math.min(15, score));
}

function scoreConstraints(text) {
  let score = 5; // base

  const constraintCount = (text.match(
    /\b(must|must not|need|need to|should|should not|don'?t|do not|avoid|only|keep|preserve|without|never|always|ensure|require|limit|exclude|include|restrict|no more than|at least|exactly|specifically)\b/gi,
  ) || []).length;
  score += Math.min(7, constraintCount * 2);

  // Audience spec — "for a developer", "targeting business owners", "aimed at managers"
  if (/\b(for\s+(a |an |the )?[a-z]+(s|er|or|ist)?|targeting\s+[a-z\s]+|aimed at\s+[a-z\s]+|audience:\s*[a-z])\b/i.test(text)) score += 4;
  // Goal / preparation context
  if (/\b(preparing for|working toward|focused on achieving|goal of|in order to|to help|to enable)\b/i.test(text)) score += 3;

  // Scope boundary
  if (/\b(only|specifically|limited to|focused on|in the context of|within|scope)\b/i.test(text)) score += 2;

  // Output format constraint
  if (/\b(format|json|markdown|list|table|report|outline|template|schema|structure)\b/i.test(text)) score += 2;

  return Math.min(20, score);
}

function scoreContext(text) {
  let score = 3; // base

  // Audience
  if (/\b(for\s+(a |an |the )?[a-z]+(s|er|or|ist)?(\s+(team|developer|designer|manager|owner|engineer|user|customer|client|stakeholder))?)\b/i.test(text)) score += 5;

  // Industry / domain
  if (/\b(financial|healthcare|legal|education|e.?commerce|saas|b2b|b2c|enterprise|startup|agency|government|media|tech|retail|hospitality)\b/i.test(text)) score += 4;

  // Platform / environment
  if (/\b(web|mobile|desktop|ios|android|browser|server|cloud|on.?premise|local|production|staging|development|terminal|cli)\b/i.test(text)) score += 3;

  // Timeframe / urgency
  if (/\b(today|tomorrow|this week|next week|by [a-z]+|deadline|asap|urgent|sprint|quarter|end of|before)\b/i.test(text)) score += 3;

  // Prior state / background
  if (/\b(currently|right now|at the moment|we have|we are|we'?ve been|existing|legacy|the current|our [a-z]+)\b/i.test(text)) score += 3;

  return Math.min(15, score);
}

function scoreOutputDefinition(text) {
  let score = 5; // base — implied output always present

  // Explicit output format
  if (/\b(return|output|give me|provide|produce)\b.{0,40}\b(list|table|json|markdown|code|steps?|outline|report|summary|document|draft|schema|comparison|analysis)\b/i.test(text)) score += 5;
  // Implicit output type
  else if (/\b(steps?|instructions?|guide|walkthrough|outline|summary|draft|code|analysis|comparison|plan|strategy|breakdown|roadmap)\b/i.test(text)) score += 3;

  // Enumerated specific targets (e.g. "Improve X, Y, Z and W") — implies well-defined deliverable
  const commas = (text.match(/,/g) || []).length;
  if (commas >= 2 && /\b(improve|fix|optimize|redesign|update|enhance|refactor|address)\b/i.test(text)) score += 3;

  // Success criteria
  if (/\b(success|goal|objective|target|outcome|result|deliverable|expected|i want|we need)\b/i.test(text)) score += 2;

  return Math.min(10, score);
}

// ─── PQS composite ────────────────────────────────────────────────────────────

export function computePQS(text) {
  const dimensions = {
    actionability:    scoreActionability(text),
    specificity:      scoreSpecificity(text),
    clarity:          scoreClarity(text),
    constraints:      scoreConstraints(text),
    context:          scoreContext(text),
    outputDefinition: scoreOutputDefinition(text),
  };
  const score = Object.values(dimensions).reduce((a, b) => a + b, 0);
  return { score, dimensions };
}

// ─── Cognitive Load State ─────────────────────────────────────────────────────

export function computeHCLS({ confidence, problems = [], missing = [] }) {
  const signals = [];

  if (confidence < 0.35) signals.push("unclear intent — classifier not confident");
  if (missing.length > 0) signals.push(`missing context: ${missing.join(", ")}`);
  if (problems.some((p) => p.key === "mixed_objectives"))   signals.push("mixed objectives in one prompt");
  if (problems.some((p) => p.key === "oversized_context"))   signals.push("oversized context — condensing was needed");
  if (problems.some((p) => p.key === "low_confidence"))      signals.push("low classification confidence");
  if (problems.some((p) => p.key === "missing_constraints")) signals.push("missing constraints or environment");

  let state;
  const isLowConf  = confidence < 0.35;
  const hasMixed   = problems.some((p) => p.key === "mixed_objectives");
  const tooMissing = missing.length >= 3;

  if (confidence >= 0.60 && missing.length === 0 && !hasMixed) {
    state = "green";
  } else if (isLowConf || (isLowConf && tooMissing) || (hasMixed && tooMissing)) {
    state = "red";
  } else {
    state = "yellow";
  }

  return { state, signals };
}

// ─── legacy helpers (unchanged API) ──────────────────────────────────────────

export function compareQuality(rawText, optimizedText) {
  const before = computePQS(rawText);
  const after  = computePQS(optimizedText);
  return {
    before: before.score,
    after:  after.score,
    delta:  after.score - before.score,
    deltaPercent: before.score > 0 ? Math.round(((after.score - before.score) / before.score) * 100) : 0,
    dimensions: { before: before.dimensions, after: after.dimensions },
  };
}

export function buildFallbackQuestion({ missing = [], intentLabel = "" } = {}) {
  if (missing.includes("framework"))           return "Which framework should I assume?";
  if (missing.includes("language"))            return "Which language should I assume?";
  if (missing.includes("runtime or environment")) return "What runtime or environment should I optimize for?";
  if (intentLabel) return `What missing detail would make this ${intentLabel.toLowerCase()} prompt executable?`;
  return "What missing detail should I preserve before rewriting this prompt?";
}
