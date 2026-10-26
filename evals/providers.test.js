import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { MODEL_CATALOG, defaultModelId, resolveModel, withAvailability } from "../server/models.js";
import { anthropicProvider, jsonSchemaFor } from "../server/providers/anthropic.js";
import { openaiProvider } from "../server/providers/openai.js";
import { AssessmentSchema, RepairSchema, ComparisonSchema, CueCardSchema } from "../server/schemas.js";
import { QuestionSetSchema } from "../server/questions.js";

const fakeProvider = (id, { configured = true, models = null, listFails = false } = {}) => ({
  id,
  label: id.toUpperCase(),
  keyEnv: `${id.toUpperCase()}_API_KEY`,
  configured: () => configured,
  listModels: async () => {
    if (listFails) throw new Error("listing blocked");
    return new Set(models ?? MODEL_CATALOG.filter((m) => m.provider === id).map((m) => m.id));
  },
});

const catalogIds = (rows, wanted) => rows.filter((m) => m.provider === wanted);

// --- availability and the dropdown -------------------------------------------------

test("a provider without a key is unavailable, and the reason names the key", async () => {
  const rows = await withAvailability(MODEL_CATALOG, [fakeProvider("openai"), fakeProvider("anthropic", { configured: false })]);
  const claude = catalogIds(rows, "anthropic");
  assert.ok(claude.length > 0);
  for (const m of claude) {
    assert.equal(m.available, false);
    assert.match(m.reason, /ANTHROPIC_API_KEY/);
    assert.equal(m.providerLabel, "ANTHROPIC");
  }
  assert.ok(catalogIds(rows, "openai").every((m) => m.available));
});

test("a configured provider greys out only the models its key cannot reach", async () => {
  const rows = await withAvailability(MODEL_CATALOG, [
    fakeProvider("openai", { models: ["gpt-5.6-sol"] }),
    fakeProvider("anthropic"),
  ]);
  const byId = Object.fromEntries(rows.map((m) => [m.id, m]));
  assert.equal(byId["gpt-5.6-sol"].available, true);
  assert.equal(byId["gpt-5.6-terra"].available, false);
  assert.match(byId["gpt-5.6-terra"].reason, /cannot reach/);
});

test("a failed model listing never greys out a provider", async () => {
  const rows = await withAvailability(MODEL_CATALOG, [fakeProvider("openai", { listFails: true }), fakeProvider("anthropic")]);
  assert.ok(catalogIds(rows, "openai").every((m) => m.available));
});

test("every catalog entry names a provider that has a label", async () => {
  const rows = await withAvailability(MODEL_CATALOG, [fakeProvider("openai"), fakeProvider("anthropic")]);
  assert.ok(rows.every((m) => m.providerLabel && m.provider));
});

test("the default model is the first one whose provider has a key", () => {
  delete process.env.DEFAULT_MODEL;
  const openaiOnly = [fakeProvider("openai"), fakeProvider("anthropic", { configured: false })];
  const claudeOnly = [fakeProvider("openai", { configured: false }), fakeProvider("anthropic")];
  assert.equal(MODEL_CATALOG.find((m) => m.id === defaultModelId(openaiOnly)).provider, "openai");
  assert.equal(MODEL_CATALOG.find((m) => m.id === defaultModelId(claudeOnly)).provider, "anthropic");
});

test("DEFAULT_MODEL in the environment wins, but only if it is a real catalog entry", () => {
  const providers = [fakeProvider("openai"), fakeProvider("anthropic")];
  process.env.DEFAULT_MODEL = "claude-haiku-5-5";
  assert.equal(defaultModelId(providers), "claude-haiku-5-5");
  process.env.DEFAULT_MODEL = "not-a-model";
  assert.notEqual(defaultModelId(providers), "not-a-model");
  delete process.env.DEFAULT_MODEL;
});

test("an unknown model id from the browser resolves to the default, never to itself", () => {
  const providers = [fakeProvider("openai", { configured: false }), fakeProvider("anthropic")];
  const model = resolveModel("../../etc/passwd", providers);
  assert.ok(MODEL_CATALOG.includes(model));
  assert.equal(model.provider, "anthropic");
});

// --- schema conversion -------------------------------------------------------------

function everyObjectIsClosed(node, path = "root") {
  if (!node || typeof node !== "object") return;
  if (node.type === "object") assert.equal(node.additionalProperties, false, `${path} must be closed`);
  for (const [key, value] of Object.entries(node)) {
    if (Array.isArray(value)) value.forEach((v, i) => everyObjectIsClosed(v, `${path}.${key}[${i}]`));
    else if (typeof value === "object") everyObjectIsClosed(value, `${path}.${key}`);
  }
}

test("every app schema converts to a closed JSON schema with no $schema key", () => {
  for (const schema of [AssessmentSchema, RepairSchema, ComparisonSchema, CueCardSchema, QuestionSetSchema]) {
    const json = jsonSchemaFor(schema);
    assert.equal(json.$schema, undefined);
    assert.equal(json.type, "object");
    everyObjectIsClosed(json);
  }
});

// --- the Anthropic provider, against a fake SDK -----------------------------------

const claude = MODEL_CATALOG.find((m) => m.provider === "anthropic");

function fakeAnthropic(message, deltas = []) {
  const calls = [];
  return {
    calls,
    messages: {
      stream(params) {
        calls.push(params);
        const handlers = [];
        return {
          on(event, fn) {
            if (event === "text") handlers.push(fn);
            return this;
          },
          async finalMessage() {
            for (const d of deltas) handlers.forEach((fn) => fn(d));
            return message;
          },
        };
      },
    },
  };
}

const textMessage = (text, extra = {}) => ({
  content: [{ type: "text", text }],
  stop_reason: "end_turn",
  usage: { input_tokens: 11, output_tokens: 7, output_tokens_details: { thinking_tokens: 3 } },
  ...extra,
});

test("parse sends a JSON schema, effort and the system prompt, and returns validated data", async () => {
  const Schema = z.object({ answer: z.string() });
  const sdk = fakeAnthropic(textMessage('{"answer":"ok"}'));
  const { data, usage } = await anthropicProvider(sdk).parse({
    model: claude, effort: "high", maxTokens: 500, system: "be brief",
    input: [{ role: "user", content: "hi" }], schema: Schema, schemaName: "x",
  });
  assert.deepEqual(data, { answer: "ok" });
  assert.deepEqual(usage, { input: 11, output: 7, reasoning: 3 });
  const sent = sdk.calls[0];
  assert.equal(sent.model, claude.id);
  assert.equal(sent.system, "be brief");
  assert.equal(sent.max_tokens, 500);
  assert.equal(sent.output_config.effort, "high");
  assert.equal(sent.output_config.format.type, "json_schema");
  assert.equal(sent.output_config.format.schema.additionalProperties, false);
});

test("an entry with effort null sends no effort parameter", async () => {
  const sdk = fakeAnthropic(textMessage('{"answer":"ok"}'));
  await anthropicProvider(sdk).parse({
    model: { ...claude, effort: null }, effort: "high", maxTokens: 10,
    input: [], schema: z.object({ answer: z.string() }),
  });
  assert.equal("effort" in sdk.calls[0].output_config, false);
  assert.equal(sdk.calls[0].output_config.format.type, "json_schema");
});

test("a refusal, a cut-off reply and a reply of the wrong shape each fail with a clear message", async () => {
  const Schema = z.object({ answer: z.string() });
  const run = (message) => anthropicProvider(fakeAnthropic(message)).parse({ model: claude, effort: "low", maxTokens: 10, input: [], schema: Schema });
  await assert.rejects(run(textMessage("", { stop_reason: "refusal", stop_details: { category: "cyber" } })), /declined this request \(cyber\)/);
  await assert.rejects(run(textMessage("{", { stop_reason: "max_tokens" })), /ran out of output tokens/);
  await assert.rejects(run(textMessage('{"wrong":1}')), /does not match the expected shape/);
  await assert.rejects(run(textMessage("not json")), /does not match the expected shape/);
});

test("stream hands each text delta to the caller and returns the joined text", async () => {
  const sdk = fakeAnthropic(textMessage("Hello there"), ["Hello", " there"]);
  const seen = [];
  const { text } = await anthropicProvider(sdk).stream({
    model: claude, effort: "low", maxTokens: 100, system: "s", input: [], onDelta: (d) => seen.push(d),
  });
  assert.deepEqual(seen, ["Hello", " there"]);
  assert.equal(text, "Hello there");
  assert.equal("format" in sdk.calls[0].output_config, false);
});

test("the Anthropic provider reports configured only when a credential is set", () => {
  const saved = { key: process.env.ANTHROPIC_API_KEY, token: process.env.ANTHROPIC_AUTH_TOKEN };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  assert.equal(anthropicProvider().configured(), false);
  process.env.ANTHROPIC_API_KEY = "sk-test";
  assert.equal(anthropicProvider().configured(), true);
  if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.key;
  if (saved.token !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = saved.token;
});

// --- the OpenAI provider, against a fake SDK --------------------------------------

test("OpenAI parse returns the parsed object and normalised usage, and fails loudly on none", async () => {
  const gpt = MODEL_CATALOG.find((m) => m.provider === "openai");
  const ok = {
    responses: { parse: async () => ({ output_parsed: { a: 1 }, status: "completed", usage: { input_tokens: 5, output_tokens: 9, output_tokens_details: { reasoning_tokens: 4 } } }) },
  };
  const { data, usage } = await openaiProvider(ok).parse({ model: gpt, effort: "high", maxTokens: 10, input: [], schema: z.object({ a: z.number() }), schemaName: "t" });
  assert.deepEqual(data, { a: 1 });
  assert.deepEqual(usage, { input: 5, output: 9, reasoning: 4 });

  const refused = { responses: { parse: async () => ({ output_parsed: null, status: "incomplete" }) } };
  await assert.rejects(
    openaiProvider(refused).parse({ model: gpt, effort: "high", maxTokens: 10, input: [], schema: z.object({ a: z.number() }), schemaName: "t" }),
    /no parsable result \(status: incomplete\)/
  );
});

// --- history shaping ---------------------------------------------------------------

import { buildInput } from "../server/history.js";

test("history always opens and closes on a user message", () => {
  const roles = (h) => buildInput(h, 1).map((m) => m.role);
  assert.deepEqual(roles([]), ["user"]);
  assert.deepEqual(roles([{ role: "examiner", text: "Hello." }]), ["user", "assistant", "user"]);
  assert.deepEqual(roles([{ role: "examiner", text: "Q?" }, { role: "candidate", text: "A." }]), ["user", "assistant", "user"]);
});

test("malformed history rows are dropped instead of crashing", () => {
  const out = buildInput([null, {}, { role: "candidate", text: 5 }, { role: "candidate", text: "  ok  " }], 2);
  assert.equal(out.length, 1);
  assert.equal(out[0].content, "ok");
  assert.deepEqual(buildInput("nonsense", 1).map((m) => m.role), ["user"]);
});

// --- stop reasons ------------------------------------------------------------------

test("any early stop other than end_turn is an error, not a reply", async () => {
  const Schema = z.object({ answer: z.string() });
  for (const stop_reason of ["pause_turn", "model_context_window_exceeded", "tool_use"]) {
    const sdk = fakeAnthropic(textMessage('{"answer":"ok"}', { stop_reason }));
    await assert.rejects(
      anthropicProvider(sdk).parse({ model: claude, effort: "low", maxTokens: 10, input: [], schema: Schema }),
      /stopped early/
    );
  }
});

test("availability tolerates dated snapshot ids", async () => {
  const dated = { ...fakeProvider("anthropic"), listModels: async () => new Set(["claude-sonnet-5-5-20260801"]) };
  const rows = await withAvailability(MODEL_CATALOG, [fakeProvider("openai", { configured: false }), dated]);
  assert.equal(rows.find((m) => m.id === "claude-sonnet-5-5").available, true);
  assert.equal(rows.find((m) => m.id === "claude-opus-5-5").available, false);
});
