/**
 * Anthropic (Claude) provider. Chat only: Anthropic has no speech-to-text, so audio
 * re-transcription stays on the OpenAI provider.
 *
 * Structured replies use JSON-schema output, validated again with the same zod schema
 * the OpenAI path uses, so both providers hand the rest of the app identical objects.
 * Requests stream internally, because large max_tokens values are rejected on
 * non-streaming calls.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodToJsonSchema } from "zod-to-json-schema";

/** Catalog entries with `effort: null` take no effort parameter. Returns {} (omitted) when empty. */
function outputConfig(model, effort, format) {
  const config = {
    ...(model.effort === null ? {} : { effort }),
    ...(format ? { format } : {}),
  };
  return Object.keys(config).length ? { output_config: config } : {};
}

const usageOf = (message) => ({
  input: message?.usage?.input_tokens ?? null,
  output: message?.usage?.output_tokens ?? null,
  reasoning: message?.usage?.output_tokens_details?.thinking_tokens ?? null,
});

const textOf = (message) =>
  message.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

/** A refusal or any early stop carries no usable answer. Say which, instead of parsing garbage. */
function assertComplete(model, message) {
  const reason = message.stop_reason;
  if (reason === "refusal") {
    const category = message.stop_details?.category;
    throw new Error(`${model.label} declined this request${category ? ` (${category})` : ""}.`);
  }
  if (reason === "max_tokens") {
    throw new Error(`${model.label} ran out of output tokens before finishing its reply.`);
  }
  if (reason !== "end_turn" && reason !== "stop_sequence") {
    throw new Error(`${model.label} stopped early (${reason}).`);
  }
}

/** zod -> JSON schema, in the form structured outputs accept. */
export function jsonSchemaFor(schema) {
  const json = zodToJsonSchema(schema, { $refStrategy: "none" });
  delete json.$schema;
  return json;
}

/** `injected` lets tests supply a fake SDK client; the app never passes one. */
export function anthropicProvider(injected = null) {
  let client = injected;
  const sdk = () => (client ??= new Anthropic());

  return {
    id: "anthropic",
    label: "Anthropic (Claude)",
    keyEnv: "ANTHROPIC_API_KEY",
    configured: () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),

    async listModels() {
      const ids = new Set();
      for await (const m of sdk().models.list()) ids.add(m.id);
      return ids;
    },

    async parse({ model, effort, maxTokens, system, input, schema }) {
      const message = await sdk()
        .messages.stream({
          model: model.id,
          max_tokens: maxTokens,
          ...(system ? { system } : {}),
          messages: input,
          ...outputConfig(model, effort, { type: "json_schema", schema: jsonSchemaFor(schema) }),
        })
        .finalMessage();
      assertComplete(model, message);
      let data;
      try {
        data = schema.parse(JSON.parse(textOf(message)));
      } catch (err) {
        throw new Error(`${model.label} returned a reply that does not match the expected shape: ${err.message}`);
      }
      return { data, usage: usageOf(message) };
    },

    async stream({ model, effort, maxTokens, system, input, onDelta }) {
      const stream = sdk().messages.stream({
        model: model.id,
        max_tokens: maxTokens,
        ...(system ? { system } : {}),
        messages: input,
        ...outputConfig(model, effort),
      });
      stream.on("text", (delta) => onDelta?.(delta));
      const message = await stream.finalMessage();
      assertComplete(model, message);
      return { text: textOf(message), usage: usageOf(message) };
    },
  };
}
