/**
 * The provider registry. To add a provider, write a file here that exports a factory
 * returning { id, label, keyEnv, configured(), listModels(), parse(), stream() }, register
 * it below, and add its models to MODEL_CATALOG in ../models.js. Nothing else changes:
 * the dropdown, availability checks and evals all read from these two lists.
 */
import { openaiProvider } from "./openai.js";
import { anthropicProvider } from "./anthropic.js";

export const providers = [openaiProvider(), anthropicProvider()];

export const getProvider = (id) => providers.find((p) => p.id === id);

/** The provider that serves a catalog entry. */
export const providerFor = (model) => getProvider(model.provider);

/** The provider for a model, or a plain error saying which key to add. */
export function llmFor(model) {
  const provider = providerFor(model);
  if (!provider) throw new Error(`No provider is registered for "${model.provider}".`);
  if (!provider.configured()) {
    throw new Error(`No ${provider.keyEnv}. Add it to .env and restart the server, or pick a model from another provider.`);
  }
  return provider;
}
