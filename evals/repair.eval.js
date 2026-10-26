/**
 * Repair guardrail. The repair pass may fix what the recogniser got wrong and must
 * never fix what the candidate got wrong, or the marked band rises on errors they
 * really made. Two numbers matter, and they are not symmetric:
 *
 *   recogniser-fix recall  - how many of the planted mis-hearings were fixed (soft)
 *   candidate preservation - how many planted candidate errors survived (hard: 100%)
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { resolveModel } from "../server/models.js";
import { providers } from "../server/providers/index.js";
import { repairTurns } from "../server/core.js";
import { normalise, containsPhrase } from "./lib/text.js";
import { mapLimit, pct } from "./lib/harness.js";
import { NAIVE_REPAIR_PROMPT } from "./lib/variants.js";

const cases = JSON.parse(
  fs.readFileSync(fileURLToPath(new URL("./fixtures/repair.json", import.meta.url)), "utf8")
);

const RECALL_FLOOR = 0.75;

const asKeep = (k) => (typeof k === "string" ? { turn: 0, phrase: k } : k);

/**
 * Scores one model response against one fixture.
 *
 * Matching is word-level: case and punctuation are ignored, so "changes nothing" means
 * no word changed. `mustFix.to` must appear in exactly that form ("recipe", not
 * "recipes"): it pairs with the `forbid` entries that catch a fix quietly repairing the
 * grammar attached to the word.
 */
export function scoreCase(fixture, corrected) {
  const fixes = (fixture.mustFix || []).map((f) => {
    const text = corrected[f.turn ?? 0] ?? "";
    return {
      label: `${f.from} -> ${f.to}`,
      pass: containsPhrase(text, f.to) && !containsPhrase(text, f.from),
    };
  });

  const guards = [
    ...(fixture.mustKeep || []).map(asKeep).map((k) => ({
      label: `keeps "${k.phrase}"`,
      pass: containsPhrase(corrected[k.turn] ?? "", k.phrase),
    })),
    ...(fixture.forbid || []).map((phrase) => ({
      label: `never writes "${phrase}"`,
      // Per turn, so a phrase cannot match across the join between two turns.
      pass: corrected.every((text) => !containsPhrase(text, phrase)),
    })),
  ];

  const changedTurns = corrected
    .map((text, i) => (normalise(text) === normalise(fixture.turns[i]) ? null : i))
    .filter((i) => i !== null);

  if (fixture.expectUnchanged) {
    guards.push({ label: "changes nothing", pass: changedTurns.length === 0 });
  }
  if (fixture.expectChangedTurns) {
    guards.push({
      label: `only turns [${fixture.expectChangedTurns}] change`,
      pass: JSON.stringify(changedTurns) === JSON.stringify(fixture.expectChangedTurns),
    });
  }

  return { fixes, guards, changedTurns };
}

export const name = "repair";

export async function run({ modelId, runs = 1, variant, log }) {
  const model = resolveModel(modelId, providers);
  // The naive prompt is a negative control: the eval is only worth having if it fails this.
  const instructions = variant === "naive" ? { instructions: NAIVE_REPAIR_PROMPT } : undefined;
  const jobs = cases.flatMap((fixture) => Array.from({ length: runs }, () => fixture));

  const outcomes = await mapLimit(jobs, 4, async (fixture) => {
    let response;
    try {
      response = await repairTurns(model, fixture.turns, instructions);
    } catch (err) {
      log(`  ${fixture.id}: ERROR ${err.message}`);
      return { id: fixture.id, error: err.message };
    }
    const byIndex = new Map(response.data.turns.map((t) => [t.index, t.corrected]));
    // A missing index is a failure to return the turn, not a pass by omission.
    const corrected = fixture.turns.map((original, i) => byIndex.get(i) ?? "");
    const score = scoreCase(fixture, corrected);
    log(`  ${fixture.id}: ${[...score.fixes, ...score.guards].every((c) => c.pass) ? "ok" : "FAIL"}`);
    return { id: fixture.id, original: fixture.turns, corrected, ...score };
  });

  const errored = outcomes.filter((r) => r.error);
  const results = outcomes.filter((r) => !r.error);

  const fixItems = results.flatMap((r) => r.fixes);
  const guardItems = results.flatMap((r) => r.guards);
  const unchangedCases = results.filter((r) => cases.find((c) => c.id === r.id).expectUnchanged);

  const recall = fixItems.length ? fixItems.filter((f) => f.pass).length / fixItems.length : 1;
  const preservation = guardItems.length ? guardItems.filter((g) => g.pass).length / guardItems.length : 1;
  const falseEditRate = unchangedCases.length
    ? unchangedCases.filter((r) => r.changedTurns.length > 0).length / unchangedCases.length
    : 0;

  const failures = [
    ...errored.map((r) => `${r.id}: model error - ${r.error}`),
    ...results.flatMap((r) =>
      [...r.fixes, ...r.guards].filter((c) => !c.pass).map((c) => `${r.id}: ${c.label}`)
    ),
  ];

  // Per-case pass counts, so run-to-run variance is visible when --runs > 1.
  const perCase = cases.map((c) => {
    const mine = results.filter((r) => r.id === c.id);
    const ok = mine.filter((r) => [...r.fixes, ...r.guards].every((x) => x.pass)).length;
    return `${c.id}: ${ok}/${runs}`;
  });

  return {
    model: model.id,
    summary: { recall, preservation, falseEditRate, cases: cases.length, runs },
    checks: [
      { name: "every call returned a result", hard: true, pass: errored.length === 0, detail: `${errored.length} of ${jobs.length} failed` },
      { name: "candidate errors preserved", hard: true, pass: preservation === 1, detail: pct(preservation) },
      { name: "no edits where nothing was misheard", hard: true, pass: falseEditRate === 0, detail: pct(falseEditRate) },
      { name: `recogniser errors fixed (floor ${pct(RECALL_FLOOR)})`, hard: false, pass: recall >= RECALL_FLOOR, detail: pct(recall) },
    ],
    failures,
    perCase,
    data: results,
  };
}
