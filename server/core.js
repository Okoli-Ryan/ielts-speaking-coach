/**
 * The model calls that decide what a candidate's mark is built from: transcribing,
 * repairing and marking. They live apart from the WebSocket handlers so the evals
 * in `evals/` exercise the exact code path the app does, not a copy of it.
 *
 * Each call goes through the provider that serves the chosen model, so marking and
 * repair work with any provider in `providers/`. Transcription is the exception: it
 * needs an audio model, which only the OpenAI provider offers.
 */
import { assessorSystemPrompt, repairSystemPrompt, TRANSCRIBE_PROMPT } from "./prompts.js";
import { AssessmentSchema, RepairSchema } from "./schemas.js";
import { formatNotes } from "../public/align.js";
import { getProvider, llmFor } from "./providers/index.js";

// Speech-to-text is a separate model family from the chat models in the picker.
// Read per call, so it does not depend on dotenv having run before this module loaded.
export const transcribeModel = () => process.env.TRANSCRIBE_MODEL || "gpt-transcribe";

/** True when an audio-capable provider has a key. */
export const canTranscribe = () => Boolean(getProvider("openai")?.configured());

/**
 * Reads the audio itself and returns the transcript text. The prompt asks for a verbatim
 * transcript, which the model does not reliably give (see evals/results).
 */
export async function transcribeAudio(audio, { mime, model = transcribeModel(), prompt = TRANSCRIBE_PROMPT, ...extra } = {}) {
  const provider = getProvider("openai");
  if (!provider?.configured()) {
    throw new Error("Audio transcription needs OPENAI_API_KEY: Anthropic has no speech-to-text model.");
  }
  return provider.transcribe({ audio, mime, model, prompt, ...extra });
}

/**
 * Repairs recogniser artefacts in candidate turns, leaving the candidate's own errors
 * untouched. Runs at high effort because the judgement it has to make - "is this the
 * microphone's mistake or the speaker's?" - is exactly the hard part.
 */
export async function repairTurns(model, turns, { instructions = repairSystemPrompt() } = {}) {
  if (!Array.isArray(turns) || !turns.every((t) => typeof t === "string")) {
    throw new Error("repairTurns needs an array of strings.");
  }
  const numbered = turns.map((t, i) => `[${i}] ${t}`).join("\n\n");

  return llmFor(model).parse({
    model,
    effort: "high",
    maxTokens: 32000,
    system: instructions,
    input: [
      {
        role: "user",
        content: `Candidate turns from an automatic transcript. Return one entry per turn,
using the same index.\n\n${numbered}`,
      },
    ],
    schema: RepairSchema,
    schemaName: "repair",
  });
}

/** Marking is the job worth paying for, so it runs at high effort on every model. */
export async function assessTranscript(model, { transcript, targetBand, part, disagreements = [] }) {
  if (!Array.isArray(transcript)) throw new Error("assessTranscript needs a transcript array.");
  const body = transcript
    .map((t) => `${t.role === "examiner" ? "EXAMINER" : "CANDIDATE"}: ${t.text}`)
    .join("\n\n");
  const notes = formatNotes(disagreements);

  return llmFor(model).parse({
    model,
    effort: "high",
    maxTokens: 32000,
    system: assessorSystemPrompt({ targetBand, part }),
    input: [{ role: "user", content: `TRANSCRIPT\n\n${body}${notes ? `\n\nTRANSCRIPT NOTES\n\n${notes}` : ""}` }],
    schema: AssessmentSchema,
    schemaName: "assessment",
  });
}
