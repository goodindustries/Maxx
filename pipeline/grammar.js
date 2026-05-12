function applyMatches(text, matches) {
  const sorted = [...matches]
    .filter((match) => Number.isInteger(match.offset) && Number.isInteger(match.length))
    .sort((a, b) => b.offset - a.offset);

  let value = text;
  for (const match of sorted) {
    const replacement = match.replacements?.[0]?.value;
    if (!replacement) {
      continue;
    }

    const before = value.slice(0, match.offset);
    const after = value.slice(match.offset + match.length);
    value = `${before}${replacement}${after}`;
  }

  return value;
}

export async function correctGrammar(text, options = {}) {
  const endpoint = options.languageToolUrl || process.env.MAXX_LANGUAGE_TOOL_URL;
  if (!endpoint) {
    return { text, applied: false, source: "none" };
  }

  const baseUrl = endpoint.replace(/\/$/, "");
  const checkUrl = baseUrl.endsWith("/v2/check") ? baseUrl : `${baseUrl}/v2/check`;

  try {
    const response = await fetch(checkUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        text,
        language: options.language || "en-US",
      }),
    });

    if (!response.ok) {
      return { text, applied: false, source: "languagetool", error: `HTTP ${response.status}` };
    }

    const payload = await response.json();
    const matches = Array.isArray(payload.matches) ? payload.matches : [];
    if (!matches.length) {
      return { text, applied: false, source: "languagetool" };
    }

    return {
      text: applyMatches(text, matches),
      applied: true,
      source: "languagetool",
      matchCount: matches.length,
    };
  } catch (error) {
    return { text, applied: false, source: "languagetool", error: error.message || String(error) };
  }
}
