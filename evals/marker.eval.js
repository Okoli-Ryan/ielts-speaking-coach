/**
 * Marker sanity, and the end-to-end inflation test.
 *
 *   ordering   - a weak, mid and strong answer to one question must rank in that order
 *   range      - and each should land near the band it was written to
 *   inflation  - take the mid answer, garble it the way a recogniser would, repair it,
 *                and mark the result. It must not score higher than the original.
 *   demonstration - the same marker on a "tidied" weak answer shows what an unguarded
 *                repair would be worth to a candidate who has done nothing
 *
 * The transcripts are written for this repo, so they are anchors for consistency
 * rather than examiner-certified samples. Bands are for the marker, not for the person.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { resolveModel } from "../server/models.js";
import { providers } from "../server/providers/index.js";
import { assessTranscript, repairTurns } from "../server/core.js";
import { mapLimit } from "./lib/harness.js";

const fx = JSON.parse(
  fs.readFileSync(fileURLToPath(new URL("./fixtures/marker.json", import.meta.url)), "utf8")
);

// One sample moves in half-band steps, so a tolerance below 0.5 only means something on a
// mean over several runs. Use --runs 3 or more for the strict figure.
const tolerance = (runs) => (runs > 1 ? 0.25 : 0.5);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

export const name = "marker";

export async function run({ modelId, runs = 1, log }) {
  const model = resolveModel(modelId, providers);

  const mark = async (label, answer) => {
    const response = await assessTranscript(model, {
      part: 2,
      targetBand: fx.targetBand,
      transcript: [
        { role: "examiner", text: fx.question },
        { role: "candidate", text: answer },
      ],
    });
    const a = response.data;
    log(`  ${label}: overall ${a.overall_band}, grammar ${a.grammatical_range.band}`);
    return { overall: a.overall_band, grammar: a.grammatical_range.band };
  };

  // Repair first: the pipeline marks what the repair pass returns, not the raw noise.
  // A missing or unchanged result would make the inflation check pass for the wrong
  // reason, so either one stops the eval.
  const repair = await repairTurns(model, [fx.noisyMid]);
  const repairedMid = repair.data.turns.find((t) => t.index === 0)?.corrected;
  if (!repairedMid) throw new Error("Repair returned no result for the garbled answer.");
  if (repairedMid.trim() === fx.noisyMid.trim()) {
    throw new Error("Repair changed nothing in the garbled answer, so there is nothing to test.");
  }

  const inputs = [
    ["weak", fx.answers.weak.text],
    ["mid", fx.answers.mid.text],
    ["strong", fx.answers.strong.text],
    ["mid (garbled)", fx.noisyMid],
    ["mid (garbled, repaired)", repairedMid],
    ["weak (tidied)", fx.tidiedWeak],
  ];
  const jobs = inputs.flatMap(([label, text]) => Array.from({ length: runs }, () => [label, text]));
  const outcomes = await mapLimit(jobs, 3, ([label, text]) => mark(label, text));

  const errors = outcomes.filter((o) => o.error);
  const marks = {};
  inputs.forEach(([label], i) => {
    const mine = outcomes.slice(i * runs, (i + 1) * runs).filter((o) => !o.error);
    marks[label] = mine.length
      ? { overall: mean(mine.map((m) => m.overall)), grammar: mean(mine.map((m) => m.grammar)), n: mine.length }
      : null;
  });

  const missing = Object.entries(marks).filter(([, m]) => !m).map(([l]) => l);
  if (missing.length) {
    return {
      model: model.id,
      summary: {},
      checks: [{ name: "every answer was marked", hard: true, pass: false, detail: `no mark for: ${missing.join(", ")}` }],
      failures: errors.map((e) => e.error),
      data: { repairedMid, marks },
    };
  }

  const { weak, mid, strong } = { weak: marks["weak"], mid: marks["mid"], strong: marks["strong"] };
  const inRange = (m, key) => m.overall >= fx.answers[key].expected[0] && m.overall <= fx.answers[key].expected[1];
  const repaired = marks["mid (garbled, repaired)"];
  const garbled = marks["mid (garbled)"];
  const tidied = marks["weak (tidied)"];
  const tol = tolerance(runs);

  return {
    model: model.id,
    summary: {
      weak: weak.overall,
      mid: mid.overall,
      strong: strong.overall,
      garbledPenalty: mid.overall - garbled.overall,
      repairedVsOriginal: repaired.overall - mid.overall,
      repairedVsGarbled: repaired.overall - garbled.overall,
      tidyingInflation: tidied.overall - weak.overall,
      tidyingGrammarInflation: tidied.grammar - weak.grammar,
    },
    checks: [
      { name: "every mark came back", hard: true, pass: errors.length === 0, detail: `${errors.length} of ${jobs.length} failed` },
      {
        name: "weak < mid < strong",
        hard: true,
        pass: weak.overall < mid.overall && mid.overall < strong.overall,
        detail: `${weak.overall} < ${mid.overall} < ${strong.overall}`,
      },
      {
        name: "each answer lands in its written range",
        hard: false,
        pass: inRange(weak, "weak") && inRange(mid, "mid") && inRange(strong, "strong"),
        detail: `weak ${weak.overall} ${JSON.stringify(fx.answers.weak.expected)}, mid ${mid.overall} ${JSON.stringify(fx.answers.mid.expected)}, strong ${strong.overall} ${JSON.stringify(fx.answers.strong.expected)}`,
      },
      {
        name: `repair does not inflate the mark (tolerance ${tol}, ${runs} run${runs > 1 ? "s" : ""})`,
        hard: true,
        pass: repaired.overall - mid.overall <= tol && repaired.grammar - mid.grammar <= tol,
        detail: `overall ${mid.overall} -> ${repaired.overall}, grammar ${mid.grammar} -> ${repaired.grammar}`,
      },
      {
        name: "demonstration: tidying grammar would raise Grammatical Range",
        hard: false,
        pass: tidied.grammar - weak.grammar >= 0.5,
        detail: `grammar ${weak.grammar} -> ${tidied.grammar}, overall ${weak.overall} -> ${tidied.overall}`,
      },
    ],
    failures: errors.map((e) => e.error),
    data: { repairedMid, marks },
  };
}
