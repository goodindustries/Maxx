export function normalizeText(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\.{4,}/g, "...")
    .replace(/([!?;:,.])\1{1,}/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function splitSentences(text) {
  return normalizeText(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function normalizeForMatching(text) {
  return normalizeText(text).toLowerCase();
}
