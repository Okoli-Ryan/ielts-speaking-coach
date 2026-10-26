/**
 * OpenAI provider: chat (Responses API) and speech-to-text. The only provider that can
 * transcribe audio, so the app's audio re-transcription needs OPENAI_API_KEY even when
 * another provider does the examining and marking.
 *
 * Set OPENAI_BASE_URL to point this provider at any OpenAI-compatible endpoint
 * (OpenRouter, a local server, ...); the SDK reads it from the environment.
 */
import OpenAI, { toFile } from "openai";
import { zodTextFormat } from "openai/helpers/zod";

const EXTENSIONS = { "audio/webm": "webm", "audio/mp4": "m4a", "audio/ogg": "ogg", "audio/wav": "wav", "audio/mpeg": "mp3" };

/** Catalog entries with `effort: null` take no reasoning parameter at all. */
const reasoning = (model, effort) => (model.effort === null ? {} : { reasoning: { effort } });

const usageOf = (response) => ({
  input: response?.usage?.input_tokens ?? null,
  output: response?.usage?.output_tokens ?? null,
  reasoning: response?.usage?.output_tokens_details?.reasoning_tokens ?? null,
});

/** `injected` lets tests supply a fake SDK client; the app never passes one. */
export function openaiProvider(injected = null) {
  // Built on first use: the constructor throws when no key is set, and the app should
  // still start and say so rather than refusing to boot.
  let client = injected;
  const sdk = () => (client ??= new OpenAI());

  return {
    id: "openai",
    label: "OpenAI",
    keyEnv: "OPENAI_API_KEY",
    configured: () => Boolean(process.env.OPENAI_API_KEY),

    async listModels() {
      const ids = new Set();
      for await (const m of await sdk().models.list()) ids.add(m.id);
      return ids;
    },

    /** One structured reply, validated against a zod schema. */
    async parse({ model, effort, maxTokens, system, input, schema, schemaName }) {
      const response = await sdk().responses.parse({
        model: model.id,
        ...reasoning(model, effort),
        max_output_tokens: maxTokens,
        ...(system ? { instructions: system } : {}),
        input,
        text: { format: zodTextFormat(schema, schemaName) },
      });
      // A refusal or a truncated reply has no parsed output. Fail loudly so nobody
      // mistakes "no answer" for "nothing to fix" or a null mark.
      if (response.output_parsed == null) {
        throw new Error(`${model.label}: no parsable result (status: ${response.status}).`);
      }
      return { data: response.output_parsed, usage: usageOf(response) };
    },

    /** Free text, delivered token by token through `onDelta`. */
    async stream({ model, effort, maxTokens, system, input, onDelta }) {
      const stream = sdk().responses.stream({
        model: model.id,
        ...reasoning(model, effort),
        max_output_tokens: maxTokens,
        instructions: system,
        input,
      });
      let text = "";
      for await (const event of stream) {
        if (event.type === "response.output_text.delta") {
          text += event.delta;
          onDelta?.(event.delta);
        }
      }
      const final = await stream.finalResponse();
      if (final.status && final.status !== "completed") {
        throw new Error(`${model.label}: the reply ended early (status: ${final.status}).`);
      }
      return { text, usage: usageOf(final) };
    },

    /** Reads an audio recording and returns the transcript text. */
    async transcribe({ audio, mime = "audio/webm", model, prompt, ...extra }) {
      const type = mime.split(";")[0].trim();
      const file = await toFile(audio, `answer.${EXTENSIONS[type] ?? "webm"}`, { type });
      const result = await sdk().audio.transcriptions.create({
        language: "en",
        // Model-specific options (keywords, languages, ...). Pass `language: undefined`
        // to drop the default. Spread first, so they cannot replace the audio.
        ...extra,
        file,
        model,
        prompt,
        response_format: "text",
      });
      return (typeof result === "string" ? result : result.text ?? "").trim();
    },
  };
}
