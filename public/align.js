/**
 * Compares two transcripts of the same answer, one from the browser recogniser and one
 * from an audio model, and reports where they disagree.
 *
 * Neither transcript can be trusted on its own: the browser drops phrases, and the audio
 * model quietly corrects grammar and drops fillers. Where they agree the text is probably
 * right. Where they disagree, one of them changed what was said, and nothing in either
 * text says which. The marker is told about those spots instead of being left to guess.
 */
import { normalise } from "./text.js";

const FILLERS = new Set(["um", "uh", "er", "erm"]);
const CONTEXT_WORDS = 3;

const words = (text) => normalise(text).split(" ").filter(Boolean);

/** Word-level edit script between two token lists, as ops over indexes into each. */
function align(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => {
    const row = new Array(b.length + 1).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
        d[i - 1][j] + 1,
        d[i][j - 1] + 1
      );
    }
  }

  const ops = [];
  for (let i = a.length, j = b.length; i > 0 || j > 0; ) {
    if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)) {
      ops.push({ type: a[i - 1] === b[j - 1] ? "match" : "change", i: i - 1, j: j - 1 });
      i--;
      j--;
    } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
      ops.push({ type: "only-a", i: i - 1 });
      i--;
    } else {
      ops.push({ type: "only-b", j: j - 1 });
      j--;
    }
  }
  return ops.reverse();
}

/**
 * Where the two transcripts differ. Each disagreement groups a run of changed words:
 *   changed             both heard something, and it differs ("went" / "worked")
 *   missing-in-audio    only the browser has these words (a dropped filler, a dropped repeat)
 *   missing-in-browser  only the audio model has them
 *   filler-dropped      the words the audio model lost are all fillers
 */
export function disagreements(browserText, audioText) {
  const a = words(browserText);
  const b = words(audioText);
  const ops = align(a, b);
  const found = [];

  let k = 0;
  let consumed = 0; // browser words passed so far, so an insertion-only run still has a position
  while (k < ops.length) {
    if (ops[k].type === "match") {
      consumed++;
      k++;
      continue;
    }
    const start = k;
    while (k < ops.length && ops[k].type !== "match") k++;
    const run = ops.slice(start, k);
    const runStart = consumed;

    const browser = run.filter((o) => o.i !== undefined).map((o) => a[o.i]);
    const audio = run.filter((o) => o.j !== undefined).map((o) => b[o.j]);

    // Context comes from the browser side, which is the longer-lived transcript in the app.
    const firstI = run.find((o) => o.i !== undefined)?.i ?? runStart;
    const lastI = [...run].reverse().find((o) => o.i !== undefined)?.i ?? runStart - 1;
    consumed += browser.length;

    let kind = "changed";
    if (browser.length && !audio.length) {
      kind = browser.every((w) => FILLERS.has(w)) ? "filler-dropped" : "missing-in-audio";
    } else if (!browser.length) {
      kind = "missing-in-browser";
    }

    found.push({
      kind,
      browser: browser.join(" "),
      audio: audio.join(" "),
      before: a.slice(Math.max(0, firstI - CONTEXT_WORDS), firstI).join(" "),
      after: a.slice(lastI + 1, lastI + 1 + CONTEXT_WORDS).join(" "),
    });
  }
  return found;
}

// Control characters, line separators and double quotes all become spaces, so a value
// cannot break out of the quoted slot it is printed in.
const clean = (value) =>
  String(value ?? "").replace(/[\p{C}\p{Zl}\p{Zp}"]+/gu, " ").trim().slice(0, 80);

const MAX_NOTES = 40;
const MAX_NOTES_CHARS = 6000;

// A Map, so a kind like "__proto__" or "constructor" from the client finds nothing.
const DESCRIBE = new Map([
  ["changed", (d) => `the browser heard "${clean(d.browser)}", the audio model wrote "${clean(d.audio)}"`],
  ["missing-in-audio", (d) => `the browser heard "${clean(d.browser)}", which the audio model left out`],
  ["filler-dropped", (d) => `the browser heard the filler "${clean(d.browser)}", which the audio model left out`],
  ["missing-in-browser", (d) => `the audio model wrote "${clean(d.audio)}", which the browser did not hear`],
]);

/**
 * Turns per-turn disagreements into the notes the marker sees. Input is untrusted
 * (it arrives from the browser), so only known kinds and short strings get through.
 */
export function formatNotes(items) {
  const lines = [];
  for (const item of (Array.isArray(items) ? items : []).slice(0, MAX_NOTES)) {
    const describe = DESCRIBE.get(item?.kind);
    if (!describe) continue;
    // The spot is identified by its surrounding words: the transcript has no turn numbers.
    lines.push(`- Around "${clean(item.before)} ... ${clean(item.after)}": ${describe(item)}.`);
  }
  return lines.join("\n").slice(0, MAX_NOTES_CHARS);
}
