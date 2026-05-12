import { embedText, cosineSimilarity } from "./embeddings.js";
import { templateDescription, selectTemplate } from "./templates.js";

export const INTENT_LIBRARY = [
  {
    key: "write",
    label: "Write",
    examples: [
      "Write a concise update for the team about the release timeline.",
      "Draft a message to the client with a calm technical tone.",
    ],
  },
  {
    key: "decide",
    label: "Decide",
    examples: [
      "Help me choose between these options using explicit criteria.",
      "Compare the tradeoffs and recommend the best path.",
    ],
  },
  {
    key: "learn",
    label: "Learn",
    examples: [
      "Teach me the concept from first principles.",
      "Explain the topic with one concrete example and a short summary.",
    ],
  },
  {
    key: "plan",
    label: "Plan",
    examples: [
      "Break this project into steps and sequence the work.",
      "Create a timeline and execution plan for the next milestone.",
    ],
  },
  {
    key: "research",
    label: "Research",
    examples: [
      "Find the relevant sources and summarize the differences.",
      "Research this topic and compare the strongest options.",
    ],
  },
  {
    key: "create",
    label: "Create",
    examples: [
      "Create the requested artifact with the right style and constraints.",
      "Generate the structure and content needed for the deliverable.",
    ],
  },
  {
    key: "fix",
    label: "Fix",
    examples: [
      "Debug the broken flow and identify the smallest fix.",
      "Find the root cause and suggest the least risky repair.",
    ],
  },
  {
    key: "extract",
    label: "Extract",
    examples: [
      "Pull structured fields out of the source text.",
      "Extract the relevant data and return it in a defined format.",
    ],
  },
  {
    key: "organize",
    label: "Organize",
    examples: [
      "Organize this messy information into a clear structure.",
      "Sort the inputs and return a clean ordered outline.",
    ],
  },
  {
    key: "act",
    label: "Act",
    examples: [
      "Perform the requested action with the stated constraints.",
      "Carry out the task safely and report the result.",
    ],
  },
];

function keywordScore(text, intentKey) {
  const rules = {
    write: [/\b(write|draft|compose|message|email|announce)\b/i],
    decide: [/\b(decide|choose|compare|tradeoff|recommend)\b/i],
    learn: [/\b(explain|teach|learn|understand|walkthrough)\b/i],
    plan: [/\b(plan|steps|timeline|sequence|roadmap)\b/i],
    research: [/\b(research|sources|compare|study|find)\b/i],
    create: [/\b(create|generate|build|make|scaffold)\b/i],
    fix: [/\b(fix|debug|broken|error|fail|issue|bug|root cause)\b/i],
    extract: [/\b(extract|pull out|fields|parse|structured)\b/i],
    organize: [/\b(organize|sort|order|outline|structure)\b/i],
    act: [/\b(act|perform|do the task|carry out|execute)\b/i],
  };

  return (rules[intentKey] || []).reduce((sum, pattern) => sum + (pattern.test(text) ? 1 : 0), 0);
}

async function buildLibraryVectors(options = {}) {
  const vectors = [];
  for (const intent of INTENT_LIBRARY) {
    const template = selectTemplate(intent.key);
    const text = [
      intent.label,
      templateDescription(template),
      ...intent.examples,
      ...template.requestedOutput,
    ].join("\n");
    vectors.push({
      ...intent,
      template,
      vector: await embedText(text, options),
    });
  }
  return vectors;
}

export async function classifyIntent(text, options = {}) {
  const promptVector = await embedText(text, options);
  const library = await buildLibraryVectors(options);

  const scored = library
    .map((intent) => {
      const semantic = cosineSimilarity(promptVector, intent.vector);
      const keywords = keywordScore(text, intent.key);
      const score = semantic * 0.7 + Math.min(keywords, 3) * 0.1;
      return { ...intent, semantic, keywords, score };
    })
    .sort((a, b) => b.score - a.score || b.semantic - a.semantic);

  const primary = scored[0] || library[0];
  const secondary = scored.slice(1).filter((intent) => intent.score > 0.18).slice(0, 2);
  const confidence = Math.max(0, Math.min(1, primary.score - (secondary[0]?.score || 0) + 0.45));

  return {
    primary: {
      key: primary.key,
      label: primary.label,
      template: primary.template,
      score: primary.score,
      semantic: primary.semantic,
      keywords: primary.keywords,
    },
    secondary: secondary.map((intent) => ({
      key: intent.key,
      label: intent.label,
      score: intent.score,
      semantic: intent.semantic,
      keywords: intent.keywords,
    })),
    confidence,
    nearestExamples: scored.slice(0, 3).flatMap((intent) =>
      intent.examples.slice(0, 2).map((example) => ({
        intent: intent.label,
        example,
        score: intent.score,
      })),
    ),
    template: primary.template,
  };
}
