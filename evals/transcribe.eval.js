/**
 * Transcription: the browser's recogniser versus gpt-transcribe, on your own voice.
 * Both are scored against the script you read aloud, on three measures:
 *
 *   word error rate        - how far the transcript is from the script
 *   learner errors kept    - did "I am work" survive, or come back as "I am working"
 *   fillers kept           - did "um" and "uh" survive, or get tidied away
 *
 * The second and third matter more than WER for a marker: a transcript with a low
 * word error rate that has quietly fixed your grammar is worse than a noisy one.
 *
 * Caveat that the numbers inherit: the script is the ground truth, not what you
 * actually said. Reading "I have went" aloud without smoothing it to "I have gone" is
 * harder than it sounds, so a miss can be the reader's, not the transcriber's. The
 * per-clip rows in the result file show both texts so a miss can be checked by ear.
 *
 * Needs recordings: run the app and open /capture.html first. Uses the transcription
 * model from TRANSCRIBE_MODEL; --model, which picks a chat model, does not apply here.
 */
import fs from "node:fs";
import path from "node:path";

import { transcribeAudio, transcribeModel } from "../server/core.js";
import { loadScripts, RECORDINGS_DIR } from "../server/clips.js";
import { wer, normalise, containsPhrase } from "./lib/text.js";
import { mapLimit, pct } from "./lib/harness.js";
import { TRANSCRIBE_VARIANTS } from "./lib/variants.js";

const FILLERS = new Set(["um", "uh", "er", "erm"]);
const countFillers = (text) => normalise(text).split(" ").filter((w) => FILLERS.has(w)).length;
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

// A clip counts as a poor transcription of the script above this word error rate.
const POOR_WER = 0.15;

/**
 * What the hypothesis kept of the script's must-survive phrases and fillers, as counts
 * so clips can be pooled. A filler counts when the hypothesis holds at least as many as
 * were scripted, up to the scripted number; position is not checked.
 */
function fidelity(script, hypothesis) {
  const phrases = script.keep.filter((p) => !FILLERS.has(p));
  const wantedFillers = countFillers(script.text);
  return {
    phrases: { kept: phrases.filter((p) => containsPhrase(hypothesis, p)).length, total: phrases.length },
    fillers: { kept: Math.min(countFillers(hypothesis), wantedFillers), total: wantedFillers },
  };
}

const pooled = (rows, key, kind) => ({
  kept: sum(rows.map((r) => r[key][kind].kept)),
  total: sum(rows.map((r) => r[key][kind].total)),
});

const rate = ({ kept, total }) => (total ? kept / total : null);
const show = ({ kept, total }) => (total ? `${kept}/${total} (${pct(kept / total)})` : "n/a");

export const name = "transcribe";

export async function run({ client, variant, log }) {
  // A variant is a candidate fix, compared against the shipped instruction prompt.
  const options = variant ? TRANSCRIBE_VARIANTS[variant] : undefined;
  const recorded = loadScripts().filter((s) =>
    fs.existsSync(path.join(RECORDINGS_DIR, `${s.id}.webm`)) &&
    fs.existsSync(path.join(RECORDINGS_DIR, `${s.id}.browser.txt`))
  );

  if (recorded.length === 0) {
    return { skipped: "No recordings yet. Start the app and record clips at /capture.html." };
  }

  const outcomes = await mapLimit(recorded, 3, async (script) => {
    try {
      const audio = fs.readFileSync(path.join(RECORDINGS_DIR, `${script.id}.webm`));
      const browser = fs.readFileSync(path.join(RECORDINGS_DIR, `${script.id}.browser.txt`), "utf8");
      const gpt = await transcribeAudio(client, audio, options);

      const row = {
        id: script.id,
        reference: script.text,
        // An empty browser transcript means the recogniser produced nothing, which says
        // nothing about its accuracy; it is reported, not scored as 100% wrong.
        browserHeardNothing: !browser.trim(),
        browser: { text: browser, ...wer(script.text, browser), ...fidelity(script, browser) },
        gpt: { text: gpt, ...wer(script.text, gpt), ...fidelity(script, gpt) },
      };
      log(`  ${script.id}: browser ${row.browserHeardNothing ? "heard nothing" : pct(row.browser.wer)}  gpt ${pct(row.gpt.wer)}`);
      return row;
    } catch (err) {
      log(`  ${script.id}: ERROR ${err.message}`);
      return { id: script.id, error: err.message };
    }
  });

  const errored = outcomes.filter((r) => r.error);
  const rows = outcomes.filter((r) => !r.error);
  const browserRows = rows.filter((r) => !r.browserHeardNothing);

  const gptWer = mean(rows.map((r) => r.gpt.wer));
  // Compare like with like: both systems over the clips the browser actually transcribed.
  const gptWerOnBrowserClips = mean(browserRows.map((r) => r.gpt.wer));
  const browserWer = mean(browserRows.map((r) => r.browser.wer));

  const phrases = { gpt: pooled(rows, "gpt", "phrases"), browser: pooled(browserRows, "browser", "phrases") };
  const fillers = { gpt: pooled(rows, "gpt", "fillers"), browser: pooled(browserRows, "browser", "fillers") };

  const floorCheck = (label, floor, hard, stat) => ({
    name: `${label} (floor ${pct(floor)})`,
    hard,
    // No scored items is "not measured", not a pass or a fail.
    pass: rate(stat.gpt) === null ? true : rate(stat.gpt) >= floor,
    detail: `gpt ${show(stat.gpt)} vs browser ${show(stat.browser)}`,
  });

  return {
    model: options?.model ?? transcribeModel(),
    summary: {
      clips: rows.length,
      browserHeardNothing: rows.length - browserRows.length,
      wer: { gpt: gptWer, gptOnBrowserClips: gptWerOnBrowserClips, browser: browserWer },
      phrasesKept: { gpt: rate(phrases.gpt), browser: rate(phrases.browser) },
      fillersKept: { gpt: rate(fillers.gpt), browser: rate(fillers.browser) },
    },
    checks: [
      { name: "every clip transcribed", hard: true, pass: errored.length === 0, detail: `${errored.length} of ${recorded.length} failed` },
      {
        name: "gpt-transcribe beats the browser on word error rate",
        hard: false,
        pass: browserRows.length > 0 && gptWerOnBrowserClips < browserWer,
        detail: browserRows.length
          ? `gpt ${pct(gptWerOnBrowserClips)} vs browser ${pct(browserWer)} over ${browserRows.length} clips`
          : "browser transcribed none of the clips",
      },
      floorCheck("learner errors survive transcription", 0.9, true, phrases),
      floorCheck("fillers survive transcription", 0.8, false, fillers),
    ],
    failures: [
      ...errored.map((r) => `${r.id}: ${r.error}`),
      ...rows.filter((r) => r.gpt.wer > POOR_WER).map((r) => `${r.id}: gpt WER ${pct(r.gpt.wer)} - "${r.gpt.text}"`),
    ],
    data: outcomes,
  };
}
