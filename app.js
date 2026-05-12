import { analyzePrompt, skillSamples } from "./skill-engine.js";

const $ = (selector) => document.querySelector(selector);

const sampleOrder = [
  { key: "debugging", label: "Debugging" },
  { key: "architecture", label: "Architecture" },
  { key: "generation", label: "Code generation" },
  { key: "refactor", label: "Refactor" },
  { key: "explanation", label: "Explanation" },
];

const state = {
  activeSample: "debugging",
  lastOptimizedPrompt: "",
};

function getFormData() {
  return {
    prompt: $("#promptInput").value,
    framework: $("#frameworkInput").value,
    language: $("#languageInput").value,
    repoType: $("#repoTypeInput").value,
    modelType: $("#modelTypeInput").value,
  };
}

function setFormData(prompt) {
  $("#promptInput").value = prompt || "";
}

function renderSamples() {
  const container = $("#sampleButtons");
  container.innerHTML = sampleOrder
    .map(
      (sample) => `
        <button class="sample-chip ${sample.key === state.activeSample ? "active" : ""}" type="button" data-sample="${sample.key}">
          ${sample.label}
        </button>
      `,
    )
    .join("");

  container.querySelectorAll("[data-sample]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeSample = button.dataset.sample;
      renderSamples();
      setFormData(skillSamples[state.activeSample]);
      renderEmptyState();
    });
  });
}

function renderEmptyState() {
  $("#classificationList").innerHTML = `
    <div class="result-item">
      <div class="result-label">Task Classification</div>
      <div class="result-value">Load or paste a prompt, then optimize it.</div>
    </div>
  `;
  $("#problemsList").innerHTML = `
    <div class="result-item">
      <div class="result-label">Problems Detected</div>
      <div class="result-detail">Maxx will surface mixed objectives, missing constraints, oversized context, and weak output definitions.</div>
    </div>
  `;
  $("#optimizedPrompt").textContent = "Optimized prompt will appear here.";
  $("#notesList").innerHTML = `
    <li>Focus on one developer task at a time.</li>
    <li>Keep the rewrite structurally tighter than the original.</li>
    <li>Preserve the user's intent instead of adding new goals.</li>
  `;
  state.lastOptimizedPrompt = $("#optimizedPrompt").textContent;
}

function renderAnalysis(analysis) {
  const classification = analysis.classification;
  $("#classificationList").innerHTML = [
    {
      label: "Primary type",
      value: classification.primary,
      detail: classification.secondary.length ? `Secondary: ${classification.secondary.join(", ")}` : "No strong secondary type detected.",
    },
    {
      label: "Environment",
      value: classification.environment.length ? classification.environment.join(" · ") : "Not specified",
      detail: classification.tags.length ? `Tags: ${classification.tags.join(", ")}` : "No extra tags detected.",
    },
    {
      label: "Confidence",
      value: `${Math.round((classification.confidence || 0) * 100)}%`,
      detail: classification.nearestExamples?.length
        ? `Nearest: ${classification.nearestExamples[0].intent}`
        : "No nearest example available.",
    },
  ]
    .map(
      (item) => `
        <div class="result-item">
          <div class="result-label">${item.label}</div>
          <div class="result-value">${item.value}</div>
          <div class="result-detail">${item.detail}</div>
        </div>
      `,
    )
    .join("");

  if (analysis.problems.length) {
    $("#problemsList").innerHTML = analysis.problems
      .map(
        (issue) => `
          <div class="result-item">
            <div class="result-label">${issue.title}</div>
            <div class="result-detail">${issue.detail}</div>
            <div class="result-detail">Action: ${issue.action}</div>
          </div>
        `,
      )
      .join("");
  } else {
    $("#problemsList").innerHTML = `
      <div class="result-item">
        <div class="result-label">No major issues detected</div>
        <div class="result-detail">The prompt is already fairly structured.</div>
      </div>
    `;
  }

  if (analysis.followUpQuestion) {
    $("#problemsList").insertAdjacentHTML(
      "beforeend",
      `
        <div class="result-item">
          <div class="result-label">Missing input</div>
          <div class="result-detail">${analysis.followUpQuestion}</div>
        </div>
      `,
    );
  }

  $("#optimizedPrompt").textContent = analysis.optimizedPrompt;
  $("#notesList").innerHTML = analysis.notes.map((note) => `<li>${note}</li>`).join("");
  state.lastOptimizedPrompt = analysis.optimizedPrompt;
}

async function optimizePrompt() {
  const formData = getFormData();
  const analysis = await analyzePrompt(formData);
  renderAnalysis(analysis);

  try {
    await fetch("/api/skill/optimize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(formData),
    });
  } catch {
    // The local analysis is the primary runtime. The API exists for integration parity.
  }
}

async function copyOptimizedPrompt() {
  await navigator.clipboard.writeText(state.lastOptimizedPrompt || $("#optimizedPrompt").textContent || "");
}

function wireActions() {
  $("#optimizeButton").addEventListener("click", optimizePrompt);
  $("#clearButton").addEventListener("click", () => {
    setFormData("");
    $("#frameworkInput").value = "";
    $("#languageInput").value = "";
    $("#repoTypeInput").value = "";
    $("#modelTypeInput").value = "";
    renderEmptyState();
  });

  $("#copySampleButton").addEventListener("click", () => {
    setFormData(skillSamples[state.activeSample]);
    optimizePrompt();
  });

  $("#copyOptimizedButton").addEventListener("click", copyOptimizedPrompt);
}

function bootstrap() {
  renderSamples();
  renderEmptyState();
  wireActions();
  setFormData(skillSamples.debugging);
}

bootstrap();
