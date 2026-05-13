// Custom Promptfoo assertion: objective quality signals for model outputs.
// Scores 0–1 based on structure, directness, and specificity.
// Does not require an external LLM — runs locally.

export default function outputQuality(output) {
  const text = typeof output === "string" ? output.toLowerCase() : String(output ?? "").toLowerCase();
  const raw = typeof output === "string" ? output : String(output ?? "");

  let score = 0;

  // Length — something substantive was produced
  if (raw.length > 100) score += 0.15;

  // Structure signals — steps, options, recommendations
  if (/\b(step|steps|first|next|then|recommend|option|criteria|consider)\b/.test(text)) score += 0.2;

  // Asks a clarifying question (useful for vague inputs)
  if (/\?/.test(raw)) score += 0.1;

  // Avoids canned AI hedging phrases
  if (!/\bas an ai\b/.test(text)) score += 0.15;
  if (!/\bit depends\b/.test(text)) score += 0.1;

  // Engages with missing context rather than ignoring it
  if (/\b(missing|clarify|context|criteria|need|specify|provide)\b/.test(text)) score += 0.15;

  // Uses goal/constraint language (draft, tone, audience, output)
  if (/\b(must|avoid|tone|audience|goal|format|output)\b/.test(text)) score += 0.15;

  const finalScore = Math.min(score, 1);

  return {
    pass: finalScore >= 0.45,
    score: finalScore,
    reason: `output-quality: ${Math.round(finalScore * 100)}%`,
  };
}
