import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const promptPath = join(__dirname, "prompts", "code-navigator-system-prompt.md");
const envPath = join(__dirname, ".env");

async function loadLocalEnv() {
  try {
    const envFile = await readFile(envPath, "utf8");

    for (const line of envFile.split(/\r?\n/)) {
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const separatorIndex = trimmed.indexOf("=");

      if (separatorIndex === -1) {
        continue;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      const rawValue = trimmed.slice(separatorIndex + 1).trim();
      const value = rawValue.replace(/^["']|["']$/g, "");

      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

await loadLocalEnv();

const PORT = Number(process.env.PORT || 3000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const MAX_CODE_CHARACTERS = 12000;

const modeProfiles = {
  beginner: {
    label: "Beginner mode",
    tone: "Plain language, minimal jargon, patient explanations, short analogies when useful.",
    structure: [
      "Summary",
      "Step-by-step walkthrough",
      "Key observations",
      "Risks / uncertainty",
      "Follow-up questions",
      "Suggested next step"
    ],
    instructions: [
      "Explain what the code is doing before naming advanced concepts.",
      "Use simple analogies only when they clarify the code.",
      "Break execution into small, ordered steps.",
      "Define necessary technical terms briefly."
    ]
  },
  debug: {
    label: "Debug mode",
    tone: "Direct, evidence-based, focused on failure points and unsafe assumptions.",
    structure: [
      "Summary",
      "Suspicious patterns",
      "Possible failures",
      "Edge cases",
      "Follow-up questions",
      "Suggested next step"
    ],
    instructions: [
      "Separate confirmed issues from possible issues.",
      "Call out missing context that prevents confident debugging.",
      "Focus on runtime errors, state issues, invalid inputs, and dependency assumptions.",
      "Avoid style advice unless it affects reliability."
    ]
  },
  architecture: {
    label: "Architecture mode",
    tone: "System-level, structural, focused on responsibilities, boundaries, and data flow.",
    structure: [
      "Summary",
      "Component relationships",
      "Data flow",
      "Responsibilities",
      "Architectural risks / uncertainty",
      "Follow-up questions"
    ],
    instructions: [
      "Describe visible components and how they relate.",
      "Identify responsibilities, dependencies, coupling, and boundaries.",
      "State when a snippet is too isolated for architectural conclusions.",
      "Ask for surrounding files when needed for system-level understanding."
    ]
  }
};

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function readRequestBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
}

function extractOutputText(responseData) {
  if (typeof responseData.output_text === "string") {
    return responseData.output_text;
  }

  const parts = [];

  for (const item of responseData.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) {
        parts.push(content.text);
      }
    }
  }

  return parts.join("\n").trim();
}

function buildModeContract(mode) {
  const profile = modeProfiles[mode];

  return [
    `Mode contract: ${profile.label}`,
    `Tone: ${profile.tone}`,
    "",
    "Mode-specific output structure:",
    ...profile.structure.map((section, index) => `${index + 1}. ${section}`),
    "",
    "Mode-specific instructions:",
    ...profile.instructions.map((instruction) => `- ${instruction}`)
  ].join("\n");
}

function buildTooLargeResponse(codeLength) {
  return [
    "## Summary",
    "",
    `- The pasted code is ${codeLength} characters, which is above the current ${MAX_CODE_CHARACTERS} character limit for a reliable single-pass analysis.`,
    "",
    "## Key observations",
    "",
    "- The system is intentionally refusing the request instead of producing a weak or partial explanation.",
    "- Large code samples often need file boundaries, module names, and dependency context to be explained correctly.",
    "",
    "## Risks / uncertainty",
    "",
    "- A single oversized snippet may hide important relationships between files.",
    "- Architecture and debugging conclusions would be unreliable without knowing which parts belong together.",
    "",
    "## Follow-up questions",
    "",
    "- Which function, component, class, or module should be analyzed first?",
    "- Is this code part of a frontend, backend, library, script, or test file?",
    "",
    "## Suggested next step",
    "",
    "- Paste a smaller section of code or provide the most relevant file first."
  ].join("\n");
}

async function analyzeCode(req, res) {
  if (!OPENAI_API_KEY) {
    sendJson(res, 500, {
      error: "OPENAI_API_KEY is not configured. Set it before starting the server."
    });
    return;
  }

  let payload;

  try {
    payload = JSON.parse(await readRequestBody(req));
  } catch {
    sendJson(res, 400, { error: "Request body must be valid JSON." });
    return;
  }

  const code = String(payload.code || "").trim();
  const mode = String(payload.mode || "beginner").trim().toLowerCase();

  if (!code) {
    sendJson(res, 400, { error: "Paste code before requesting an explanation." });
    return;
  }

  if (!modeProfiles[mode]) {
    sendJson(res, 400, { error: "Mode must be beginner, debug, or architecture." });
    return;
  }

  if (code.length > MAX_CODE_CHARACTERS) {
    sendJson(res, 413, {
      mode,
      model: "local-fallback",
      output: buildTooLargeResponse(code.length)
    });
    return;
  }

  const systemPrompt = await readFile(promptPath, "utf8");
  const userPrompt = [
    `Selected mode: ${mode}`,
    "",
    buildModeContract(mode),
    "",
    "Code to analyze:",
    "```",
    code,
    "```"
  ].join("\n");

  try {
    const apiResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        instructions: systemPrompt,
        input: userPrompt,
        temperature: 0.2
      })
    });

    const data = await apiResponse.json();

    if (!apiResponse.ok) {
      sendJson(res, apiResponse.status, {
        error: data.error?.message || "OpenAI API request failed."
      });
      return;
    }

    sendJson(res, 200, {
      mode,
      model: OPENAI_MODEL,
      output: extractOutputText(data)
    });
  } catch (error) {
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : "Unexpected server error."
    });
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, safePath);

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const file = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": contentTypes[extname(filePath)] || "application/octet-stream"
    });
    res.end(file);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

const server = createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/api/analyze") {
    await analyzeCode(req, res);
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    await serveStatic(req, res);
    return;
  }

  res.writeHead(405);
  res.end("Method not allowed");
});

server.listen(PORT, () => {
  console.log(`Code Navigator running at http://localhost:${PORT}`);
});
