import "dotenv/config";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";

import {
  examinerSystemPrompt,
  comparisonSystemPrompt,
  cueCardPrompt,
} from "./prompts.js";
import { ComparisonSchema, CueCardSchema } from "./schemas.js";
import { clipsRouter } from "./clips.js";
import {
  transcribeModel,
  reasoning,
  transcribeAudio,
  repairTurns,
  assessTranscript,
} from "./core.js";
import { PART_TIMING, PART2_THEMES, pickRandom } from "./exam.js";
import { MODEL_CATALOG, DEFAULT_MODEL, resolveModel, withAvailability } from "./models.js";
import { QuestionSetSchema, questionSetPrompt } from "./questions.js";
import {
  recentQuestions,
  recentTopics,
  saveQuestionSet,
  markUsed,
  saveExam,
  bankStats,
} from "./db.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 5173;

if (!process.env.OPENAI_API_KEY) {
  console.warn("\n  OPENAI_API_KEY is not set. Copy .env.example to .env and add your key.\n");
}

// Built on first use, not at import: the OpenAI constructor throws when no key is
// set, and the app should still start and say so rather than refusing to boot.
let _client = null;
const client = () => (_client ??= new OpenAI());

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(here, "..", "public")));
app.use("/api/clips", clipsRouter);

// Resolved once, lazily, then reused: the model list rarely changes within a run.
let catalogPromise = null;
const catalog = () =>
  process.env.OPENAI_API_KEY
    ? (catalogPromise ??= withAvailability(MODEL_CATALOG, client))
    : Promise.resolve(MODEL_CATALOG.map((m) => ({ ...m, available: true })));

app.get("/api/config", async (_req, res) => {
  res.json({
    models: await catalog(),
    defaultModel: DEFAULT_MODEL,
    timing: PART_TIMING,
    hasKey: Boolean(process.env.OPENAI_API_KEY),
    bank: bankStats(),
  });
});

/**
 * Re-transcribes a saved recording with a real speech-to-text model. The browser's
 * Web Speech API is convenient and free but error-prone, and it tends to tidy speech
 * into fluent prose; this reads the actual audio and is asked to stay verbatim, which it does not reliably do (see evals/results).
 * Audio arrives as a raw body rather than over the socket - it is binary and large.
 */
app.post(
  "/api/transcribe",
  express.raw({ type: ["audio/*", "application/octet-stream"], limit: "40mb" }),
  async (req, res) => {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(400).json({ error: "No OPENAI_API_KEY set." });
    }
    if (!req.body?.length) {
      return res.status(400).json({ error: "No audio received." });
    }

    try {
      const startedAt = Date.now();
      const text = await transcribeAudio(client(), req.body, { mime: req.get("content-type") || undefined });
      res.json({ text, ms: Date.now() - startedAt, model: transcribeModel() });
    } catch (err) {
      console.error("[transcribe]", err);
      res.status(err?.status || 500).json({ error: err?.message || "Transcription failed" });
    }
  }
);

/**
 * Saves a generated coaching report to disk, so "read my last report" needs no
 * manual download step. Also maintained: `latest.md`, a copy of the most recent
 * report at a stable path.
 */
const REPORTS_DIR = path.join(here, "..", "data", "reports");

app.post("/api/report", async (req, res) => {
  const { filename, markdown } = req.body || {};
  if (typeof markdown !== "string" || !markdown.trim()) {
    return res.status(400).json({ error: "No report content." });
  }

  // The filename comes from the browser, so it is never trusted as a path. Strip it
  // to a bare basename and allow only a conservative character set.
  const safe = path
    .basename(String(filename || "report.md"))
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^\.+/, "")
    .slice(0, 120);
  if (!safe.endsWith(".md")) {
    return res.status(400).json({ error: "Reports must be .md files." });
  }

  try {
    await fs.promises.mkdir(REPORTS_DIR, { recursive: true });
    const target = path.join(REPORTS_DIR, safe);
    // Belt and braces: confirm the resolved path really is inside the reports dir.
    if (path.relative(REPORTS_DIR, target).startsWith("..")) {
      return res.status(400).json({ error: "Invalid filename." });
    }
    await fs.promises.writeFile(target, markdown, "utf8");
    await fs.promises.writeFile(path.join(REPORTS_DIR, "latest.md"), markdown, "utf8");
    res.json({ saved: path.relative(path.join(here, ".."), target), bytes: markdown.length });
  } catch (err) {
    console.error("[report]", err);
    res.status(500).json({ error: err.message });
  }
});

/** Lists saved reports, newest first. */
app.get("/api/reports", async (_req, res) => {
  try {
    const names = await fs.promises.readdir(REPORTS_DIR).catch(() => []);
    const files = await Promise.all(
      names
        .filter((n) => n.endsWith(".md") && n !== "latest.md")
        .map(async (name) => {
          const s = await fs.promises.stat(path.join(REPORTS_DIR, name));
          return { name, bytes: s.size, modified: s.mtime.toISOString() };
        })
    );
    files.sort((a, b) => b.modified.localeCompare(a.modified));
    res.json({ dir: path.relative(path.join(here, ".."), REPORTS_DIR), reports: files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 2 * 1024 * 1024 });

/** Convert our transcript rows into Responses API input items. */
function toInput(history) {
  return history
    .filter((t) => t.text && t.text.trim())
    .map((t) => ({
      role: t.role === "examiner" ? "assistant" : "user",
      content: t.text.trim(),
    }));
}

/** Gives the model an explicit cue to open the part when there is no history yet. */
function ensureUserFirst(input, part) {
  if (input.length && input[0].role === "user") return input;
  return [
    {
      role: "user",
      content: `[The candidate has sat down and the recorder is on. Begin Part ${part}.]`,
    },
    ...input,
  ];
}

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

/** What the UI needs to compare one run against another. */
function meta(model, startedAt, response) {
  const u = response?.usage;
  return {
    model: model.id,
    modelLabel: model.label,
    ms: Date.now() - startedAt,
    inputTokens: u?.input_tokens ?? null,
    outputTokens: u?.output_tokens ?? null,
    reasoningTokens: u?.output_tokens_details?.reasoning_tokens ?? null,
  };
}

/** Streams one examiner turn back token by token. */
async function handleExaminerTurn(ws, msg) {
  const { id, part, targetBand, cueCard, elapsedSeconds, remainingSeconds, history } = msg;
  const model = resolveModel(msg.model);
  const startedAt = Date.now();

  const stream = client().responses.stream({
    model: model.id,
    // Conversational turns run at the catalog's low effort; the examiner is asking
    // short questions, not reasoning hard. Marking always uses high effort.
    ...reasoning(model, model.effort),
    // Reasoning tokens count towards this ceiling, so leave headroom above the
    // one or two sentences the examiner actually speaks.
    max_output_tokens: 4096,
    instructions: examinerSystemPrompt({
      part,
      targetBand,
      cueCard,
      elapsedSeconds: elapsedSeconds ?? 0,
      remainingSeconds: remainingSeconds ?? 0,
      plan: msg.plan,
    }),
    input: ensureUserFirst(toInput(history || []), part),
  });

  let full = "";
  for await (const event of stream) {
    if (event.type === "response.output_text.delta") {
      full += event.delta;
      send(ws, { type: "delta", id, text: event.delta });
    }
  }

  const final = await stream.finalResponse();
  send(ws, {
    type: "turn_end",
    id,
    text: full.replace("[[PART_COMPLETE]]", "").trim(),
    partComplete: full.includes("[[PART_COMPLETE]]"),
    meta: meta(model, startedAt, final),
  });
}

/**
 * Generates a whole IELTS-standard paper, seeded against the local bank so no two
 * sittings repeat, then persists it.
 */
async function handleQuestionSet(ws, msg) {
  const model = resolveModel(msg.model);
  const startedAt = Date.now();

  const response = await client().responses.parse({
    model: model.id,
    // Paper-setting is worth thinking about: variety and correct difficulty
    // laddering are exactly what low effort gets wrong.
    ...reasoning(model, "medium"),
    max_output_tokens: 16000,
    input: [
      {
        role: "user",
        content: questionSetPrompt({
          targetBand: msg.targetBand,
          parts: msg.parts?.length ? msg.parts : [1, 2, 3],
          avoidQuestions: [...recentQuestions(1, 30), ...recentQuestions(3, 20)],
          avoidTopics: [...recentTopics(1), ...recentTopics(2, 8), ...recentTopics(3, 8)],
        }),
      },
    ],
    text: { format: zodTextFormat(QuestionSetSchema, "question_set") },
  });

  const saved = saveQuestionSet(response.output_parsed);

  saveExam({
    id: msg.examId,
    startedAt,
    parts: msg.parts || [],
    targetBand: msg.targetBand,
    model: model.id,
    set: saved,
  });

  send(ws, {
    type: "question_set",
    id: msg.id,
    set: saved,
    stats: bankStats(),
    meta: meta(model, startedAt, response),
  });
}

/** Records that a question was actually put to the candidate. */
function handleQuestionUsed(ws, msg) {
  for (const id of msg.ids || []) markUsed(id);
  send(ws, { type: "question_used", id: msg.id, stats: bankStats() });
}

async function handleCueCard(ws, msg) {
  const model = resolveModel(msg.model);
  const theme = msg.theme || pickRandom(PART2_THEMES);
  const response = await client().responses.parse({
    model: model.id,
    ...reasoning(model, model.effort),
    max_output_tokens: 4096,
    input: [{ role: "user", content: cueCardPrompt(theme) }],
    text: { format: zodTextFormat(CueCardSchema, "cue_card") },
  });
  send(ws, { type: "cue_card", id: msg.id, card: response.output_parsed });
}

async function handleAssess(ws, msg) {
  const { id, transcript, targetBand, part } = msg;
  const model = resolveModel(msg.model);
  const startedAt = Date.now();

  const response = await assessTranscript(client(), model, {
    transcript,
    targetBand,
    part,
    disagreements: msg.disagreements,
  });

  send(ws, {
    type: "assessment",
    id,
    data: response.output_parsed,
    meta: meta(model, startedAt, response),
  });
}

async function handleCompare(ws, msg) {
  const { id, question, attemptA, attemptB, targetBand } = msg;
  const model = resolveModel(msg.model);
  const startedAt = Date.now();

  const response = await client().responses.parse({
    model: model.id,
    ...reasoning(model, "high"),
    max_output_tokens: 32000,
    instructions: comparisonSystemPrompt({ targetBand }),
    input: [
      {
        role: "user",
        content:
          `QUESTION\n${question}\n\n` +
          `ATTEMPT 1 (${attemptA.date || "earlier"})\n${attemptA.text}\n\n` +
          `ATTEMPT 2 (${attemptB.date || "latest"})\n${attemptB.text}`,
      },
    ],
    text: { format: zodTextFormat(ComparisonSchema, "comparison") },
  });

  send(ws, {
    type: "comparison",
    id,
    data: response.output_parsed,
    meta: meta(model, startedAt, response),
  });
}

/** Repairs recogniser artefacts in the transcript; see `repairTurns`. */
async function handleRepair(ws, msg) {
  const model = resolveModel(msg.model);
  const startedAt = Date.now();

  const response = await repairTurns(client(), model, msg.turns);

  send(ws, {
    type: "repair",
    id: msg.id,
    data: response.output_parsed,
    meta: meta(model, startedAt, response),
  });
}

const ROUTES = {
  question_set: handleQuestionSet,
  repair: handleRepair,
  question_used: handleQuestionUsed,
  examiner_turn: handleExaminerTurn,
  cue_card: handleCueCard,
  assess: handleAssess,
  compare: handleCompare,
};

wss.on("connection", (ws) => {
  send(ws, { type: "ready", defaultModel: DEFAULT_MODEL });

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send(ws, { type: "error", error: "Malformed message" });
    }

    const handler = ROUTES[msg.type];
    if (!handler) return send(ws, { type: "error", id: msg.id, error: `Unknown type: ${msg.type}` });

    if (!process.env.OPENAI_API_KEY) {
      return send(ws, {
        type: "error",
        id: msg.id,
        error: "No OPENAI_API_KEY. Copy .env.example to .env, add your key, and restart the server.",
      });
    }

    try {
      await handler(ws, msg);
    } catch (err) {
      console.error(`[${msg.type}] [${msg.model || DEFAULT_MODEL}]`, err);
      const status = err?.status;
      const hint =
        status === 401
          ? "Invalid OPENAI_API_KEY - check the key in your .env file."
          : status === 404
            ? `Your account cannot access "${msg.model}". Pick another model, or remove it from server/models.js.`
            : status === 429
              ? "Rate limited or out of quota. Check your OpenAI billing, then retry."
              : status >= 500
                ? "OpenAI is temporarily unavailable. Retry in a few seconds."
                : err?.message || "Unknown error";
      send(ws, { type: "error", id: msg.id, error: hint });
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n  IELTS Speaking coach running:  http://localhost:${PORT}`);
  console.log(`  Models available: ${MODEL_CATALOG.map((m) => m.id).join(", ")}`);
  console.log(`  Default: ${DEFAULT_MODEL}\n`);
});
