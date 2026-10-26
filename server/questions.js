import { z } from "zod";

/** A complete, IELTS-standard question paper for one sitting. */
export const QuestionSetSchema = z.object({
  part1: z
    .array(
      z.object({
        topic: z.string().describe("Familiar Part 1 topic, e.g. 'Your home town'."),
        questions: z
          .array(z.string())
          .describe("4 short questions on this topic, ordered easiest first."),
      })
    )
    .nullable()
    .describe("Exactly 3 topics, first must be work or studies. Null when Part 1 is not being sat."),
  part2: z.object({
    topic: z.string().describe("The 'Describe...' line."),
    bullets: z.array(z.string()).describe("Three 'You should say' prompts."),
    explain: z.string().describe("The final 'and explain...' line."),
    theme: z.string().describe("One or two words. Part 3 abstracts from this."),
    rounding_off: z.string().describe("One short question to close the long turn."),
  }),
  part3: z
    .array(
      z.object({
        theme: z.string().describe("An abstract angle on the Part 2 theme."),
        questions: z
          .array(z.string())
          .describe("4 questions, escalating in abstraction and difficulty."),
      })
    )
    .nullable()
    .describe("Exactly 2 themes derived from the Part 2 topic. Null when Part 3 is not being sat."),
});

/**
 * Generates a fresh paper. `avoid` carries recent questions and topics from the
 * local bank so successive sittings do not repeat themselves.
 */
export function questionSetPrompt({ targetBand, avoidQuestions, avoidTopics, parts = [1, 2, 3] }) {
  const need = new Set(parts);
  // Only write the parts actually being sat. Writing a full paper for a single-part
  // sitting roughly triples the wait before the first question appears.
  const scope = `
WRITE ONLY THESE PARTS: ${[...need].sort().join(", ")}.
${need.has(1) ? "" : "Set part1 to null - Part 1 is not being sat.\n"}${
    need.has(3) ? "" : "Set part3 to null - Part 3 is not being sat.\n"
  }Always write part2: Part 3 abstracts from its topic, and it is what a Part 2 sitting needs.
`;

  return `Write an IELTS Speaking question paper for one sitting.
${scope}

FOLLOW THE REAL EXAM EXACTLY
Part 1: three familiar topics, four short questions each. The first topic must be work or
studies. Questions are personal and concrete ("Do you...", "How often...", "What kind of...").
Keep them answerable in 20-40 seconds. No abstract or opinion-heavy questions here.

Part 2: one cue card in the standard format - a "Describe..." line, three "You should say"
bullets, and a final "and explain..." line. It must give an average candidate two minutes of
material without requiring specialist knowledge. Add one short rounding-off question.

Part 3: two abstract themes derived from the Part 2 topic, four questions each. These probe
opinion, comparison, cause and effect, speculation about the future, and evaluation. They must
escalate: the fourth question in each theme should stretch a strong candidate. Use the real
examiner's register - "Some people argue that...", "To what extent...", "How might... change".

VARIETY IS THE POINT
This paper must feel different from recent ones.
${avoidTopics.length ? `Do NOT reuse these recently used topics:\n${avoidTopics.map((t) => `  - ${t}`).join("\n")}` : "There is no history yet, so choose freely."}
${
  avoidQuestions.length
    ? `\nDo NOT reuse or lightly reword any of these recently asked questions:\n${avoidQuestions
        .slice(0, 40)
        .map((q) => `  - ${q}`)
        .join("\n")}`
    : ""
}

The candidate is targeting band ${targetBand}. Pitch Part 3 so that a band ${targetBand}
candidate has to work for the last question in each theme. Do not make Part 1 harder to
compensate - Part 1 stays deliberately easy in the real test.`;
}
