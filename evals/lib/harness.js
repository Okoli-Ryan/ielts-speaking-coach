/**
 * Shared plumbing for the evals: a client, bounded concurrency, and result files.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";

const here = path.dirname(fileURLToPath(import.meta.url));
export const RESULTS_DIR = path.join(here, "..", "results");

export const client = () => new OpenAI();

/**
 * Runs `fn` over `items`, at most `limit` at a time, keeping input order. A failing
 * item becomes `{ error }` instead of rejecting the lot, so one 429 neither discards
 * the other results nor leaves workers spending money after the run has given up.
 */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i], i);
      } catch (err) {
        out[i] = { error: err?.message || String(err) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export const pct = (n) => `${(n * 100).toFixed(1)}%`;

export function saveResult(name, data) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const file = path.join(RESULTS_DIR, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  return file;
}
