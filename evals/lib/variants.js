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

/**
 * The same hint written as context about the recording, which is how OpenAI's speech-to-text
 * guide describes the prompt for gpt-transcribe ("unstructured context about the recording"),
 * rather than as an instruction to follow.
 */
export const CONTEXT_TRANSCRIBE_PROMPT = `A language learner practising for the IELTS Speaking test. The speaker makes grammar mistakes and uses filler words such as um, uh and er, and false starts.`;

const FILLER_KEYWORDS = ["um", "uh", "er", "erm"];

/**
 * Transcription options to compare against the shipped prompt. Each is passed straight to
 * transcribeAudio, so a variant can change the prompt, the model, or any model option.
 */
export const TRANSCRIBE_VARIANTS = {
  primed: { prompt: PRIMED_TRANSCRIBE_PROMPT },
  keywords: { keywords: FILLER_KEYWORDS },
  // gpt-transcribe takes `languages` where other models take `language`.
  context: { prompt: CONTEXT_TRANSCRIBE_PROMPT, keywords: FILLER_KEYWORDS, language: undefined, languages: ["en"] },
  // whisper-1 is deprecated (OpenAI lists a shutdown date) but is documented to follow a
  // hesitation-style prompt more closely than an instruction.
  whisper: { model: "whisper-1", prompt: PRIMED_TRANSCRIBE_PROMPT },
};
