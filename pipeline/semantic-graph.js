import { normalizeText } from "./normalize.js";
import { cleanPromptText } from "./cleanup.js";
import { condensePrompt } from "./condense.js";
import { classifyIntent } from "./intents.js";

// ─── Object detection ─────────────────────────────────────────────────────────

const OBJECT_PATTERNS = [
  [/\b(email|message|text|letter|note|memo|reply|follow.?up)\b/i,       "message"],
  [/\b(code|function|module|script|component|class|method|bug|snippet)\b/i, "code"],
  [/\b(document|doc|report|essay|article|post|readme|spec|bio)\b/i,     "document"],
  [/\b(database|db|table|schema|query|migration|sql|postgres|sqlite)\b/i, "database"],
  [/\b(api|endpoint|route|service|backend|server|webhook)\b/i,          "API"],
  [/\b(app|application|product|feature|ui|website|landing.?page)\b/i,   "application"],
  [/\b(plan|roadmap|strategy|timeline|milestone|sprint)\b/i,            "plan"],
  [/\b(idea|ideas|options?|choices?|alternatives?|directions?)\b/i,      "decision space"],
  [/\b(meeting|standup|retrospective|presentation|call)\b/i,            "meeting"],
  [/\b(prompt|request|question|ask)\b/i,                                "prompt"],
];

function detectObject(text) {
  for (const [pattern, label] of OBJECT_PATTERNS) {
    if (pattern.test(text)) return label;
  }
  return "request";
}

// ─── Goal extraction ──────────────────────────────────────────────────────────

function extractGoal(text) {
  const stripped = text
    // Meta-request openers
    .replace(/^(help me|can you|could you|please|i want to|i need to|i'd like to|i am trying to|i'm trying to)\s+/i, "")
    .replace(/^i\s+have\s+.+?\s+and\s+(?:don'?t|can'?t|need\s+to)\s+/i, "")
    // Command verbs that restate the intent (already in intentLabel)
    .replace(/^(tell me about|explain(?:\s+how)?|describe|write|draft|make\s+(?:me\s+)?(?:a\s+)?|give me|show me|create|build|fix|debug)\s+/i, "")
    // Decide-intent question framing ("should i use X or Y", "which is better")
    .replace(/^(should i (use|choose|pick|go with)|which (is better|should i (use|choose))|is .{1,30} better than)\s+/i, "")
    // "X or Y" → "X vs Y" for comparisons
    .replace(/^(\S+)\s+or\s+(\S+)\b/i, (_, a, b) => `${a} vs ${b}`)
    // Trailing noise
    .replace(/\s+(please|thanks|thank you|asap|soon|right away)\s*$/i, "")
    .replace(/\s+\bbasically\b.*$/i, "")
    .replace(/\s+\bi\s+(?:don'?t|never)\s+(?:really\s+)?(?:understand|get|know)\s+(?:it|this).*$/i, "")
    .replace(/\bwithout\s+.+$/i, "")
    // Only strip "fix this/clean this up" when nothing meaningful follows
    .replace(/\b(can you|could you|please)?\s*(help me|sort this out|figure this out|fix this|clean this up)\s*$/i, "")
    // Strip intent-restatement at end ("i need to respond", "i want to fix it")
    .replace(/[,\s]+i (need|want|have) to \w+.*$/i, "")
    .trim();

  const bySentence = stripped.split(/[.!?]+/).map(s => s.trim()).filter(s => s.length > 4);
  if (bySentence.length === 1) {
    const clauses = stripped
      .split(/\s+(?:and|but|however|although|though|because|so|honestly)\s+/i)
      .map(s => s.trim())
      .filter(s => s.length > 4);
    let goal = "";
    for (const clause of clauses.slice(0, 2)) {
      goal = goal ? `${goal}; ${clause}` : clause;
      if (goal.split(/\s+/).length >= 5) break;
    }
    return goal || stripped;
  }

  // Fallback: return first sentence or the original stripped text — never undefined
  return bySentence[0] || stripped || text;
}

// ─── Audience detection ───────────────────────────────────────────────────────

const AUDIENCE_PATTERNS = [
  [/\bmy\s+(landlord|boss|manager|client|customer|team|colleague|friend|partner|investor|cofounder|ceo|cto)\b/i, 1],
  [/\bto\s+(?:a\s+|an\s+|the\s+)?(landlord|boss|manager|client|customer|team|developer|designer|user|investor)\b/i, 1],
  [/\bfor\s+(?:a\s+|an\s+|the\s+)?(developer|designer|user|customer|client|beginner|senior|technical|non.technical|general|executive)\b/i, 1],
];

function detectAudience(text) {
  for (const [pat, group] of AUDIENCE_PATTERNS) {
    const m = text.match(pat);
    if (m) {
      const raw = m[group].toLowerCase();
      return raw.charAt(0).toUpperCase() + raw.slice(1);
    }
  }
  // Implicit inference — only when no explicit subject is mentioned
  if (/\b(raise|salary|pay\s+increase|promotion)\b/i.test(text)) return "Manager";
  if (/\bteam\s+(meeting|announcement|update|standup)\b/i.test(text)) return "Team";
  return null;
}

// ─── Tone detection ───────────────────────────────────────────────────────────

function detectTone(text) {
  const tones = [];
  if (/\b(professional|formal|business|corporate)\b/i.test(text))     tones.push("professional");
  if (/\b(casual|friendly|informal|warm|approachable)\b/i.test(text)) tones.push("casual");
  if (/\b(technical|precise|detailed|thorough)\b/i.test(text))        tones.push("technical");
  if (/\b(concise|brief|short|quick|minimal)\b/i.test(text))          tones.push("concise");
  if (/\b(polite|respectful|considerate|tactful|diplomatic)\b/i.test(text)) tones.push("respectful");
  if (/\b(confident|assertive|direct|firm|clear)\b/i.test(text))      tones.push("direct");
  if (/\b(empathetic|compassionate|supportive|understanding)\b/i.test(text)) tones.push("empathetic");

  // Negative tone constraints ("without sounding X", "don't sound X")
  const neg = text.match(/\bwithout\s+sounding\s+(\w+)/i)
           || text.match(/\bdon'?t\s+(?:want\s+to\s+)?sound\s+(\w+)/i)
           || text.match(/\bnot\s+(?:too\s+)?(\w+)\s*$/i);
  if (neg) tones.push(`not ${neg[1].toLowerCase()}`);

  return tones.length ? tones : [];
}

// ─── Constraint extraction ────────────────────────────────────────────────────

function extractConstraints(text) {
  const constraints = [];
  const sentences = text.match(/[^.!?\n]+[.!?\n]?/g) || [text];

  for (const s of sentences) {
    const t = s.trim();
    const withoutM = t.match(/\bwithout\s+(.+?)(?:[,.]|$)/i);
    const dontM    = t.match(/\bdon'?t\s+(sound|seem|come\s+across\s+as|be|use|include)\s+(.+?)(?:[,.]|$)/i);
    const mustNotM = t.match(/\b(must not|should not|do not|avoid|never)\s+(.+?)(?:[,.]|$)/i);
    const onlyM    = t.match(/\b(only|exclusively|strictly)\s+(.+?)(?:[,.]|$)/i);

    if (withoutM) constraints.push(`Avoid ${withoutM[1].trim()}`);
    else if (dontM) constraints.push(`Do not ${dontM[1]} ${dontM[2].trim()}`);
    else if (mustNotM) constraints.push(`${mustNotM[1]} ${mustNotM[2].trim()}`);
    else if (onlyM) constraints.push(`Only ${onlyM[2].trim()}`);
  }

  return [...new Set(constraints)];
}

// ─── Output format detection ──────────────────────────────────────────────────

function detectOutputFormat(text, intentKey) {
  let format = null;
  let length = null;

  if (/\b(draft|write|compose|create)\b.{0,40}\b(message|email|text|letter|note)\b/i.test(text)) format = "draft message";
  else if (/\b(steps?|instructions?|how.?to|walkthrough|guide)\b/i.test(text)) format = "step-by-step guide";
  else if (/\b(explain|explanation|overview|summary|intro)\b/i.test(text)) format = "explanation";
  else if (/\b(compare|comparison|pros.and.cons|tradeoffs?|vs\.?|versus)\b/i.test(text)) format = "comparison";
  else if (/\b(plan|roadmap|timeline|strategy)\b/i.test(text)) format = "plan";
  else if (/\b(code|function|implementation|snippet|example)\b/i.test(text)) format = "code";
  else if (/\b(list|bullet|outline|ideas|options)\b/i.test(text)) format = "list";
  else if (/\b(recommend|recommendation|suggest|advice|which.+(should|is better))\b/i.test(text)) format = "recommendation";
  else if (/\b(post|caption|bio|copy|content)\b/i.test(text)) format = "content";
  // "ask" alone is ambiguous — only treat as question if no recipient is implied
  else if (/\b(clarify|wonder|question)\b/i.test(text)) format = "question";

  if (/\b(short|brief|quick|concise|minimal|one.line|single)\b/i.test(text)) length = "short";
  else if (/\b(long|detailed|thorough|comprehensive|in.depth|full)\b/i.test(text)) length = "long";

  // Intent-based defaults when no explicit format
  if (!format) {
    const defaults = {
      write: "draft message", decide: "recommendation", plan: "plan",
      research: "comparison", create: "content", fix: "code",
      learn: "explanation", extract: "structured list", organize: "outline", act: "step-by-step guide",
    };
    format = defaults[intentKey] || "response";
  }
  if (!length) {
    if (["write", "create"].includes(intentKey))   length = "short";
    if (["plan", "research"].includes(intentKey))  length = "medium";
    if (["fix", "learn"].includes(intentKey))      length = "concise";
  }

  return { format, length };
}

// ─── Missing slot detection ───────────────────────────────────────────────────

function detectMissingSlots(intentKey, signals, graph) {
  const missing = [];

  if (intentKey === "write") {
    const isReply = /\b(reply|respond|response|answer)\b/i.test(graph.goal || "");
    if (!graph.audience) {
      missing.push(isReply ? "message to reply to" : "recipient name");
    }
    if (isReply && !signals.hasSourceMaterial) missing.push("original message");
  }
  if (intentKey === "fix") {
    if (!signals.hasTechContext) missing.push("language or framework");
    // Only block on error description if there's no symptom at all
    const hasSymptom = signals.hasErrorDescription
      || /\b(crash|crashing|fail|fails|broken|slow|not\s+work|cannot|can't|won't|keeps?)\b/i.test(graph.goal || "");
    if (!hasSymptom) missing.push("error or symptom");
  }
  if (intentKey === "decide") {
    if (!signals.hasExplicitOptions) missing.push("explicit options");
  }
  if (intentKey === "create") {
    if (!graph.audience) missing.push("target audience");
  }
  if (intentKey === "plan") {
    if (!signals.hasTimeframe) missing.push("timeframe or deadline");
  }
  if (intentKey === "extract") {
    if (!signals.hasSourceMaterial) missing.push("source material");
  }

  return missing;
}

// ─── Uncertainty ──────────────────────────────────────────────────────────────

function assessUncertainty(confidence, graph) {
  let score = 0;
  if (confidence >= 0.65) score++;
  if ((graph.goal || "").split(/\s+/).length >= 8) score++;
  if (graph.constraints.length)  score++;
  if (graph.audience)            score++;
  if (graph.output.format !== "response") score++;

  if (score >= 4) return "low";
  if (score >= 2) return "medium";
  return "high";
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function extractSemanticGraph(rawInput, sessionContext = {}) {
  const normalized = normalizeText(rawInput);
  const cleaned    = cleanPromptText(normalized);
  const condensed  = condensePrompt(cleaned);
  const intent     = await classifyIntent(condensed.text || cleaned, {});

  const text      = cleaned;
  const intentKey = intent.primary.key;

  const goal        = extractGoal(text);
  const object      = detectObject(text);
  const audience    = detectAudience(text);
  const tone        = detectTone(text);
  const constraints = extractConstraints(text);
  const output      = detectOutputFormat(text, intentKey);

  const signals = {
    hasTechContext:      /\b(react|vue|python|javascript|typescript|node|api|sql|docker|postgres|sqlite)\b/i.test(text),
    hasErrorDescription: /\b(error|exception|crash|fails?|broken|bug|issue)\b/i.test(text),
    hasExplicitOptions:  /\b\w+\s+or\s+\w+\b/i.test(text) || /\bvs\.?\b/i.test(text),
    hasCriteria:         /\b(criteria|factor|consider|evaluate|tradeoff|important|priority)\b/i.test(text),
    hasTimeframe:        /\b(today|tomorrow|this week|deadline|by [a-z]+|urgent|asap)\b/i.test(text),
    hasSourceMaterial:   /\b(notes?|transcript|document|text|pasted|below|above|following)\b/i.test(text),
    hasQuantity:         /\b\d+\b/.test(text),
  };

  const graph = {
    intent:            intentKey,
    intentLabel:       intent.primary.label,
    intentConfidence:  intent.confidence,
    object,
    goal,
    audience,
    tone,
    constraints,
    output,
    sessionContext,
  };

  graph.missingInputs = detectMissingSlots(intentKey, signals, graph);
  graph.uncertainty   = assessUncertainty(intent.confidence, graph);

  return { graph, intent, signals, rawInput, normalized, cleaned, condensed };
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

export function scoreSemanticGraph(graph, intentConfidence) {
  const confidence = intentConfidence ?? graph.intentConfidence ?? 0;
  const goalWords  = (graph.goal || "").split(/\s+/).filter(Boolean).length;

  const intentScore      = Math.round(confidence * 25);
  const goalClarity      = goalWords >= 12 ? 1.0 : goalWords >= 7 ? 0.75 : goalWords >= 4 ? 0.45 : 0.1;
  const goalScore        = Math.round(goalClarity * 20);
  const constraintScore  = Math.min(15, graph.constraints.length * 8);
  const objectScore      = graph.object !== "request" ? 15 : 5;
  const outputScore      = graph.output.format !== "response" ? 15 : 5;
  const missingPenalty   = Math.min(10, graph.missingInputs.length * 5);
  const uncPenalty       = graph.uncertainty === "high" ? 10 : graph.uncertainty === "medium" ? 5 : 0;

  const total = Math.max(0, Math.min(100,
    intentScore + goalScore + constraintScore + objectScore + outputScore
    - missingPenalty - uncPenalty,
  ));

  const ambiguity = Math.min(100, Math.round(
    (1 - confidence) * 50 + graph.missingInputs.length * 10 + (graph.uncertainty === "high" ? 20 : 0),
  ));

  return {
    total,
    breakdown: {
      intentConfidence: intentScore,
      goalClarity:      goalScore,
      constraintCompleteness: constraintScore,
      objectSpecificity:      objectScore,
      outputDefinition:       outputScore,
      missingSlotPenalty:     -missingPenalty,
      uncertaintyPenalty:     -uncPenalty,
    },
    ambiguity,
    missingSlots: graph.missingInputs.length,
  };
}

// ─── Rendering ────────────────────────────────────────────────────────────────

// Maps intent + object to the best imperative verb opening
function intentVerb(intentKey, object) {
  const INTENT_VERB = {
    write: "Draft", fix: "Fix", learn: "Explain", decide: "Compare",
    plan: "Plan", research: "Research", create: "Create", extract: "Extract",
    organize: "Organize", act: "Do",
  };
  // Intent wins — only fall back to object-based verb when intent is generic/unknown
  if (INTENT_VERB[intentKey]) return INTENT_VERB[intentKey];
  const OBJ_VERB = { message: "Draft", code: "Fix", document: "Write", plan: "Plan", "decision space": "Compare" };
  return OBJ_VERB[object] || "Complete";
}

// Build a compact tone+constraint clause ("calm, professional — no jargon")
function toneClause(tone, constraints) {
  const uniqueTone = tone.filter((t) =>
    !constraints.some((c) => c.toLowerCase().includes(t.replace(/^not\s+/, "")))
  );
  const avoids = constraints.filter((c) => /^(avoid|do not|must not|never)/i.test(c))
    .map((c) => c.replace(/^(avoid|do not|must not|never)\s+/i, "").toLowerCase());
  const positives = uniqueTone.filter((t) => !t.startsWith("not "));
  const negatives = [...uniqueTone.filter((t) => t.startsWith("not ")).map((t) => t.replace("not ", "")), ...avoids];
  const parts = [];
  if (positives.length) parts.push(positives.join(", "));
  if (negatives.length) parts.push(`not ${negatives.join(" or ")}`);
  return parts.join(" — ");
}

// Build output spec ("short email", "bullet list", "under 150 words")
function outputSpec(output, intentKey) {
  const LENGTH_MAP = { short: "concise", long: "thorough", medium: "medium-length", concise: "concise" };
  const parts = [output.length ? LENGTH_MAP[output.length] || output.length : null, output.format].filter(Boolean);
  if (!parts.length) {
    const DEFAULTS = { learn: "clear explanation", fix: "corrected code with brief explanation",
      decide: "recommendation with reasoning", plan: "structured plan with milestones",
      extract: "structured list", create: "ready-to-use content" };
    return DEFAULTS[intentKey] || "clear, complete response";
  }
  return parts.join(" ");
}

export function renderPrompt(graph, targetModel = "generic") {
  const { intent, intentLabel, object, goal, audience, tone, constraints, output, missingInputs } = graph;

  const meaningfulObject = !["request", "prompt"].includes(object);
  const verb             = intentVerb(intent, meaningfulObject ? object : null);
  const tc               = toneClause(tone, constraints);
  const outSpec          = outputSpec(output, intent);

  // Placeholder line for required missing inputs
  const placeholders = missingInputs
    .filter((s) => !["timeframe or deadline", "target audience", "recipient name", "message to reply to", "original message"].includes(s) || true)
    .map((s) => `[${s}]`).join("  ");

  // ── Claude: XML-style ──────────────────────────────────────────────────────
  if (targetModel === "claude") {
    const contextParts = [
      meaningfulObject ? `Object: ${object}` : "",
      audience ? `Audience: ${audience}` : "",
    ].filter(Boolean);

    const constraintParts = [
      tc ? `Tone: ${tc}` : "",
      ...constraints.filter((c) => !/^(avoid|do not)/i.test(c)),
    ].filter(Boolean);

    const parts = [`<task>\n${verb} ${goal}${audience ? ` for ${audience}` : ""}.\n</task>`];
    if (contextParts.length) parts.push(`<context>\n${contextParts.join("\n")}\n</context>`);
    if (constraintParts.length) parts.push(`<constraints>\n${constraintParts.join("\n")}\n</constraints>`);
    if (placeholders) parts.push(`<required>\n${placeholders}\n</required>`);
    parts.push(`<output>\n${outSpec}\n</output>`);
    return parts.join("\n\n");
  }

  // ── Cursor / Codex: task-scoped ────────────────────────────────────────────
  if (targetModel === "cursor" || targetModel === "codex") {
    const parts = [`Task: ${verb} ${goal}.`];
    if (meaningfulObject) parts.push(`Scope: ${object}`);
    if (constraints.length) parts.push(`Constraints: ${constraints.map((c) => c).join("; ")}`);
    if (placeholders) parts.push(`Provide: ${placeholders}`);
    parts.push(`Output: ${outSpec}`);
    return parts.join("\n");
  }

  // ── Natural prose (generic / OpenAI) ──────────────────────────────────────
  const audienceMentioned = audience && goal.toLowerCase().includes(audience.toLowerCase());
  const sent1 = `${verb} ${goal}${audience && !audienceMentioned ? ` for ${audience.toLowerCase()}` : ""}.`;
  // Sentence 2: tone
  const sent2 = tc ? `Tone: ${tc}.` : "";
  // Sentence 3: additional hard constraints not covered by tone
  const hardConstraints = constraints.filter((c) =>
    !/^(avoid|do not|must not|never)/i.test(c) &&
    !tone.some((t) => c.toLowerCase().includes(t.replace(/^not\s+/, "")))
  );
  const sent3 = hardConstraints.length ? hardConstraints.join(". ") + "." : "";
  // Sentence 4: missing required inputs as natural language (not raw brackets)
  const missingNatural = missingInputs.length
    ? `To help, share: ${missingInputs.join("; ")}.`
    : "";
  const sent4 = missingNatural;
  // Sentence 5: output spec
  const sent5 = `Output: ${outSpec}.`;

  return [sent1, sent2, sent3, sent4, sent5].filter(Boolean).join("  ");
}
