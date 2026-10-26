import "dotenv/config";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";

import {
  examinerSystemPrompt,
  comparisonSystemPrompt,
  cueCardPrompt,
} from "./prompts.js";
import { ComparisonSchema, CueCardSchema } from "./schemas.js";
import { clipsRouter } from "./clips.js";
import { buildInput } from "./history.js";
import {
  transcribeModel,
  canTranscribe,
  transcribeAudio,
  repairTurns,
  assessTranscript,
} from "./core.js";
import { providers, llmFor } from "./providers/index.js";
import { PART_TIMING, PART2_THEMES, pickRandom } from "./exam.js";
import { MODEL_CATALOG, defaultModelId, resolveModel as resolveCatalogModel, withAvailability } from "./models.js";
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

const resolveModel = (requested) => resolveCatalogModel(requested, providers);
const DEFAULT_MODEL = defaultModelId(providers);

if (!providers.some((p) => p.configured())) {
  console.warn(
    `\n  No provider key is set. Copy .env.example to .env and add ${providers.map((p) => p.keyEnv).join(" or ")}.\n`
  );
}

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(here, "..", "public")));
app.use("/api/clips", clipsRouter);

// Resolved once, lazily, then reused: the model list rarely changes within a run.
let catalogPromise = null;
const catalog = () => (catalogPromise ??= withAvailability(MODEL_CATALOG, providers));

app.get("/api/config", async (_req, res) => {
  const models = await catalog();
  // The first usable model, so the picker never opens on one that cannot run.
  const usable = models.filter((m) => m.available);
  res.json({
    models,
    providers: providers.map((p) => ({ id: p.id, label: p.label, keyEnv: p.keyEnv, configured: p.configured() })),
    defaultModel: usable.some((m) => m.id === DEFAULT_MODEL) ? DEFAULT_MODEL : usable[0]?.id ?? DEFAULT_MODEL,
    timing: PART_TIMING,
    hasKey: providers.some((p) => p.configured()),
    canTranscribe: canTranscribe(),
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
    if (!canTranscribe()) {
      return res.status(400).json({
        error: "Audio transcription needs OPENAI_API_KEY. Anthropic has no speech-to-text model, so marking uses the browser transcript.",
      });
    }
    if (!req.body?.length) {
      return res.status(400).json({ error: "No audio received." });
    }

    try {
      const startedAt = Date.now();
      const text = await transcribeAudio(req.body, { mime: req.get("content-type") || undefined });
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

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

/** What the UI needs to compare one run against another, whichever provider ran it. */
function meta(model, startedAt, usage) {
  return {
    model: model.id,
    modelLabel: model.label,
    provider: model.provider,
    ms: Date.now() - startedAt,
    inputTokens: usage?.input ?? null,
    outputTokens: usage?.output ?? null,
    reasoningTokens: usage?.reasoning ?? null,
  };
}

/** Streams one examiner turn back token by token. */
async function handleExaminerTurn(ws, msg) {
  const { id, part, targetBand, cueCard, elapsedSeconds, remainingSeconds, history } = msg;
  const model = resolveModel(msg.model);
  const startedAt = Date.now();

  const { text: full, usage } = await llmFor(model).stream({
    model,
    // Conversational turns run at the catalog's low effort; the examiner is asking
    // short questions, not reasoning hard. Marking always uses high effort.
    effort: model.effort,
    // Reasoning tokens count towards this ceiling, so leave headroom above the
    // one or two sentences the examiner actually speaks.
    maxTokens: 4096,
    system: examinerSystemPrompt({
      part,
      targetBand,
      cueCard,
      elapsedSeconds: elapsedSeconds ?? 0,
      remainingSeconds: remainingSeconds ?? 0,
      plan: msg.plan,
    }),
    input: buildInput(history, part),
    onDelta: (text) => send(ws, { type: "delta", id, text }),
  });

  send(ws, {
    type: "turn_end",
    id,
    text: full.replace("[[PART_COMPLETE]]", "").trim(),
    partComplete: full.includes("[[PART_COMPLETE]]"),
    meta: meta(model, startedAt, usage),
  });
}

/**
 * Generates a whole IELTS-standard paper, seeded against the local bank so no two
 * sittings repeat, then persists it.
 */
async function handleQuestionSet(ws, msg) {
  const model = resolveModel(msg.model);
  const startedAt = Date.now();

  const { data, usage } = await llmFor(model).parse({
    model,
    // Paper-setting is worth thinking about: variety and correct difficulty
    // laddering are exactly what low effort gets wrong.
    effort: "medium",
    maxTokens: 16000,
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
    schema: QuestionSetSchema,
    schemaName: "question_set",
  });

  const saved = saveQuestionSet(data);

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
    meta: meta(model, startedAt, usage),
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
  const { data } = await llmFor(model).parse({
    model,
    effort: model.effort,
    maxTokens: 4096,
    input: [{ role: "user", content: cueCardPrompt(theme) }],
    schema: CueCardSchema,
    schemaName: "cue_card",
  });
  send(ws, { type: "cue_card", id: msg.id, card: data });
}

async function handleAssess(ws, msg) {
  const { id, transcript, targetBand, part } = msg;
  const model = resolveModel(msg.model);
  const startedAt = Date.now();

  const { data, usage } = await assessTranscript(model, {
    transcript,
    targetBand,
    part,
    disagreements: msg.disagreements,
  });

  send(ws, { type: "assessment", id, data, meta: meta(model, startedAt, usage) });
}

async function handleCompare(ws, msg) {
  const { id, question, attemptA, attemptB, targetBand } = msg;
  const model = resolveModel(msg.model);
  const startedAt = Date.now();

  const { data, usage } = await llmFor(model).parse({
    model,
    effort: "high",
    maxTokens: 32000,
    system: comparisonSystemPrompt({ targetBand }),
    input: [
      {
        role: "user",
        content:
          `QUESTION\n${question}\n\n` +
          `ATTEMPT 1 (${attemptA.date || "earlier"})\n${attemptA.text}\n\n` +
          `ATTEMPT 2 (${attemptB.date || "latest"})\n${attemptB.text}`,
      },
    ],
    schema: ComparisonSchema,
    schemaName: "comparison",
  });

  send(ws, { type: "comparison", id, data, meta: meta(model, startedAt, usage) });
}

/** Repairs recogniser artefacts in the transcript; see `repairTurns`. */
async function handleRepair(ws, msg) {
  const model = resolveModel(msg.model);
  const startedAt = Date.now();

  const { data, usage } = await repairTurns(model, msg.turns);

  send(ws, { type: "repair", id: msg.id, data, meta: meta(model, startedAt, usage) });
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
    // "null", "7" and "[]" all parse, and none of them is a message.
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
      return send(ws, { type: "error", error: "Malformed message" });
    }

    const handler = ROUTES[msg.type];
    if (!handler) return send(ws, { type: "error", id: msg.id, error: `Unknown type: ${msg.type}` });

    try {
      await handler(ws, msg);
    } catch (err) {
      console.error(`[${msg.type}] [${msg.model || DEFAULT_MODEL}]`, err);
      const status = err?.status;
      const model = resolveModel(msg.model);
      const who = providers.find((p) => p.id === model.provider);
      const hint =
        status === 401
          ? `Invalid ${who?.keyEnv ?? "API key"} - check the key in your .env file.`
          : status === 404
            ? `Your account cannot access "${model.id}". Pick another model, or remove it from server/models.js.`
            : status === 429
              ? `Rate limited or out of quota. Check your ${who?.label ?? "provider"} billing, then retry.`
              : status >= 500
                ? `${who?.label ?? "The provider"} is temporarily unavailable. Retry in a few seconds.`
                : err?.message || "Unknown error";
      send(ws, { type: "error", id: msg.id, error: hint });
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n  IELTS Speaking coach running:  http://localhost:${PORT}`);
  console.log(`  Providers: ${providers.map((p) => `${p.label} ${p.configured() ? "ready" : `(set ${p.keyEnv})`}`).join(", ")}`);
  console.log(`  Default model: ${DEFAULT_MODEL}\n`);
});
