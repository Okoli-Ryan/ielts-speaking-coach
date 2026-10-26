/**
 * The model calls that decide what a candidate's mark is built from: transcribing,
 * repairing and marking. They live apart from the WebSocket handlers so the evals
 * in `evals/` exercise the exact code path the app does, not a copy of it.
 */
import { toFile } from "openai";
import { zodTextFormat } from "openai/helpers/zod";

import { assessorSystemPrompt, repairSystemPrompt, TRANSCRIBE_PROMPT } from "./prompts.js";
import { AssessmentSchema, RepairSchema } from "./schemas.js";
import { formatNotes } from "../public/align.js";

// Speech-to-text is a separate model family from the chat models in the picker.
// Read per call, so it does not depend on dotenv having run before this module loaded.
export const transcribeModel = () => process.env.TRANSCRIBE_MODEL || "gpt-transcribe";

const EXTENSIONS = { "audio/webm": "webm", "audio/mp4": "m4a", "audio/ogg": "ogg", "audio/wav": "wav", "audio/mpeg": "mp3" };

/**
 * A refusal or a truncated reply comes back with `output_parsed: null`. Fail loudly
 * here, so callers never mistake "no answer" for "nothing to fix" or a null mark.
 */
function requireParsed(response, what) {
  if (response.output_parsed == null) {
    throw new Error(`${what}: the model returned no parsable result (status: ${response.status}).`);
  }
  return response;
}

/** Omits `reasoning` entirely for catalog entries that declare no effort. */
export function reasoning(model, effort) {
  return model.effort === null ? {} : { reasoning: { effort } };
}

/** Reads the audio itself, asking for a verbatim transcript. The model does not always comply (see evals/results). Returns the transcript text. */
export async function transcribeAudio(
  client,
  audio,
  { mime = "audio/webm", model = transcribeModel(), prompt = TRANSCRIBE_PROMPT, ...extra } = {}
) {
  const type = mime.split(";")[0].trim();
  const file = await toFile(audio, `answer.${EXTENSIONS[type] ?? "webm"}`, { type });
  const result = await client.audio.transcriptions.create({
    language: "en",
    // Model-specific options (keywords, languages, ...). Pass `language: undefined` to drop
    // the default. They are spread before the fields below, so they cannot replace the audio.
    ...extra,
    file,
    model,
    prompt,
    response_format: "text",
  });
  return (typeof result === "string" ? result : result.text ?? "").trim();
}

/**
 * Repairs recogniser artefacts in candidate turns, leaving the candidate's own errors
 * untouched. Runs at high effort because the judgement it has to make - "is this the
 * microphone's mistake or the speaker's?" - is exactly the hard part.
 */
export async function repairTurns(client, model, turns, { instructions = repairSystemPrompt() } = {}) {
  if (!Array.isArray(turns) || !turns.every((t) => typeof t === "string")) {
    throw new Error("repairTurns needs an array of strings.");
  }
  const numbered = turns.map((t, i) => `[${i}] ${t}`).join("\n\n");

  const response = await client.responses.parse({
    model: model.id,
    ...reasoning(model, "high"),
    max_output_tokens: 32000,
    instructions,
    input: [
      {
        role: "user",
        content: `Candidate turns from an automatic transcript. Return one entry per turn,
using the same index.\n\n${numbered}`,
      },
    ],
    text: { format: zodTextFormat(RepairSchema, "repair") },
  });
  return requireParsed(response, "repair");
}

/** Marking is the job worth paying for, so it runs at high effort on every model. */
export async function assessTranscript(client, model, { transcript, targetBand, part, disagreements = [] }) {
  if (!Array.isArray(transcript)) throw new Error("assessTranscript needs a transcript array.");
  const body = transcript
    .map((t) => `${t.role === "examiner" ? "EXAMINER" : "CANDIDATE"}: ${t.text}`)
    .join("\n\n");
  const notes = formatNotes(disagreements);

  const response = await client.responses.parse({
    model: model.id,
    ...reasoning(model, "high"),
    max_output_tokens: 32000,
    instructions: assessorSystemPrompt({ targetBand, part }),
    input: [{ role: "user", content: `TRANSCRIPT\n\n${body}${notes ? `\n\nTRANSCRIPT NOTES\n\n${notes}` : ""}` }],
    text: { format: zodTextFormat(AssessmentSchema, "assessment") },
  });
  return requireParsed(response, "assessment");
}
