/**
 * The models offered in the picker, from every provider. Edit this list to add or remove
 * candidates; it is the only place model IDs are hard-coded.
 *
 * `provider` names an entry in providers/index.js.
 *
 * `effort` is the reasoning effort used for conversational examiner turns. Marking
 * always runs at high effort regardless, because that is the job worth paying for.
 * Set `effort: null` for a model that does not accept a reasoning parameter.
 *
 * Entries whose provider has no key, or whose key cannot reach the model, are detected
 * at startup and shown greyed out in the picker rather than failing when you select them.
 */
export const MODEL_CATALOG = [
  {
    id: "gpt-5.6-sol",
    provider: "openai",
    label: "GPT-5.6 Sol",
    note: "Strongest marker available on most keys. The sensible default.",
    effort: "low",
  },
  {
    id: "gpt-5.6-terra",
    provider: "openai",
    label: "GPT-5.6 Terra",
    note: "Balances intelligence and cost. Test whether it marks as strictly as Sol.",
    effort: "low",
  },
  {
    id: "gpt-5.6-luna",
    provider: "openai",
    label: "GPT-5.6 Luna",
    note: "Cost-optimised and fast. Not yet checked as an examiner or a marker here.",
    effort: "low",
  },
  {
    id: "gpt-5.5",
    provider: "openai",
    label: "GPT-5.5",
    note: "Previous generation. A useful baseline for whether newer models mark better.",
    effort: "low",
  },
  {
    id: "gpt-6-astra",
    provider: "openai",
    label: "GPT-6 Astra",
    note: "Most capable overall, but needs a tier of API access many keys do not have.",
    effort: "low",
  },
  {
    id: "claude-sonnet-5-5",
    provider: "anthropic",
    label: "Claude Sonnet 5.5",
    note: "Run through the app and, once, the repair and marker evals. Marked 0.5 to 1 band below GPT-5.6 Sol on the same answers. Do not compare bands across models.",
    effort: "low",
  },
  {
    id: "claude-opus-5-5",
    provider: "anthropic",
    label: "Claude Opus 5.5",
    note: "Run once through the repair and marker evals: fixed every planted mishearing, and marked 0 to 0.5 band below GPT-5.6 Sol. Do not compare bands across models.",
    effort: "low",
  },
  {
    id: "claude-haiku-5-5",
    provider: "anthropic",
    label: "Claude Haiku 5.5",
    note: "The smallest Claude. Run once through the evals: repair recall sat at the 75% floor, and it marked about 0.5 to 1 band below GPT-5.6 Sol.",
    effort: "low",
  },
  {
    id: "claude-fable-5-1",
    provider: "anthropic",
    label: "Claude Fable 5.1",
    note: "Anthropic's most capable widely released model, and its highest price. Not yet checked as a marker here.",
    effort: "low",
  },
];

/**
 * The model used when none is chosen: DEFAULT_MODEL from the environment if it names a
 * catalog entry, otherwise the first catalog entry whose provider has a key. Falls back to
 * the first entry so the app can still start and explain what is missing.
 */
export function defaultModelId(providers) {
  const fromEnv = MODEL_CATALOG.find((m) => m.id === process.env.DEFAULT_MODEL);
  if (fromEnv) return fromEnv.id;
  const usable = MODEL_CATALOG.find((m) => providers.find((p) => p.id === m.provider)?.configured());
  return (usable ?? MODEL_CATALOG[0]).id;
}

/** Only ever run a model from the catalog: the id arrives from the browser. */
export function resolveModel(requested, providers) {
  return (
    MODEL_CATALOG.find((m) => m.id === requested) ||
    MODEL_CATALOG.find((m) => m.id === defaultModelId(providers))
  );
}

/**
 * Marks each catalog entry as available or not, and says why not. A provider counts as
 * available when its key is set; its model list is then checked so entries the key cannot
 * reach are greyed out too. A failed listing is never fatal: every model of that provider
 * is treated as available and a bad pick surfaces as an error later.
 */
const LIST_TIMEOUT_MS = 5000;

/** Rejects after `ms`, so a blackholed network cannot keep the whole UI waiting. */
const withTimeout = (promise, ms) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), ms).unref())]);

export async function withAvailability(catalog, providers) {
  const byId = new Map(providers.map((p) => [p.id, p]));
  const reachable = new Map();

  await Promise.all(
    providers
      .filter((p) => p.configured())
      .map(async (p) => {
        try {
          reachable.set(p.id, await withTimeout(p.listModels(), LIST_TIMEOUT_MS));
        } catch {
          reachable.set(p.id, null);
        }
      })
  );

  return catalog.map((m) => {
    const provider = byId.get(m.provider);
    const base = { ...m, providerLabel: provider?.label ?? m.provider };
    if (!provider?.configured()) {
      return { ...base, available: false, reason: `Set ${provider?.keyEnv ?? "its API key"} in .env to enable` };
    }
    const ids = reachable.get(provider.id);
    // A listed dated snapshot (id-YYYYMMDD) counts as reaching the alias.
    const listed = ids && [...ids].some((id) => id === m.id || id.startsWith(`${m.id}-`));
    return ids && !listed
      ? { ...base, available: false, reason: "Your key cannot reach this model" }
      : { ...base, available: true, reason: null };
  });
}
