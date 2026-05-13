// Treatment path: messy prompt → Maxx/Qwen compiles → cleanedPrompt → Claude answers.
// Qwen is the optimizer. Claude is the test environment, identical to the control path.
export default class MaxxProvider {
  id() {
    return "maxx";
  }

  async callApi(prompt) {
    // Step 1: Maxx/Qwen compiles the messy prompt
    const compileRes = await fetch("http://127.0.0.1:4187/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });

    if (!compileRes.ok) {
      const text = await compileRes.text().catch(() => "");
      throw new Error(`/ask failed ${compileRes.status}: ${text}`);
    }

    const compiled = await compileRes.json();

    if (compiled.unclear) {
      // Maxx flagged as too unclear to compile — pass raw to Claude so eval can still score it
      const rawRes = await fetch("http://127.0.0.1:4187/raw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, provider: "claude" }),
      });
      const rawData = await rawRes.json();
      return {
        output: rawData.output,
        metadata: { rawPrompt: prompt, unclear: true },
      };
    }

    const cleanedPrompt = compiled.cleanedPrompt;

    // Step 2: send cleanedPrompt to the same downstream LLM (Claude) as the control
    const answerRes = await fetch("http://127.0.0.1:4187/raw", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: cleanedPrompt, provider: "claude" }),
    });

    if (!answerRes.ok) {
      const text = await answerRes.text().catch(() => "");
      throw new Error(`/raw (maxx path) failed ${answerRes.status}: ${text}`);
    }

    const answer = await answerRes.json();

    return {
      output: answer.output,
      metadata: {
        rawPrompt:        prompt,
        cleanedPrompt,
        maxxScore:        compiled.score?.total,
        intent:           compiled.classification?.primary,
        intentConfidence: compiled.classification?.confidence,
      },
    };
  }
}
