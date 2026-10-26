/**
 * Turns the app's transcript rows into provider-neutral chat input.
 *
 * Two providers, one rule: the conversation must open and close on a user message.
 * OpenAI tolerates a trailing assistant turn; Anthropic treats it as a prefill, which
 * its newer models reject. So the history is always shaped to end on the user.
 */

const isTurn = (t) => t && typeof t.text === "string" && t.text.trim();

/** Convert transcript rows into { role, content } messages, dropping anything malformed. */
export function toInput(history) {
  return (Array.isArray(history) ? history : []).filter(isTurn).map((t) => ({
    role: t.role === "examiner" ? "assistant" : "user",
    content: t.text.trim(),
  }));
}

/** Opens with a user cue when there is no history yet; closes with one if the examiner spoke last. */
export function ensureUserBoundaries(input, part) {
  const out = [...input];
  if (!out.length || out[0].role !== "user") {
    out.unshift({
      role: "user",
      content: `[The candidate has sat down and the recorder is on. Begin Part ${part}.]`,
    });
  }
  if (out[out.length - 1].role === "assistant") {
    out.push({ role: "user", content: "[Carry on as the examiner.]" });
  }
  return out;
}

export const buildInput = (history, part) => ensureUserBoundaries(toInput(history), part);
