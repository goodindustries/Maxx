import { normalizeText } from "./pipeline/normalize.js";
import { cleanPromptText } from "./pipeline/cleanup.js";
import { correctGrammar } from "./pipeline/grammar.js";
import { condensePrompt } from "./pipeline/condense.js";
import { classifyIntent } from "./pipeline/intents.js";
import { selectTemplate } from "./pipeline/templates.js";
import { buildFallbackQuestion, compareQuality, computePQS, computeEES, computeHCLS } from "./pipeline/scoring.js";

const TECH_TAGS = [
  { label: "React frontend", patterns: [/\breact\b/i, /\bjsx\b/i, /\btsx\b/i] },
  { label: "Node backend", patterns: [/\bnode\b/i, /\bexpress\b/i, /\bapi\b/i] },
  { label: "Python", patterns: [/\bpython\b/i, /\bdjango\b/i, /\bfastapi\b/i] },
  { label: "TypeScript", patterns: [/\btypescript\b/i, /\bts\b/i] },
  { label: "SQLite", patterns: [/\bsqlite\b/i] },
  { label: "Postgres", patterns: [/\bpostgres\b/i, /\bpostgresql\b/i] },
  { label: "Auth", patterns: [/\bauth\b/i, /\boauth\b/i, /\blogin\b/i] },
  { label: "Sync", patterns: [/\bsync\b/i, /\bsynchronization\b/i, /\breplication\b/i] },
];

function extractTechTags(text, metadata = {}) {
  const tags = [];
  const haystack = `${text} ${Object.values(metadata).join(" ")}`;
  for (const tag of TECH_TAGS) {
    if (tag.patterns.some((pattern) => pattern.test(haystack))) {
      tags.push(tag.label);
    }
  }
  return [...new Set(tags)];
}

function gatherMetadata(metadata = {}) {
  return [
    ["Framework", metadata.framework],
    ["Language", metadata.language],
    ["Repo type", metadata.repoType],
    ["Model type", metadata.modelType],
  ]
    .filter(([, value]) => String(value || "").trim())
    .map(([label, value]) => `${label}: ${String(value).trim()}`);
}

function extractConstraints(sentences) {
  return sentences.filter((sentence) => /\b(must|must not|need|need to|don't|do not|avoid|only|keep|preserve|without|deadline|budget|audience|constraint|constraints)\b/i.test(sentence));
}

function firstSentence(text) {
  return text.split(/\n+/)[0] || text;
}

function fillFieldValues({ intent, cleanText, condensed, metadata }) {
  const sentences = condensed.sentences.length ? condensed.sentences : [cleanText];
  const constraintSentences = extractConstraints(sentences);
  const nonConstraints = sentences.filter((sentence) => !constraintSentences.includes(sentence));
  const fields = {
    write: ["recipient", "purpose", "tone", "constraints", "draft"],
    decide: ["options", "criteria", "stakes", "recommendation"],
    plan: ["goal", "timeframe", "resources", "steps"],
    research: ["question", "freshness", "sources", "comparison"],
    create: ["object", "style", "audience", "constraints"],
    fix: ["problem", "symptoms", "likelyCause", "smallestFix"],
    learn: ["topic", "currentUnderstanding", "targetDepth", "examples"],
    extract: ["source", "targetFields", "format", "validation"],
    organize: ["inputs", "structure", "orderingRules", "outputShape"],
    act: ["objective", "environment", "action", "safetyConstraints"],
  }[intent.primary.key] || selectTemplate(intent.primary.key).fields;

  function stripTrailingRequest(text) {
    return String(text || "")
      .replace(/\b(can you|could you|would you|please help me|help me)\b.*$/i, "")
      .replace(/\b(sort this out|figure this out|fix this|clean this up)\b.*$/i, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function firstMatchingSentence(patterns) {
    return nonConstraints.find((sentence) => patterns.some((pattern) => pattern.test(sentence))) || "";
  }

  function collectRelevantChunks(text, patterns, { pick = "first", limit = 3 } = {}) {
    const chunks = String(text || "")
      .split(/\b(?:and|but|however|so|because|while)\b/i)
      .map((chunk) => stripTrailingRequest(chunk))
      .map((chunk) => chunk.replace(/\s+/g, " ").trim())
      .filter(Boolean);

    const selected = chunks.filter((chunk) => patterns.some((pattern) => pattern.test(chunk)));
    const pool = [...new Set(selected.length ? selected : chunks)];
    const chosen = pick === "last" ? pool.slice(-limit) : pool.slice(0, limit);
    return chosen.join(" · ");
  }

  const text = cleanText;
  const shared = {
    recipient: metadata.audience || "not specified",
    purpose: stripTrailingRequest(firstSentence(cleanText)) || firstSentence(cleanText),
    tone: /\b(calm|direct|technical|concise|formal|friendly)\b/i.exec(text)?.[0] || "technical, concise",
    constraints: constraintSentences.length ? constraintSentences.join(" ") : "Preserve the user's intent.",
    draft: condensed.text || cleanText,
    options: nonConstraints.slice(0, 3).join("\n"),
    criteria: constraintSentences.length ? constraintSentences.join("\n") : "Use clarity, correctness, and minimal change.",
    stakes: /\b(risk|impact|cost|deadline|budget)\b/i.test(text) ? nonConstraints.join(" ") : "State the cost of the wrong choice.",
    recommendation: "Recommend the smallest reliable path.",
    question: stripTrailingRequest(firstSentence(cleanText)) || firstSentence(cleanText),
    freshness: /\b(current|latest|recent|fresh)\b/i.test(text) ? "Use the most current available sources." : "Freshness not specified.",
    sources: nonConstraints.filter((sentence) => /\b(source|sources|link|docs|citation|reference)\b/i.test(sentence)).join(" "),
    comparison: nonConstraints.join(" "),
    object: stripTrailingRequest(firstSentence(cleanText)) || firstSentence(cleanText),
    style: metadata.style || "technical",
    audience: metadata.audience || "developer",
    problem:
      stripTrailingRequest(firstMatchingSentence([/\b(error|broken|failing|failure|bug|issue|problem|breaks|keeps breaking)\b/i])) ||
      stripTrailingRequest(firstSentence(cleanText)) ||
      cleanText,
    symptoms:
      collectRelevantChunks(
        firstMatchingSentence([/\b(error|broken|failing|failure|bug|issue|symptom|noisy|logs?)\b/i]) || cleanText,
        [/\b(error|broken|failing|failure|bug|issue|symptom|noisy|logs?)\b/i],
        { pick: "first", limit: 2 },
      ) || "Describe the visible failure symptoms.",
    likelyCause:
      collectRelevantChunks(
        firstMatchingSentence([/\b(auth|authentication|authorization|sqlite|postgres|sync|synchronization)\b/i]) || cleanText,
        [/\b(auth|authentication|authorization|sqlite|postgres|sync|synchronization)\b/i],
        { pick: "last", limit: 2 },
      ) || "Identify the likely cause before suggesting a change.",
    smallestFix: "Recommend the smallest viable fix path.",
    topic: firstSentence(cleanText),
    currentUnderstanding: "Assume baseline technical familiarity unless the prompt says otherwise.",
    targetDepth: "Practical and direct.",
    examples: nonConstraints.join(" "),
    source: metadata.source || "not specified",
    targetFields: "Extract the relevant fields cleanly.",
    format: "Return a structured output.",
    validation: "Validate the extracted values against the source.",
    inputs: nonConstraints.join(" "),
    structure: "Group the information into the smallest useful sections.",
    orderingRules: "Order by priority and dependency.",
    outputShape: "Return a clean ordered outline.",
    objective: firstSentence(cleanText),
    environment: gatherMetadata(metadata).join(" · ") || "not specified",
    action: "Perform the requested action without changing intent.",
    safetyConstraints: "Preserve intent and avoid unnecessary side effects.",
    resources: "Use the resources named in the prompt.",
    timeframe: /\b(today|tomorrow|this week|deadline|date|week|month)\b/i.exec(text)?.[0] || "Not specified",
    steps: "Break the work into concrete steps.",
  };

  const values = {};
  for (const field of fields) {
    values[field] = shared[field] || cleanText;
  }

  return values;
}

function buildOptimizedPrompt({ intent, template, fields, metadata, condensed }) {
  const secondary = intent.secondary.map((item) => item.label).join(", ");
  const environment = gatherMetadata(metadata);
  const techTags = extractTechTags(condensed.text, metadata);
  const labelize = (field) =>
    field
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/^./, (char) => char.toUpperCase());

  const lines = [
    `Task Type: ${intent.primary.label}${secondary ? ` + ${secondary}` : ""}`,
    "",
    "Environment:",
    ...(environment.length ? environment.map((line) => `- ${line}`) : ["- Not specified"]),
    ...(techTags.length ? [`- Related tags: ${techTags.join(", ")}`] : []),
    "",
    `Template: ${template.label}`,
  ];

  for (const field of template.fields) {
    const value = fields[field];
    lines.push("", `${labelize(field)}:`);
    lines.push(value || "Not specified");
  }

  const cleanupLines = [
    "Separate unrelated goals into ordered sections.",
    "Remove filler and keep the request technical.",
    "Preserve intent and do not invent missing context.",
  ];

  lines.push("", "Constraints:");
  lines.push(...cleanupLines.map((line) => `- ${line}`));

  lines.push("", "Requested Output:");
  lines.push(...template.requestedOutput.map((line) => `- ${line}`));

  if (intent.secondary.length) {
    lines.push(`- Keep secondary intent separate unless it is required for the primary task.`);
  }

  return lines.join("\n");
}

export async function analyzePrompt({ prompt, metadata = {}, options = {} }) {
  const rawPrompt = String(prompt || "");
  const normalized = normalizeText(rawPrompt);
  const cleaned = cleanPromptText(normalized);
  const grammar = await correctGrammar(cleaned, options);
  const condensed = condensePrompt(grammar.text);
  const intent = await classifyIntent(condensed.text || grammar.text || cleaned, options);
  const template = selectTemplate(intent.primary.key);
  const fields = fillFieldValues({ intent, cleanText: grammar.text || cleaned, condensed, metadata });
  const optimizedPrompt = buildOptimizedPrompt({ intent, template, fields, metadata, condensed });
  const quality = compareQuality(rawPrompt, optimizedPrompt);
  const missing = [];

  // Tech-context slots — only flag when the intent is code/architecture related
  const isTechIntent = ["fix", "create", "act", "plan", "organize"].includes(intent.primary.key);
  const hasTechSignal = /\b(react|vue|svelte|next|node|express|fastapi|django|flutter|rails|javascript|typescript|python|go|rust|java|sql|api|backend|frontend|server|cli|database|auth|sync)\b/i.test(rawPrompt);

  if (isTechIntent || hasTechSignal) {
    if (!String(metadata.framework || "").trim() && !/\b(react|vue|svelte|next|node|express|fastapi|django|flutter|rails)\b/i.test(rawPrompt)) {
      missing.push("framework");
    }
    if (!String(metadata.language || "").trim() && !/\b(javascript|typescript|python|go|rust|java|c\+\+|sql)\b/i.test(rawPrompt)) {
      missing.push("language");
    }
    if (!/\b(node|browser|cli|server|desktop|mobile|bun|deno)\b/i.test(rawPrompt)) {
      missing.push("runtime or environment");
    }
  }

  const followUpQuestion = intent.confidence < 0.45 ? buildFallbackQuestion({ missing, intentLabel: intent.primary.label }) : "";
  const problems = [];

  if (intent.secondary.length) {
    problems.push({
      key: "mixed_objectives",
      title: "Mixed objectives",
      detail: "More than one intent cluster is active in the prompt.",
      action: "Split the ask into ordered sections so the main task comes first.",
    });
  }

  if (cleaned !== normalized || grammar.applied) {
    problems.push({
      key: "cleanup_applied",
      title: "Cleanup applied",
      detail: grammar.applied ? "Grammar correction and cleanup changed the prompt before reconstruction." : "Deterministic cleanup removed filler and lead-ins.",
      action: "Review the reconstructed prompt to confirm the cleaned version still matches the original intent.",
    });
  }

  if (condensed.droppedCount > 0) {
    problems.push({
      key: "oversized_context",
      title: "Oversized context",
      detail: `Condensing dropped ${condensed.droppedCount} low-signal sentence(s) before reconstruction.`,
      action: "Trim unrelated logs, duplicate snippets, and long pasted blocks before sending.",
    });
  }

  if (missing.length) {
    problems.push({
      key: "missing_constraints",
      title: "Missing constraints",
      detail: `Missing ${missing.join(", ")} makes the request harder to execute cleanly.`,
      action: "Add the missing environment details or make them explicit in the rewritten prompt.",
    });
  }

  if (intent.confidence < 0.45) {
    problems.push({
      key: "low_confidence",
      title: "Low confidence",
      detail: "Nearest-neighbor intent classification was not strong enough to trust the rewrite blindly.",
      action: "Add one more detail or answer the follow-up question before sending the prompt.",
    });
  }

  const pqs   = compareQuality(rawPrompt, optimizedPrompt);
  const ees   = computeEES(rawPrompt, optimizedPrompt);
  const hcls  = computeHCLS({ confidence: intent.confidence, problems, missing });

  return {
    ok: true,
    pipeline: {
      rawPrompt,
      normalized,
      cleaned: grammar.text || cleaned,
      grammar,
      condensed,
      intent,
      template,
    },
    classification: {
      primary: intent.primary.label,
      secondary: intent.secondary.map((item) => item.label),
      tags: extractTechTags(condensed.text || grammar.text || cleaned, metadata),
      environment: gatherMetadata(metadata),
      confidence: intent.confidence,
      nearestExamples: intent.nearestExamples,
    },
    evaluation: {
      pqs,
      ees,
      hcls,
    },
    problems,
    optimizedPrompt,
    notes: [
      `Primary intent: ${intent.primary.label}.`,
      intent.secondary.length ? `Secondary intent: ${intent.secondary.map((item) => item.label).join(", ")}.` : "No strong secondary intent cluster detected.",
      grammar.applied ? "Grammar correction applied before reconstruction." : "Grammar correction skipped or unavailable.",
      condensed.sentences.length ? `Condensed to ${condensed.sentences.length} high-signal sentences.` : "No condensation was necessary.",
      `Confidence: ${Math.round(intent.confidence * 100)}%.`,
    ],
    confidence: intent.confidence,
    followUpQuestion,
    quality: pqs,
  };
}

export const skillSamples = {
  debugging:
    "hey claude this sqlite sync keeps breaking and the logs are noisy and maybe postgres would fix it but honestly the auth path might be the real issue can you help me sort this out",
  architecture:
    "I need help deciding whether this local-first sync layer should stay on SQLite or move to Postgres. The architecture feels wrong, auth is mixed into the sync flow, and I need a clear recommendation with tradeoffs.",
  generation:
    "Create a TypeScript API route for a small feature flag service. It should support read and update actions, be easy to test, and fit into a Node backend.",
  refactor:
    "Please refactor this backend module so the validation logic is smaller, the data access layer is separated, and the behavior stays the same.",
  explanation:
    "Explain why this sync strategy is failing and how the different pieces interact. I want a concise technical explanation with a concrete example.",
};
