/**
 * Runs the evals and exits non-zero if a hard check fails.
 *
 *   npm run eval                       all evals
 *   npm run eval -- repair             one eval (repair | transcribe | marker | disagreement)
 *   npm run eval -- repair --runs 3    repeat each repair case, to see variance
 *   npm run eval -- --model gpt-5.6-terra
 *   npm run eval -- repair --variant naive   negative control: should FAIL
 *   npm run eval -- transcribe --variant primed   verbatim-example prompt, to compare
 *
 * Hard checks are the ones that, if they fail, make a mark untrustworthy. Soft checks
 * report quality and never fail the run.
 */
import "dotenv/config";

import { DEFAULT_MODEL } from "../server/models.js";
import { client, saveResult } from "./lib/harness.js";
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

const modelId = values.model || DEFAULT_MODEL;
const runs = Number(values.runs ?? 1);
const variant = values.variant;
if (!Number.isInteger(runs) || runs < 1) usage(`--runs must be a whole number of at least 1, got "${values.runs}".`);
if (variant && !Object.values(VARIANTS).flat().includes(variant)) usage(`Unknown variant "${variant}".`);
const unknown = wanted.filter((w) => !ALL.some((e) => e.name === w));
if (unknown.length) usage(`Unknown eval: ${unknown.join(", ")}.`);

if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is not set. Add it to .env first.");
  process.exit(2);
}

const selected = wanted.length ? ALL.filter((e) => wanted.includes(e.name)) : ALL;

const usesVariant = (evalName) => Boolean(variant && VARIANTS[evalName]?.includes(variant));

let hardFailures = 0;
let ran = 0;
let skipped = 0;

for (const evalModule of selected) {
  console.log(`\n== ${evalModule.name} ==`);
  let result;
  try {
    result = await evalModule.run({
      client: client(),
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

  const file = saveResult(usesVariant(evalModule.name) ? `${evalModule.name}.${variant}` : evalModule.name, { ranAt: new Date().toISOString(), runs, ...result });
  console.log(`  saved ${file}`);
}

const tally = `${ran} ran, ${skipped} skipped`;
if (hardFailures) console.log(`\n${hardFailures} hard check(s) failed (${tally}).`);
else if (ran === 0) console.log(`\nNothing ran (${tally}).`);
else console.log(`\nAll hard checks passed (${tally}).`);
process.exit(hardFailures || ran === 0 ? 1 : 0);
