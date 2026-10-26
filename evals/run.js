/**
 * Runs the evals and exits non-zero if a hard check fails.
 *
 *   npm run eval                       all evals
 *   npm run eval -- repair             one eval (repair | transcribe | marker | disagreement)
 *   npm run eval -- repair --runs 3    repeat each repair case, to see variance
 *   npm run eval -- --model gpt-5.6-terra
 *   npm run eval -- marker --model claude-sonnet-5-5   any provider with a key in .env
 *   npm run eval -- repair --variant naive   negative control: should FAIL
 *   npm run eval -- transcribe --variant primed   verbatim-example prompt, to compare
 *
 * Hard checks are the ones that, if they fail, make a mark untrustworthy. Soft checks
 * report quality and never fail the run.
 */
import "dotenv/config";

import { MODEL_CATALOG, defaultModelId, resolveModel } from "../server/models.js";
import { providers, getProvider } from "../server/providers/index.js";
import { saveResult } from "./lib/harness.js";
import * as repair from "./repair.eval.js";
import * as transcribe from "./transcribe.eval.js";
import * as marker from "./marker.eval.js";
import * as disagreement from "./disagreement.eval.js";

const ALL = [repair, transcribe, marker, disagreement];

const FLAGS = ["model", "runs", "variant"];
// Which weaker or candidate prompt each eval can be run with.
const VARIANTS = { repair: ["naive"], transcribe: ["primed", "keywords", "context", "whisper"] };

function usage(message) {
  console.error(`${message}
Usage: npm run eval -- [${ALL.map((e) => e.name).join("|")}]... [--model id] [--runs n] [--variant naive|primed|keywords|context|whisper]`);
  process.exit(2);
}

// Flags take a value; everything else is an eval name. Anything unrecognised is an
// error, because a typo that runs the wrong thing and reports success is worse than a crash.
const args = process.argv.slice(2);
const values = {};
const wanted = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--")) {
    const key = args[i].slice(2);
    if (!FLAGS.includes(key)) usage(`Unknown flag ${args[i]}.`);
    if (args[i + 1] === undefined || args[i + 1].startsWith("--")) usage(`Flag ${args[i]} needs a value.`);
    values[key] = args[++i];
  } else {
    wanted.push(args[i]);
  }
}

const modelId = values.model || defaultModelId(providers);
if (values.model && !MODEL_CATALOG.some((m) => m.id === values.model)) {
  usage(`Unknown model "${values.model}". Choose from: ${MODEL_CATALOG.map((m) => m.id).join(", ")}.`);
}
const runs = Number(values.runs ?? 1);
const variant = values.variant;
if (!Number.isInteger(runs) || runs < 1) usage(`--runs must be a whole number of at least 1, got "${values.runs}".`);
if (variant && !Object.values(VARIANTS).flat().includes(variant)) usage(`Unknown variant "${variant}".`);
const unknown = wanted.filter((w) => !ALL.some((e) => e.name === w));
if (unknown.length) usage(`Unknown eval: ${unknown.join(", ")}.`);

// Each eval needs a key for the provider it calls: the chosen model's for repair and
// marker, OpenAI's for transcription (Anthropic has no speech-to-text).
const provider = providers.find((p) => p.id === resolveModel(modelId, providers).provider);
const needs = { repair: provider, marker: provider, transcribe: getProvider("openai") };

const selected = wanted.length ? ALL.filter((e) => wanted.includes(e.name)) : ALL;

// A run on a model other than the default gets its own file, so it never overwrites the baseline.
const MODEL_EVALS = new Set(["repair", "marker"]);
const resultName = (name) =>
  [name, usesVariant(name) ? variant : null, values.model && MODEL_EVALS.has(name) ? values.model : null].filter(Boolean).join(".");

const usesVariant = (evalName) => Boolean(variant && VARIANTS[evalName]?.includes(variant));

let hardFailures = 0;
let ran = 0;
let skipped = 0;

for (const evalModule of selected) {
  console.log(`\n== ${evalModule.name} ==`);
  const keyHolder = needs[evalModule.name];
  if (keyHolder && !keyHolder.configured()) {
    console.log(`  skipped: ${keyHolder.keyEnv} is not set (this eval calls ${keyHolder.label}).`);
    skipped++;
    continue;
  }
  let result;
  try {
    result = await evalModule.run({
      modelId,
      runs,
      variant: usesVariant(evalModule.name) ? variant : undefined,
      log: console.log,
    });
  } catch (err) {
    console.error(`  crashed: ${process.env.DEBUG ? err.stack : err.message}`);
    hardFailures++;
    continue;
  }

  if (result.skipped) {
    console.log(`  skipped: ${result.skipped}`);
    skipped++;
    continue;
  }
  ran++;

  for (const c of result.checks) {
    const mark = c.pass ? "PASS" : c.hard ? "FAIL" : "warn";
    console.log(`  [${mark}] ${c.name} - ${c.detail}`);
    if (!c.pass && c.hard) hardFailures++;
  }
  for (const f of result.failures) console.log(`    ! ${f}`);
  if (runs > 1 && result.perCase) console.log(`  per case: ${result.perCase.join(", ")}`);

  const file = saveResult(resultName(evalModule.name), { ranAt: new Date().toISOString(), runs, ...result });
  console.log(`  saved ${file}`);
}

const tally = `${ran} ran, ${skipped} skipped`;
if (hardFailures) console.log(`\n${hardFailures} hard check(s) failed (${tally}).`);
else if (ran === 0) console.log(`\nNothing ran (${tally}).`);
else console.log(`\nAll hard checks passed (${tally}).`);
process.exit(hardFailures || ran === 0 ? 1 : 0);
