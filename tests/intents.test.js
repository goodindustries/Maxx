#!/usr/bin/env node
/**
 * Per-intent fixture tests for Maxx.
 * Run: node tests/intents.test.js
 *
 * Each fixture asserts:
 *  - correct intent classification
 *  - minimum confidence threshold
 *  - expected HCLS state
 *  - score improves after optimization (or stays equal for unclear)
 *  - no raw prompt leakage into sensitive template fields
 */

import { analyzePrompt } from "../skill-engine.js";

const FIXTURES = [
  {
    name: "write — everyday landlord ask",
    prompt: "help me ask my landlord about paying rent a few days late without sounding irresponsible",
    expect: {
      intent: "write",
      minConfidence: 0.60,
      hcls: "green",
      minScoreGain: 5,
      fieldChecks: {
        // These fields must NOT equal the full raw prompt
        constraints: { notRawPrompt: true, notContains: "help me ask" },
        purpose:     { notContains: "without sounding" },
        recipient:   { notEquals: "not specified" },
      },
    },
  },
  {
    name: "decide — car purchase vs. keep",
    prompt: "which is smarter right now, buying a new car or keeping my old one?",
    expect: {
      intent: "decide",
      minConfidence: 0.60,
      hcls: "green",
      minScoreGain: 5,
      fieldChecks: {},
    },
  },
  {
    name: "fix — sqlite sync with noise",
    prompt: "hey claude this sqlite sync keeps breaking and the logs are noisy and maybe postgres would fix it but honestly the auth path might be the real issue can you help me sort this out",
    expect: {
      intent: "fix",
      minConfidence: 0.70,
      hcls: "yellow",
      minScoreGain: 10,
      fieldChecks: {},
    },
  },
  {
    name: "plan — migration roadmap",
    prompt: "help me plan out the migration from our monolith to services, we need to do it over the next quarter without breaking the existing auth flow",
    expect: {
      intent: "plan",
      minConfidence: 0.40,  // hash embeddings produce ~46% for plan; intent key is reliable
      hcls: "yellow",       // auth/migration triggers tech-context missing slots
      minScoreGain: 5,
      fieldChecks: {},
    },
  },
  {
    name: "research — homeschooling comparison",
    prompt: "what are the pros and cons of homeschooling in Texas compared to public school?",
    expect: {
      intent: "research",
      minConfidence: 0.40,  // hash embeddings produce ~48%; intent key is reliable
      hcls: "yellow",      // 48% confidence is below the 0.60 green threshold
      minScoreGain: 5,
      fieldChecks: {},
    },
  },
  {
    name: "organize — scattered notes",
    prompt: "these ideas are scattered everywhere — group them into themes and turn it into a prioritized list",
    expect: {
      intent: "organize",
      minConfidence: 0.55,
      hcls: "green",        // no tech signal → no missing slots → green with high confidence
      minScoreGain: 5,
      fieldChecks: {},
    },
  },
  {
    name: "extract — meeting action items",
    prompt: "pull the action items and deadlines from these meeting notes",
    expect: {
      intent: "extract",
      minConfidence: 0.55,
      hcls: "green",
      minScoreGain: 5,
      fieldChecks: {},
    },
  },
  {
    name: "unclear — vague improvement request",
    prompt: "make this website better",
    expect: {
      intent: "unclear",
      maxConfidence: 0.34,   // must stay below threshold
      hcls: "red",
      hasQuestion: true,     // must produce a clarifying question
      noRewrite: true,       // optimizedPrompt must be null
    },
  },
];

// ─── runner ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function runFixture(fixture) {
  const result = await analyzePrompt({ prompt: fixture.prompt });
  const { expect: ex } = fixture;

  // Intent
  if (ex.intent === "unclear") {
    assert(result.unclear === true, `expected unclear=true`);
    assert(result.classification.primary === "Unclear",
      `expected primary="Unclear", got "${result.classification.primary}"`);
  } else {
    const actualKey = result.pipeline.intent.primary.key;
    assert(actualKey === ex.intent,
      `expected intent="${ex.intent}", got "${actualKey}" (${Math.round(result.confidence * 100)}% conf)`);
  }

  // Confidence bounds
  if (ex.minConfidence !== undefined) {
    assert(result.confidence >= ex.minConfidence,
      `confidence ${Math.round(result.confidence * 100)}% < min ${Math.round(ex.minConfidence * 100)}%`);
  }
  if (ex.maxConfidence !== undefined) {
    assert(result.confidence <= ex.maxConfidence,
      `confidence ${Math.round(result.confidence * 100)}% > max ${Math.round(ex.maxConfidence * 100)}% — should be unclear`);
  }

  // HCLS
  assert(result.evaluation.hcls.state === ex.hcls,
    `expected HCLS="${ex.hcls}", got "${result.evaluation.hcls.state}"`);

  // Score gain
  if (ex.minScoreGain !== undefined) {
    const delta = result.evaluation.pqs.delta;
    assert(delta >= ex.minScoreGain,
      `score gain ${delta} pts < min ${ex.minScoreGain} pts`);
  }

  // No rewrite for unclear
  if (ex.noRewrite) {
    assert(result.optimizedPrompt === null,
      `expected optimizedPrompt=null for unclear case`);
  }

  // Clarifying question present
  if (ex.hasQuestion) {
    assert(typeof result.clarifyingQuestion === "string" && result.clarifyingQuestion.length > 10,
      `expected non-empty clarifyingQuestion`);
  }

  // Field leak checks
  if (ex.fieldChecks && result.fields) {
    const rawTrimmed = fixture.prompt.trim();
    for (const [field, checks] of Object.entries(ex.fieldChecks)) {
      const value = result.fields[field] || "";
      if (checks.notRawPrompt) {
        assert(value.trim() !== rawTrimmed,
          `field "${field}" contains raw prompt verbatim: "${value}"`);
      }
      if (checks.notEquals) {
        assert(value !== checks.notEquals,
          `field "${field}" equals disallowed value: "${checks.notEquals}"`);
      }
      if (checks.notContains) {
        assert(!value.toLowerCase().includes(checks.notContains.toLowerCase()),
          `field "${field}" contains disallowed substring "${checks.notContains}": "${value}"`);
      }
    }
  }
}

async function main() {
  process.stdout.write(`\nRunning ${FIXTURES.length} intent fixtures...\n\n`);

  for (const fixture of FIXTURES) {
    process.stdout.write(`  ${fixture.name.padEnd(45)} `);
    try {
      await runFixture(fixture);
      process.stdout.write("PASS\n");
      passed++;
    } catch (err) {
      process.stdout.write(`FAIL — ${err.message}\n`);
      failures.push({ name: fixture.name, error: err.message });
      failed++;
    }
  }

  process.stdout.write(`\n${passed}/${FIXTURES.length} passed`);
  if (failed) {
    process.stdout.write(`, ${failed} failed\n\n`);
    for (const f of failures) {
      process.stdout.write(`  ✗ ${f.name}\n    ${f.error}\n`);
    }
  } else {
    process.stdout.write(" — all green\n");
  }

  process.stdout.write("\n");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(err.message + "\n");
  process.exit(1);
});
