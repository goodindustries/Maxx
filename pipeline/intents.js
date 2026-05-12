import { embedText, cosineSimilarity } from "./embeddings.js";
import { templateDescription, selectTemplate } from "./templates.js";

export const INTENT_LIBRARY = [
  {
    key: "write",
    label: "Write",
    examples: [
      "Write a concise update for the team about the release timeline.",
      "Draft a message to the client with a calm technical tone.",
      "Help me ask my landlord about paying rent a few days late.",
      "Can you write a polite email asking for a deadline extension?",
      "I need to message my boss — help me word it so it doesn't sound bad.",
      "Write a text to my friend explaining why I had to cancel.",
      "Help me say this without sounding rude or unprofessional.",
    ],
  },
  {
    key: "decide",
    label: "Decide",
    examples: [
      "Help me choose between these options using explicit criteria.",
      "Compare the tradeoffs and recommend the best path.",
      "Which is smarter right now, buying a new car or keeping my old one?",
      "Should I switch to postgres or stay on sqlite?",
      "Is it worth upgrading now or waiting for the next version?",
      "Help me pick between these two job offers.",
      "Which laptop is better for my use case?",
    ],
  },
  {
    key: "learn",
    label: "Learn",
    examples: [
      "Teach me the concept from first principles.",
      "Explain the topic with one concrete example and a short summary.",
      "What is compound interest and how does it actually work?",
      "Help me understand why this sync strategy is failing.",
      "Explain OAuth like I'm a backend engineer new to auth.",
      "What's the difference between authorization and authentication?",
    ],
  },
  {
    key: "plan",
    label: "Plan",
    examples: [
      "Break this project into steps and sequence the work.",
      "Create a timeline and execution plan for the next milestone.",
      "Plan a cheap 2-day trip for me and my wife near Chicago.",
      "Help me plan out the migration from monolith to services.",
      "What's the right order of steps to launch this feature?",
      "Build me a week-by-week roadmap for this project.",
    ],
  },
  {
    key: "research",
    label: "Research",
    examples: [
      "Find the relevant sources and summarize the differences.",
      "Research this topic and compare the strongest options.",
      "What are the pros and cons of homeschooling in Texas?",
      "Look into the tradeoffs between SSR and SSG for my use case.",
      "What does the research say about sleep and productivity?",
      "Give me a comparison of the top three options in this space.",
    ],
  },
  {
    key: "create",
    label: "Create",
    examples: [
      "Create the requested artifact with the right style and constraints.",
      "Generate the structure and content needed for the deliverable.",
      "Come up with ten YouTube title ideas for a fitness channel.",
      "Generate five variations of this marketing copy.",
      "Build me a starter template for a Node API with auth.",
      "Brainstorm names for my new product.",
    ],
  },
  {
    key: "fix",
    label: "Fix",
    examples: [
      "Debug the broken flow and identify the smallest fix.",
      "Find the root cause and suggest the least risky repair.",
      "My SQLite sync keeps breaking — the logs are noisy everywhere.",
      "This auth flow is failing and I don't know why.",
      "My resume sounds weak and generic — help me fix it.",
      "The API keeps returning 500 errors under load.",
      "Something is wrong with this output — it doesn't look right.",
    ],
  },
  {
    key: "extract",
    label: "Extract",
    examples: [
      "Pull structured fields out of the source text.",
      "Extract the relevant data and return it in a defined format.",
      "Pull the action items and deadlines from these meeting notes.",
      "Get me the key points from this document.",
      "Find all the names, dates, and decisions in this thread.",
      "List every requirement mentioned in this spec.",
    ],
  },
  {
    key: "organize",
    label: "Organize",
    examples: [
      "Organize this messy information into a clear structure.",
      "Sort the inputs and return a clean ordered outline.",
      "These ideas are scattered — group them into themes.",
      "Take this brain dump and turn it into a prioritized list.",
      "Reorganize these notes into sections that make sense.",
    ],
  },
  {
    key: "act",
    label: "Act",
    examples: [
      "Perform the requested action with the stated constraints.",
      "Carry out the task safely and report the result.",
      "Give me the exact steps to file a small-claims case.",
      "Walk me through how to set up 2FA on this service.",
      "What are the exact terminal commands to deploy this?",
    ],
  },
];

// Each pattern worth 1 point. Phrase patterns (more specific) worth 2.
const KEYWORD_RULES = {
  write: {
    normal: [
      /\b(write|draft|compose|email|letter|note|memo|announcement|caption|bio|wording)\b/i,
      /\b(reword|rephrase|rewrite|paraphrase)\b/i,
      /\b(response|reply|respond|follow.?up)\b/i,
      /\b(message|text)\b.{0,30}\b(to|for|my|the)\b/i,
    ],
    phrase: [
      /\bhelp me (ask|tell|say|word|phrase|message|text|write|communicate)\b/i,
      /\b(ask|tell|say)\b.{0,50}\b(without sounding|politely|professionally|nicely|respectfully|in a way that)\b/i,
      /\bhow (do i|should i|can i) (ask|say|word|phrase|put|bring) (this|it|that)\b/i,
    ],
  },
  decide: {
    normal: [
      /\b(decide|choose|choice|pick|select|opt for|go with|stick with)\b/i,
      /\b(compare|versus|vs\.?|tradeoff|trade.off)\b/i,
      /\b(recommend|recommendation|advise|suggest)\b/i,
      /\b(worth it|worthwhile|worth (the|switching|upgrading|buying))\b/i,
    ],
    phrase: [
      /\bwhich (is|are|would be|should i|one (is|would))\b/i,
      /\b(better|best|smarter|wiser|worse|right choice)\b.{0,50}\b(or|between|than|vs)\b/i,
      /\bshould i\b.{0,60}\bor\b/i,
      /\b(buying|keeping|switching|staying|going with|using)\b.{0,40}\bor\b/i,
      /\bis it (worth|better|smarter|a good idea)\b/i,
    ],
  },
  learn: {
    normal: [
      /\b(learn|understand|explain|teach|clarify|educate)\b/i,
      /\b(concept|basics|overview|tutorial|walkthrough|primer|intro)\b/i,
      /\b(confused|confusing|don'?t understand|unclear)\b/i,
      /\b(beginner|newbie|layman|simple terms|plain english|eli5)\b/i,
    ],
    phrase: [
      /\bwhat (is|are|does|do)\b.{0,40}\b(mean|work|do|actually)\b/i,
      /\bhow does.{0,40}(work|happen|function)\b/i,
      /\bwhy (does|is|do|would|can'?t)\b/i,
      /\bhelp me understand\b/i,
      /\bwhat'?s? the difference (between|in)\b/i,
      /\bexplain.{0,30}(like|as if|to a)\b/i,
    ],
  },
  plan: {
    normal: [
      /\b(plan|planning|roadmap|timeline|schedule|milestone|itinerary|agenda)\b/i,
      /\b(sequence|phases?|rollout|launch)\b/i,
      /\b(prepare|preparation|strategy|strategize)\b/i,
    ],
    phrase: [
      /\bbreak.{0,20}(into|down).{0,20}(steps?|phases?|parts?|tasks?)\b/i,
      /\bhow (to|do i|should i|can i) (approach|start|begin|tackle|structure) (this|the|a)\b/i,
      /\bstep.by.step (plan|guide|process|approach)\b/i,
      /\b(week|day|month).by.(week|day|month)\b/i,
    ],
  },
  research: {
    normal: [
      /\b(research|investigate|look into|find out|explore|study)\b/i,
      /\b(evidence|sources?|data|statistics|findings|literature)\b/i,
      /\b(pros and cons|pros\/cons|advantages|disadvantages)\b/i,
    ],
    phrase: [
      /\bwhat (do|does|are|is).{0,30}(say|know|show|think|recommend) about\b/i,
      /\bgive me.{0,30}(comparison|overview|summary|breakdown) of\b/i,
      /\bwhat.{0,20}(research|evidence|data|studies) (say|show|suggest)\b/i,
    ],
  },
  create: {
    normal: [
      /\b(create|generate|make|build|produce|craft|develop|design)\b/i,
      /\b(brainstorm|ideate|come up with|think of)\b/i,
      /\b(scaffold|boilerplate|starter|template)\b/i,
    ],
    phrase: [
      /\b\d+\s*(ideas?|examples?|options?|suggestions?|titles?|names?|variations?)\b/i,
      /\b(ten|five|three|twenty|fifty)\s*(ideas?|examples?|options?|suggestions?|titles?)\b/i,
      /\b(list of|set of|bunch of).{0,20}(ideas?|examples?|options?)\b/i,
    ],
  },
  fix: {
    normal: [
      /\b(fix|debug|broken|error|failing|failure|bug|issue|problem|wrong|broke)\b/i,
      /\b(root cause|symptoms?|crash|exception|repair|patch|resolve|troubleshoot)\b/i,
    ],
    phrase: [
      /\b(not working|doesn'?t work|won'?t work|stopped working)\b/i,
      /\bkeeps? (breaking|failing|crashing|throwing)\b/i,
      /\bsomething'?s? (wrong|off|broken|weird|not right)\b/i,
      /\b(sounds?|looks?|feels?|seems?) (weak|bad|off|wrong|generic|bland|terrible|broken)\b/i,
      /\bwhy (is|does|won'?t|can'?t).{0,40}(work|working|broken|failing)\b/i,
      /\b(weak|generic|bland|bad).{0,30}(resume|email|writing|copy|output|response|prompt)\b/i,
    ],
  },
  extract: {
    normal: [
      /\b(extract|parse|pull out|grab|identify)\b/i,
      /\b(action items?|key points?|takeaways?|deadlines?)\b/i,
      /\b(structured|schema|fields?)\b.{0,20}\b(from|out of)\b/i,
    ],
    phrase: [
      /\bpull.{0,30}(items?|points?|dates?|names?|deadlines?|decisions?)\b/i,
      /\b(get|find|list|give me).{0,20}(the|all|every|any).{0,20}(items?|points?|dates?|names?|deadlines?)\b/i,
      /\bfrom (these|this|the) (notes?|text|document|email|message|thread|meeting)\b/i,
      /\b(what|which).{0,20}(mentioned|listed|said|noted|decided)\b/i,
    ],
  },
  organize: {
    normal: [
      /\b(organize|sort|order|arrange|structure|group|categorize|prioritize|cluster)\b/i,
      /\b(reorganize|clean up|tidy|outline)\b/i,
    ],
    phrase: [
      /\b(chaos|messy|scattered|disorganized|jumbled|all over the place)\b/i,
      /\bbreak.{0,10}(it |these |them |this )?(into|down).{0,20}(sections?|categories|groups|themes|buckets)\b/i,
      /\b(make sense of|put.{0,10}in order|turn.{0,20}into.{0,20}(outline|list|structure))\b/i,
      /\bbrain.?dump\b/i,
    ],
  },
  act: {
    normal: [
      /\b(execute|perform|carry out|take action)\b/i,
      /\b(file|submit|apply|register|sign up|configure|deploy|install)\b/i,
    ],
    phrase: [
      /\bgive me (the )?exact (steps?|commands?|instructions?)\b/i,
      /\bstep.by.step (instructions?|guide|walkthrough|process)\b/i,
      /\bhow (do i|do you|to) actually\b/i,
      /\bexact(ly)? (how|what steps?|which commands?)\b/i,
      /\bwalk me through (how to|the process of|exactly)\b/i,
    ],
  },
};

function keywordScore(text, intentKey) {
  const rules = KEYWORD_RULES[intentKey];
  if (!rules) return 0;
  let score = 0;
  for (const p of rules.normal) score += p.test(text) ? 1 : 0;
  for (const p of rules.phrase) score += p.test(text) ? 2 : 0;
  return score;
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

  const ranked = library
    .map((intent) => {
      const semantic = cosineSimilarity(promptVector, intent.vector);
      const keywords = keywordScore(text, intent.key);
      // Keywords dominate: hash embeddings are near-random for short prompts.
      // Each normal keyword = +0.20, each phrase = +0.40 (phrase counts as 2).
      const score = semantic * 0.40 + Math.min(keywords, 8) * 0.20;
      return { ...intent, semantic, keywords, score };
    })
    .sort((a, b) => b.score - a.score || b.semantic - a.semantic);

  const primary = ranked[0];
  // Secondary: only report if genuinely close to primary and has meaningful score
  const secondary = ranked
    .slice(1)
    .filter((i) => i.score >= 0.25 && primary.score - i.score < 0.20)
    .slice(0, 2);

  const margin = primary.score - (ranked[1]?.score || 0);
  const confidence = Math.max(0, Math.min(1, primary.score * 0.9 + margin * 0.5));

  return {
    primary: {
      key: primary.key,
      label: primary.label,
      template: primary.template,
      score: primary.score,
      semantic: primary.semantic,
      keywords: primary.keywords,
    },
    secondary: secondary.map((i) => ({
      key: i.key,
      label: i.label,
      score: i.score,
      semantic: i.semantic,
      keywords: i.keywords,
    })),
    confidence,
    nearestExamples: ranked.slice(0, 3).flatMap((i) =>
      i.examples.slice(0, 2).map((example) => ({
        intent: i.label,
        example,
        score: i.score,
      })),
    ),
    template: primary.template,
    ranked: ranked.map((i) => ({
      intent: i.key,
      score: i.score,
      semantic: i.semantic,
      keywords: i.keywords,
    })),
  };
}
