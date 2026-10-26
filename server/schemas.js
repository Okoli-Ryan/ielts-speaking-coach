import { z } from "zod";

const band = z.number().describe("IELTS band, 0-9, half bands allowed");

const criterionMark = z.object({
  band,
  evidence: z
    .array(z.string())
    .describe("Direct quotes from the candidate that fix this band. 2-4 items."),
  what_is_working: z.string(),
  gap_to_target: z
    .string()
    .describe(
      "Exactly what is missing for the target band on this criterion, in observable behaviour."
    ),
});

export const AssessmentSchema = z.object({
  overall_band: band,
  target_band: band,
  verdict: z
    .string()
    .describe("Two sentences: are they at target, and the single biggest blocker."),
  fluency_coherence: criterionMark,
  lexical_resource: criterionMark,
  grammatical_range: criterionMark,
  pronunciation: criterionMark,
  upgrades: z
    .array(
      z.object({
        original: z.string().describe("What the candidate actually said."),
        upgraded: z.string().describe("The same idea, rewritten at the target band."),
        why_it_scores_higher: z.string(),
      })
    )
    .describe("4-6 rewrites of the candidate's own sentences at the target band."),
  error_log: z
    .array(
      z.object({
        error: z.string(),
        correction: z.string(),
        type: z
          .string()
          .describe("grammar | vocabulary | collocation | pronunciation | discourse"),
      })
    )
    .describe("Recurring errors only, not one-off slips."),
  vocabulary_to_steal: z
    .array(
      z.object({
        item: z.string().describe("A word, collocation or idiom at the target band."),
        use_it_for: z.string().describe("The topic or function it fits."),
        example: z.string(),
      })
    )
    .describe("6-8 items, precisely matched to topics that came up in this test."),
  drills: z
    .array(z.string())
    .describe("3-4 concrete exercises, each doable in under ten minutes."),
  stats: z.object({
    estimated_words_spoken: z.number(),
    filler_words_noted: z.array(z.string()),
    longest_uninterrupted_answer_note: z.string(),
  }),
});

export const ComparisonSchema = z.object({
  question: z.string(),
  attempt_1_band: band,
  attempt_2_band: band,
  delta: z.number().describe("attempt_2_band minus attempt_1_band"),
  genuinely_improved: z.boolean(),
  verdict: z.string().describe("Two or three sentences, blunt."),
  what_improved: z.array(z.string()),
  what_regressed: z.array(z.string()),
  superficial_changes: z
    .array(z.string())
    .describe("Memorised or shoehorned language that an examiner would penalise. May be empty."),
  still_missing_for_target: z.array(z.string()),
  next_attempt_focus: z.string().describe("One single thing to fix on attempt 3."),
});

export const RepairSchema = z.object({
  turns: z
    .array(
      z.object({
        index: z.number().describe("Index of the candidate turn, as given in the input."),
        corrected: z
          .string()
          .describe("The turn after repair. Identical to the original when nothing was wrong."),
        changed: z.boolean(),
        changes: z
          .array(
            z.object({
              from: z.string(),
              to: z.string(),
              reason: z.string().describe("Why the original cannot be what was said."),
              confidence: z.string().describe("high | medium | low"),
            })
          )
          .describe("Empty when nothing was changed."),
      })
    )
    .describe("One entry per candidate turn supplied, in the same order."),
  summary: z
    .string()
    .describe("One sentence on the transcript's overall recognition quality."),
});

export const CueCardSchema = z.object({
  topic: z.string().describe("The 'Describe...' line."),
  bullets: z.array(z.string()).describe("Three 'You should say' prompts."),
  explain: z.string().describe("The final 'and explain...' line."),
  theme: z.string().describe("One or two words, used to link Part 3 questions."),
});
