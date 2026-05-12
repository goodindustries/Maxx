import { normalizeForMatching } from "./normalize.js";

function hashToken(token) {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function hashEmbedding(text, dimensions = 256) {
  const vector = new Array(dimensions).fill(0);
  const tokens = normalizeForMatching(text).match(/\b[\p{L}\p{N}_]+\b/gu) || [];

  for (const token of tokens) {
    const hash = hashToken(token);
    vector[hash % dimensions] += 1;
  }

  for (let index = 0; index < tokens.length - 1; index += 1) {
    const bigram = `${tokens[index]}_${tokens[index + 1]}`;
    const hash = hashToken(bigram);
    vector[hash % dimensions] += 0.5;
  }

  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / magnitude);
}

async function fetchEmbedding(text, options = {}) {
  const endpoint = options.embeddingUrl || process.env.MAXX_EMBEDDING_URL;
  if (!endpoint) {
    return null;
  }

  const model = options.embeddingModel || process.env.MAXX_EMBEDDING_MODEL || "all-MiniLM-L6-v2";
  const baseUrl = endpoint.replace(/\/$/, "");
  const requestUrl = baseUrl.endsWith("/embed") ? baseUrl : `${baseUrl}/embed`;

  try {
    const response = await fetch(requestUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        texts: [text],
      }),
    });

    if (!response.ok) {
      return null;
    }

    const payload = await response.json();
    const embedding =
      payload.embedding ||
      payload.vector ||
      payload.embeddings?.[0] ||
      payload.data?.[0]?.embedding ||
      null;

    return Array.isArray(embedding) ? embedding.map((value) => Number(value)) : null;
  } catch {
    return null;
  }
}

export async function embedText(text, options = {}) {
  const remote = await fetchEmbedding(text, options);
  return remote || hashEmbedding(text, options.dimensions || 256);
}

export async function embedTexts(texts, options = {}) {
  const embeddings = [];
  for (const text of texts) {
    embeddings.push(await embedText(text, options));
  }
  return embeddings;
}

export function cosineSimilarity(a, b) {
  let dot = 0;
  let left = 0;
  let right = 0;
  const size = Math.min(a.length, b.length);

  for (let index = 0; index < size; index += 1) {
    dot += a[index] * b[index];
    left += a[index] * a[index];
    right += b[index] * b[index];
  }

  const denominator = Math.sqrt(left) * Math.sqrt(right);
  return denominator ? dot / denominator : 0;
}
