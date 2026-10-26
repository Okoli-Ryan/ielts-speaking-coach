/**
 * The models offered in the picker. Edit this list to add or remove candidates -
 * it is the only place model IDs are hard-coded.
 *
 * `effort` is the reasoning effort used for conversational examiner turns. Marking
 * always runs at high effort regardless, because that is the job worth paying for.
 * Set `effort: null` for a model that does not accept a reasoning parameter.
 *
 * Entries your API key cannot reach are detected at startup and shown greyed out
 * in the picker rather than failing when you select them.
 */
export const MODEL_CATALOG = [
  {
    id: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    note: "Strongest marker available on most keys. The sensible default.",
    effort: "low",
  },
  {
    id: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    note: "Balances intelligence and cost. Test whether it marks as strictly as Sol.",
    effort: "low",
  },
  {
    id: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    note: "Cost-optimised and fast. Likely a fine examiner, likely too lenient a marker.",
    effort: "low",
  },
  {
    id: "gpt-5.5",
    label: "GPT-5.5",
    note: "Previous generation. A useful baseline for whether newer models mark better.",
    effort: "low",
  },
  {
    id: "gpt-6-astra",
    label: "GPT-6 Astra",
    note: "Most capable overall, but needs a tier of API access many keys do not have.",
    effort: "low",
  },
];

export const DEFAULT_MODEL = MODEL_CATALOG[0].id;

/** Only ever run a model from the catalog - the id arrives from the browser. */
export function resolveModel(requested) {
  return MODEL_CATALOG.find((m) => m.id === requested) || MODEL_CATALOG[0];
}

/**
 * Asks the API which catalog entries this key can actually use, so the picker can
 * grey out the rest. Resolved once at startup; a failure here is never fatal -
 * every model is simply marked available and a bad pick surfaces as a 404 later.
 */
export async function withAvailability(catalog, client) {
  try {
    const reachable = new Set();
    for await (const m of await client().models.list()) reachable.add(m.id);
    return catalog.map((m) => ({ ...m, available: reachable.has(m.id) }));
  } catch {
    return catalog.map((m) => ({ ...m, available: true }));
  }
}
