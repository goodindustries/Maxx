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

// ─── PQS dimensions (trace-aware) ────────────────────────────────────────────

function scoreActionabilityTrace(text) {
  const rules = [];
  const strong = (text.match(
    /\b(improve|fix|debug|write|draft|create|generate|build|design|refactor|optimize|analyze|plan|explain|compare|extract|organize|deploy|implement|migrate|convert|review|test|document|restructure|rewrite|summarize|classify|identify|evaluate|transform|integrate|configure|research|investigate|diagnose|repair|validate|sanitize|benchmark)\b/gi,
  ) || []).length;
  const hasWeak   = /\b(make|do|get|help|need|want|give|tell|show|look into|figure out|sort out|check)\b/i.test(text);
  const hasOutput = /\b(return|output|format|list|table|report|summary|draft|code|steps?|outline|document|schema|json|markdown|csv)\b/i.test(text);
  const commas    = (text.match(/,/g) || []).length;

  let score = 6;
  if (strong >= 3)       { score += 11; rules.push(`strong verbs ×${strong} (+11)`); }
  else if (strong === 2) { score += 9;  rules.push(`strong verbs ×2 (+9)`); }
  else if (strong === 1) { score += 7;  rules.push(`strong verb ×1 (+7)`); }
  else if (hasWeak)      { score += 3;  rules.push(`weak verb only (+3)`); }
  else                   {              rules.push(`no action verb (base 6 only)`); }

  if (strong >= 1 && commas >= 2) { score += 3; rules.push(`enumerated targets (+3)`); }
  if (hasOutput)                  { score += 2; rules.push(`output keyword (+2)`); }

  return { score: Math.min(20, score), rules };
}

function scoreSpecificityTrace(text) {
  const rules = [];
  const words = text.trim().split(/\s+/).length;
  let score = 5;

  if (words >= 40)      { score += 5; rules.push(`≥40 words (+5)`); }
  else if (words >= 25) { score += 4; rules.push(`≥25 words (+4)`); }
  else if (words >= 15) { score += 3; rules.push(`≥15 words (+3)`); }
  else if (words >= 8)  { score += 1; rules.push(`≥8 words (+1)`); }
  else                  {             rules.push(`<8 words (no length bonus)`); }

  const techCount = (text.match(
    /\b(react|vue|next\.?js|svelte|angular|node\.?js|express|fastapi|django|flask|python|typescript|javascript|golang|rust|java|sql|postgres|postgresql|sqlite|mysql|redis|mongodb|docker|kubernetes|api|rest|graphql|grpc|oauth|jwt|auth|sync|async|cron|webhook|s3|lambda|cloud|mobile|responsive|cta|hero|landing page|conversion|checkout|funnel|dashboard|admin|cms|saas|b2b|enterprise|startup|financial|legal|medical|technical|developer|designer|marketer|manager|user|customer|client|business|whitespace|hierarchy|typography)\b/gi,
  ) || []).length;
  const techBonus = Math.min(6, techCount * 2);
  if (techBonus > 0) { score += techBonus; rules.push(`tech terms ×${techCount} (+${techBonus})`); }
  else               { rules.push(`no tech terms`); }

  const numCount = (text.match(/\b\d+(?:\.\d+)?(?:%|px|ms|kb|mb|gb|s\b)?\b|\$\d+/g) || []).length;
  const numBonus = Math.min(3, numCount);
  if (numBonus > 0) { score += numBonus; rules.push(`numbers/units ×${numCount} (+${numBonus})`); }

  if (words < 7 && /\b(better|good|nice|improved|great|best|optimal|proper|correct|right|fixed)\b/i.test(text) && techCount === 0) {
    score = Math.max(3, score - 3);
    rules.push(`vague-only penalty (-3)`);
  }

  return { score: Math.min(20, score), rules };
}

function scoreClarityTrace(text) {
  const rules = [];
  let score = 15;

  const fillerCount = (text.match(
    /\b(hey|hi|hello|yo|please|maybe|probably|sort of|kind of|honestly|frankly|basically|literally|just|simply|obviously|clearly|actually|really)\b/gi,
  ) || []).length;
  const fillerDock = Math.min(5, Math.floor(fillerCount * 1.2));
  if (fillerDock > 0) { score -= fillerDock; rules.push(`filler words ×${fillerCount} (-${fillerDock})`); }

  const hedgeCount = (text.match(
    /\b(might|could|perhaps|possibly|i think|i guess|i feel|not sure|wondering|i was wondering|i'm not sure)\b/gi,
  ) || []).length;
  const hedgeDock = Math.min(4, hedgeCount);
  if (hedgeDock > 0) { score -= hedgeDock; rules.push(`hedge phrases ×${hedgeCount} (-${hedgeDock})`); }

  if (/\b(but|however|although)\b.{0,60}\b(but|however|although)\b/i.test(text)) {
    score -= 3;
    rules.push(`conflicting conjunctions (-3)`);
  }

  if (rules.length === 0) rules.push(`no deductions (baseline 15)`);

  return { score: Math.max(0, Math.min(15, score)), rules };
}

function scoreConstraintsTrace(text) {
  const rules = [];
  let score = 5;

  const constraintCount = (text.match(
    /\b(must|must not|need|need to|should|should not|don'?t|do not|avoid|only|keep|preserve|without|never|always|ensure|require|limit|exclude|include|restrict|no more than|at least|exactly|specifically)\b/gi,
  ) || []).length;
  const constraintBonus = Math.min(7, constraintCount * 2);
  if (constraintBonus > 0) { score += constraintBonus; rules.push(`constraint keywords ×${constraintCount} (+${constraintBonus})`); }

  if (/\b(for\s+(a |an |the )?[a-z]+(s|er|or|ist)?|targeting\s+[a-z\s]+|aimed at\s+[a-z\s]+|audience:\s*[a-z])\b/i.test(text)) {
    score += 4;
    rules.push(`audience spec (+4)`);
  }
  if (/\b(preparing for|working toward|focused on achieving|goal of|in order to|to help|to enable)\b/i.test(text)) {
    score += 3;
    rules.push(`goal context (+3)`);
  }
  if (/\b(only|specifically|limited to|focused on|in the context of|within|scope)\b/i.test(text)) {
    score += 2;
    rules.push(`scope boundary (+2)`);
  }
  if (/\b(format|json|markdown|list|table|report|outline|template|schema|structure)\b/i.test(text)) {
    score += 2;
    rules.push(`output format constraint (+2)`);
  }

  if (rules.length === 0) rules.push(`no constraint signals (base 5 only)`);

  return { score: Math.min(20, score), rules };
}

function scoreContextTrace(text) {
  const rules = [];
  let score = 3;

  if (/\b(for\s+(a |an |the )?[a-z]+(s|er|or|ist)?(\s+(team|developer|designer|manager|owner|engineer|user|customer|client|stakeholder))?)\b/i.test(text)) {
    score += 5;
    rules.push(`audience specified (+5)`);
  }
  if (/\b(financial|healthcare|legal|education|e.?commerce|saas|b2b|b2c|enterprise|startup|agency|government|media|tech|retail|hospitality)\b/i.test(text)) {
    score += 4;
    rules.push(`industry/domain (+4)`);
  }
  if (/\b(web|mobile|desktop|ios|android|browser|server|cloud|on.?premise|local|production|staging|development|terminal|cli)\b/i.test(text)) {
    score += 3;
    rules.push(`platform/environment (+3)`);
  }
  if (/\b(today|tomorrow|this week|next week|by [a-z]+|deadline|asap|urgent|sprint|quarter|end of|before)\b/i.test(text)) {
    score += 3;
    rules.push(`timeframe/urgency (+3)`);
  }
  if (/\b(currently|right now|at the moment|we have|we are|we'?ve been|existing|legacy|the current|our [a-z]+)\b/i.test(text)) {
    score += 3;
    rules.push(`prior state/background (+3)`);
  }

  if (rules.length === 0) rules.push(`no context signals (base 3 only)`);

  return { score: Math.min(15, score), rules };
}

function scoreOutputDefinitionTrace(text) {
  const rules = [];
  let score = 5;

  if (/\b(return|output|give me|provide|produce)\b.{0,40}\b(list|table|json|markdown|code|steps?|outline|report|summary|document|draft|schema|comparison|analysis)\b/i.test(text)) {
    score += 5;
    rules.push(`explicit output format (+5)`);
  } else if (/\b(steps?|instructions?|guide|walkthrough|outline|summary|draft|code|analysis|comparison|plan|strategy|breakdown|roadmap)\b/i.test(text)) {
    score += 3;
    rules.push(`implicit output type (+3)`);
  } else {
    rules.push(`implied output only (base 5)`);
  }

  const commas = (text.match(/,/g) || []).length;
  if (commas >= 2 && /\b(improve|fix|optimize|redesign|update|enhance|refactor|address)\b/i.test(text)) {
    score += 3;
    rules.push(`enumerated targets (+3)`);
  }

  if (/\b(success|goal|objective|target|outcome|result|deliverable|expected|i want|we need)\b/i.test(text)) {
    score += 2;
    rules.push(`success criteria (+2)`);
  }

  // Markdown bullet list = structured output request even without explicit format keyword
  const bulletCount = (text.match(/(?:^|\n)\s*[-*•]\s+\S/g) || []).length;
  if (bulletCount >= 3) {
    score += 3;
    rules.push(`bullet list ×${bulletCount} (+3)`);
  } else if (bulletCount >= 2) {
    score += 2;
    rules.push(`bullet list ×${bulletCount} (+2)`);
  }

  return { score: Math.min(10, score), rules };
}

// ─── PQS composite ────────────────────────────────────────────────────────────

export function computePQSTrace(text) {
  const a  = scoreActionabilityTrace(text);
  const s  = scoreSpecificityTrace(text);
  const cl = scoreClarityTrace(text);
  const co = scoreConstraintsTrace(text);
  const cx = scoreContextTrace(text);
  const o  = scoreOutputDefinitionTrace(text);

  const dimensions = {
    actionability:    a.score,
    specificity:      s.score,
    clarity:          cl.score,
    constraints:      co.score,
    context:          cx.score,
    outputDefinition: o.score,
  };
  const score = Object.values(dimensions).reduce((a, b) => a + b, 0);

  const rulesFired = {
    actionability:    a.rules,
    specificity:      s.rules,
    clarity:          cl.rules,
    constraints:      co.rules,
    context:          cx.rules,
    outputDefinition: o.rules,
  };

  return { score, dimensions, rulesFired };
}

export function computePQS(text) {
  const { score, dimensions } = computePQSTrace(text);
  return { score, dimensions };
}

// ─── Cognitive Load State ─────────────────────────────────────────────────────

export function computeHCLS({ confidence, problems = [], missing = [] }) {
  const signals = [];

  if (confidence < 0.35) signals.push("unclear intent — classifier not confident");
  if (missing.length > 0) signals.push(`missing context: ${missing.join(", ")}`);
  if (problems.some((p) => p.key === "mixed_objectives"))   signals.push("mixed objectives in one prompt");
  if (problems.some((p) => p.key === "oversized_context"))  signals.push("oversized context — condensing was needed");
  if (problems.some((p) => p.key === "low_confidence"))     signals.push("low classification confidence");
  if (problems.some((p) => p.key === "missing_constraints")) signals.push("missing constraints or environment");

  let state;
  const isLowConf  = confidence < 0.35;
  const hasMixed   = problems.some((p) => p.key === "mixed_objectives");
  const tooMissing = missing.length >= 3;

  if (confidence >= 0.60 && missing.length === 0 && !hasMixed) {
    state = "green";
  } else if (isLowConf || (hasMixed && tooMissing)) {
    state = "red";
  } else {
    state = "yellow";
  }

  return { state, signals };
}

// ─── legacy helpers (unchanged API) ──────────────────────────────────────────

export function compareQuality(rawText, optimizedText) {
  const beforeTrace = computePQSTrace(rawText);
  const afterTrace  = computePQSTrace(optimizedText);

  const dimensionDelta = {};
  for (const key of Object.keys(beforeTrace.dimensions)) {
    dimensionDelta[key] = afterTrace.dimensions[key] - beforeTrace.dimensions[key];
  }

  return {
    before:       beforeTrace.score,
    after:        afterTrace.score,
    delta:        afterTrace.score - beforeTrace.score,
    deltaPercent: beforeTrace.score > 0
      ? Math.round(((afterTrace.score - beforeTrace.score) / beforeTrace.score) * 100)
      : 0,
    dimensions: { before: beforeTrace.dimensions, after: afterTrace.dimensions },
    dimensionDelta,
    trace: { before: beforeTrace.rulesFired, after: afterTrace.rulesFired },
  };
}

export function buildFallbackQuestion({ missing = [], intentLabel = "" } = {}) {
  if (missing.includes("framework"))              return "Which framework should I assume?";
  if (missing.includes("language"))               return "Which language should I assume?";
  if (missing.includes("runtime or environment")) return "What runtime or environment should I optimize for?";
  if (intentLabel) return `What missing detail would make this ${intentLabel.toLowerCase()} prompt executable?`;
  return "What missing detail should I preserve before rewriting this prompt?";
}

export function buildClarifyingQuestion(rawText) {
  if (/\b(website|site|page|landing.?page|homepage)\b/i.test(rawText)) {
    return "What specifically needs to improve — performance, design, copy, conversion rate, or something else?";
  }
  if (/\b(code|app|application|service|api|backend|frontend)\b/i.test(rawText)) {
    return "What is the main problem — a bug, performance issue, code quality concern, or missing feature?";
  }
  if (/\b(email|message|text|letter|note)\b/i.test(rawText)) {
    return "Who is the recipient and what is the single most important thing this message needs to accomplish?";
  }
  if (/\b(document|report|doc|write|draft|essay)\b/i.test(rawText)) {
    return "What is the audience for this document and what decision should it help them make?";
  }
  const subjectMatch = rawText.match(/\b(?:this|the|my|our)\s+(\w+)\b/i);
  const STOPWORDS = /^(so|and|but|or|if|to|a|an|it|is|was|be|of|for|with|that|when|where|how|what|why|i|we|you|me|us)\b/i;
  if (subjectMatch && !STOPWORDS.test(subjectMatch[1])) {
    return `What specifically needs to change about ${subjectMatch[1]} — fix a bug, improve quality, redesign, or something else?`;
  }
  return "What is the single most important outcome you need from this prompt?";
}
