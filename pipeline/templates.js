export const INTENT_TEMPLATES = {
  write: {
    label: "Write",
    fields: ["recipient", "purpose", "tone", "constraints", "draft"],
    requestedOutput: [
      "Produce a ready-to-send draft.",
      "Keep the tone and recipient explicit.",
      "Honor any constraints exactly.",
    ],
  },
  decide: {
    label: "Decide",
    fields: ["options", "criteria", "stakes", "recommendation"],
    requestedOutput: [
      "Compare the relevant options.",
      "Choose a recommendation with criteria.",
      "Call out the tradeoffs and risk points.",
    ],
  },
  plan: {
    label: "Plan",
    fields: ["goal", "timeframe", "resources", "steps"],
    requestedOutput: [
      "State the goal and timeframe.",
      "Break the work into steps.",
      "Keep the plan executable and scoped.",
    ],
  },
  research: {
    label: "Research",
    fields: ["question", "freshness", "sources", "comparison"],
    requestedOutput: [
      "Frame the question clearly.",
      "Separate verified facts from assumptions.",
      "Compare sources or candidate answers.",
    ],
  },
  create: {
    label: "Create",
    fields: ["object", "style", "audience", "constraints"],
    requestedOutput: [
      "Describe the object to create.",
      "Name the audience and style.",
      "Preserve all constraints.",
    ],
  },
  fix: {
    label: "Fix",
    fields: ["problem", "symptoms", "likelyCause", "smallestFix"],
    requestedOutput: [
      "State the failure clearly.",
      "List symptoms and likely causes.",
      "Recommend the smallest viable fix.",
    ],
  },
  learn: {
    label: "Learn",
    fields: ["topic", "currentUnderstanding", "targetDepth", "examples"],
    requestedOutput: [
      "Define the topic and target depth.",
      "Match the explanation to the current understanding.",
      "Use concrete examples.",
    ],
  },
  extract: {
    label: "Extract",
    fields: ["source", "targetFields", "format", "validation"],
    requestedOutput: [
      "State the source and target fields.",
      "Define the output format.",
      "Include validation rules.",
    ],
  },
  organize: {
    label: "Organize",
    fields: ["inputs", "structure", "orderingRules", "outputShape"],
    requestedOutput: [
      "Describe the inputs clearly.",
      "State the structure and ordering rules.",
      "Specify the output shape.",
    ],
  },
  act: {
    label: "Act",
    fields: ["objective", "environment", "action", "safetyConstraints"],
    requestedOutput: [
      "State the objective.",
      "Describe the environment and action.",
      "Name the safety constraints.",
    ],
  },
};

export function selectTemplate(intentKey) {
  return INTENT_TEMPLATES[intentKey] || INTENT_TEMPLATES.fix;
}

export function templateDescription(template) {
  return `${template.label}: ${template.fields.join(", ")}`;
}
