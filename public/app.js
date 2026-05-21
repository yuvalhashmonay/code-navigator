const form = document.querySelector("#navigator-form");
const modeInput = document.querySelector("#mode");
const codeInput = document.querySelector("#code-input");
const output = document.querySelector("#output");
const status = document.querySelector("#status");
const analyzeButton = document.querySelector("#analyze-button");
const clearButton = document.querySelector("#clear-button");
const modeTitle = document.querySelector("#mode-contract-title");
const modeTone = document.querySelector("#mode-tone");
const modeStructure = document.querySelector("#mode-structure");
const modeFallbacks = document.querySelector("#mode-fallbacks");

const modeContracts = {
  beginner: {
    title: "Beginner mode",
    tone: "Simple language, short analogies, and step-by-step explanation.",
    structure: [
      "Summary",
      "Step-by-step walkthrough",
      "Key observations",
      "Risks / uncertainty",
      "Follow-up questions",
      "Suggested next step"
    ],
    fallbacks: [
      "Names unclear dependencies instead of explaining hidden behavior.",
      "Asks for missing setup when the snippet is incomplete.",
      "Explains only what is visible in the pasted code."
    ]
  },
  debug: {
    title: "Debug mode",
    tone: "Direct review of suspicious patterns, possible failures, and edge cases.",
    structure: [
      "Summary",
      "Suspicious patterns",
      "Possible failures",
      "Edge cases",
      "Follow-up questions",
      "Suggested next step"
    ],
    fallbacks: [
      "Separates confirmed bugs from possible issues.",
      "Asks for error messages, inputs, or runtime context when needed.",
      "Avoids guessing about external functions or data shapes."
    ]
  },
  architecture: {
    title: "Architecture mode",
    tone: "System-level view of responsibilities, relationships, boundaries, and data flow.",
    structure: [
      "Summary",
      "Component relationships",
      "Data flow",
      "Responsibilities",
      "Architectural risks / uncertainty",
      "Follow-up questions"
    ],
    fallbacks: [
      "Flags when one snippet is not enough for architecture conclusions.",
      "Asks for surrounding files, imports, or module boundaries.",
      "Does not invent services, layers, or file structure."
    ]
  }
};

function setStatus(message, state = "idle") {
  status.textContent = message;
  status.dataset.state = state;
}

function setBusy(isBusy) {
  analyzeButton.disabled = isBusy;
  modeInput.disabled = isBusy;
  codeInput.disabled = isBusy;
}

function getSectionTone(heading) {
  const normalized = heading.toLowerCase();

  if (normalized.includes("risk") || normalized.includes("uncertainty") || normalized.includes("failure")) {
    return "risk";
  }

  if (normalized.includes("question")) {
    return "question";
  }

  if (normalized.includes("suggested") || normalized.includes("next step")) {
    return "next";
  }

  if (normalized.includes("suspicious") || normalized.includes("edge")) {
    return "warning";
  }

  if (normalized.includes("summary")) {
    return "summary";
  }

  return "neutral";
}

function appendParagraph(section, text) {
  const paragraph = document.createElement("p");
  paragraph.textContent = text;
  section.append(paragraph);
}

function appendBullet(section, text) {
  let list = section.querySelector("ul");

  if (!list) {
    list = document.createElement("ul");
    section.append(list);
  }

  const item = document.createElement("li");
  item.textContent = text;
  list.append(item);
}

function createOutputSection(heading) {
  const section = document.createElement("section");
  section.className = "output-section";
  section.dataset.tone = getSectionTone(heading);

  const title = document.createElement("h3");
  title.textContent = heading;
  section.append(title);

  return section;
}

function renderOutput(text, emptyMessage = "No output returned.") {
  output.replaceChildren();

  if (!text.trim()) {
    const placeholder = document.createElement("p");
    placeholder.className = "output-placeholder";
    placeholder.textContent = emptyMessage;
    output.append(placeholder);
    return;
  }

  const lines = text.split(/\r?\n/);
  let currentSection;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      continue;
    }

    const headingMatch = trimmed.match(/^#{1,3}\s+(.+)$/);

    if (headingMatch) {
      currentSection = createOutputSection(headingMatch[1]);
      output.append(currentSection);
      continue;
    }

    if (!currentSection) {
      currentSection = createOutputSection("Response");
      output.append(currentSection);
    }

    const bulletMatch = trimmed.match(/^[-*]\s+(.+)$/);
    const numberedMatch = trimmed.match(/^\d+\.\s+(.+)$/);

    if (bulletMatch) {
      appendBullet(currentSection, bulletMatch[1]);
    } else if (numberedMatch) {
      appendBullet(currentSection, numberedMatch[1]);
    } else {
      appendParagraph(currentSection, trimmed);
    }
  }
}

function renderList(element, items) {
  element.replaceChildren();

  for (const item of items) {
    const listItem = document.createElement("li");
    listItem.textContent = item;
    element.append(listItem);
  }
}

function updateModeContract(mode) {
  const contract = modeContracts[mode];

  modeTitle.textContent = contract.title;
  modeTone.textContent = contract.tone;
  renderList(modeStructure, contract.structure);
  renderList(modeFallbacks, contract.fallbacks);
}

modeInput.addEventListener("change", () => {
  updateModeContract(modeInput.value);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const code = codeInput.value.trim();
  const mode = modeInput.value;

  if (!code) {
    renderOutput("## Input needed\n- Paste code before requesting an explanation.");
    setStatus("Input needed", "error");
    codeInput.focus();
    return;
  }

  setBusy(true);
  setStatus("Analyzing", "loading");
  renderOutput("## Analyzing\n- Generating structured explanation...");

  try {
    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ code, mode })
    });

    const data = await response.json();

    if (!response.ok && response.status !== 413) {
      throw new Error(data.error || "Analysis failed.");
    }

    renderOutput(data.output || "");
    setStatus(response.status === 413 ? "Fallback" : `${data.mode} mode`, "success");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error.";
    renderOutput(`## Error\n- ${message}`);
    setStatus("Error", "error");
  } finally {
    setBusy(false);
  }
});

clearButton.addEventListener("click", () => {
  codeInput.value = "";
  renderOutput("", "The structured explanation will appear here.");
  setStatus("Ready");
  codeInput.focus();
});

updateModeContract(modeInput.value);
renderOutput("", "The structured explanation will appear here.");
