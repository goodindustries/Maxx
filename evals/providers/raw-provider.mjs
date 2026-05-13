// Control path: messy prompt → Claude directly, no Maxx.
// Claude only answers here. It never rewrites or optimizes.
export default class RawProvider {
  id() {
    return "raw";
  }

  async callApi(prompt) {
    const res = await fetch("http://127.0.0.1:4187/raw", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, provider: "claude" }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`/raw failed ${res.status}: ${text}`);
    }

    const data = await res.json();
    return { output: data.output };
  }
}
