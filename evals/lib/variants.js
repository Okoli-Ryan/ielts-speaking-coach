/**
 * Deliberately weaker prompts, kept so the evals can prove they notice the difference.
 * An eval that passes everything it is shown has not been shown to measure anything.
 */
export const NAIVE_REPAIR_PROMPT = `Fix any mistakes in this transcript of a spoken English exam.
Correct spelling, grammar and wording so the text reads naturally. Report every change.`;

/**
 * A transcription prompt written as a sample of the transcript style wanted, rather than
 * as an instruction. Speech models tend to continue the style of the prompt they are
 * given, so a verbatim example is the thing to try when an instruction is ignored.
 * The sentences are deliberately unlike the capture scripts, so the eval is not
 * graded on text the prompt already contains.
 */
export const PRIMED_TRANSCRIBE_PROMPT = `Verbatim transcript of a learner of English. Errors, repetitions and fillers are kept exactly as spoken.

Um, so I, uh, I go to the, the market every week and, er, I buy three apple. Yesterday I have seen my friend, he don't have a car, so we, we walk.`;
