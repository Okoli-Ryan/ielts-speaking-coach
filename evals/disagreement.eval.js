/**
 * Disagreement flagging: does comparing the browser transcript with the audio model's
 * transcript expose the places where the audio model changed what the speaker said?
 *
 * Runs offline, on the clips already scored by the transcribe eval (it reads that eval's
 * saved result), so it costs nothing and is deterministic. A "tidying" is a scripted
 * learner error or filler that the audio model lost. It is detectable when the browser
 * still has it, because then the transcripts disagree there. When both systems lost it,
 * they agree on the wrong text and no comparison can see it; those are counted, not hidden.
 *
 * "Flagged" is strict: the scripted phrase has to sit inside the words around a
 * disagreement, so a clip that merely contains some disagreement somewhere does not count.
 * A comparison that finds nothing is run as a negative control and must catch nothing.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadScripts } from "../server/clips.js";
import { disagreements } from "../public/align.js";
import { normalise, containsPhrase } from "./lib/text.js";

const resultFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "results", "transcribe.json");

const FILLERS = ["um", "uh", "er", "erm"];
const countFillers = (text) => normalise(text).split(" ").filter((w) => FILLERS.includes(w)).length;

/** The words a disagreement covers on the browser side, with its surrounding context. */
const windowOf = (d) => `${d.before} ${d.browser} ${d.after}`;

/** Lists every tidying in the saved clips and whether `compare` flagged it. */
function findTidyings(rows, scripts, compare, log) {
  const tidyings = [];
  for (const row of rows) {
    const script = scripts.get(row.id);
    if (!script) continue;
    const found = compare(row.browser.text, row.gpt.text);

    for (const phrase of script.keep.filter((p) => !FILLERS.includes(p))) {
      if (containsPhrase(row.gpt.text, phrase)) continue; // the audio model kept it
      tidyings.push({
        clip: row.id,
        what: phrase,
        browserHasIt: containsPhrase(row.browser.text, phrase),
        flagged: found.some((d) => containsPhrase(windowOf(d), phrase)),
      });
    }

    // Fillers are matched by count: each filler the audio model lost needs its own
    // filler-bearing disagreement on the browser side.
    const lost = Math.max(0, countFillers(script.text) - countFillers(row.gpt.text));
    const fillerSpots = found.reduce((n, d) => n + countFillers(d.browser), 0);
    for (let n = 0; n < lost; n++) {
      tidyings.push({
        clip: row.id,
        what: "filler",
        browserHasIt: countFillers(row.browser.text) > n,
        flagged: n < fillerSpots,
      });
    }
    log?.(`  ${row.id}: ${found.length} disagreement${found.length === 1 ? "" : "s"}`);
  }
  return tidyings;
}

export const name = "disagreement";

export async function run({ log }) {
  if (!fs.existsSync(resultFile)) {
    return { skipped: "No transcribe result yet. Run the transcribe eval first." };
  }
  const saved = JSON.parse(fs.readFileSync(resultFile, "utf8"));
  if (!Array.isArray(saved.data)) {
    return { skipped: "The saved transcribe result has no clips (that run was skipped). Rerun the transcribe eval." };
  }
  const rows = saved.data.filter((r) => !r.error);
  const scripts = new Map(loadScripts().map((s) => [s.id, s]));

  const tidyings = findTidyings(rows, scripts, disagreements, log);
  const control = findTidyings(rows, scripts, () => []);

  const detectable = tidyings.filter((t) => t.browserHasIt);
  const caught = detectable.filter((t) => t.flagged);
  const invisible = tidyings.filter((t) => !t.browserHasIt);
  const controlCaught = control.filter((t) => t.browserHasIt && t.flagged).length;

  return {
    summary: {
      tidyings: tidyings.length,
      detectable: detectable.length,
      caught: caught.length,
      invisible: invisible.length,
      controlCaught,
    },
    checks: [
      {
        name: "every detectable tidying is flagged",
        hard: true,
        pass: detectable.length > 0 && caught.length === detectable.length,
        detail: `${caught.length}/${detectable.length} flagged`,
      },
      {
        name: "negative control: a comparison that finds nothing catches nothing",
        hard: true,
        pass: detectable.length > 0 && controlCaught === 0,
        detail: `${controlCaught} caught`,
      },
      {
        name: "tidyings no comparison can see (both transcripts lost them)",
        hard: false,
        pass: invisible.length === 0,
        detail: `${invisible.length} of ${tidyings.length}`,
      },
    ],
    failures: [
      ...detectable.filter((t) => !t.flagged).map((t) => `${t.clip}: "${t.what}" tidied but not flagged`),
      ...invisible.map(
        (t) => `${t.clip}: "${t.what}" lost by both${t.flagged ? ", but the transcripts still disagree nearby" : ", so the comparison cannot see it"}`
      ),
    ],
    data: tidyings,
  };
}
