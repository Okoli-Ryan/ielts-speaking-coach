/**
 * Text scoring for the transcription evals: normalisation and word error rate.
 */

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** 0-999,999 as spoken words, so "40,000" and "forty thousand" compare equal. */
function numberToWords(n) {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : "");
  if (n < 1000) {
    return `${ONES[Math.floor(n / 100)]} hundred` + (n % 100 ? ` ${numberToWords(n % 100)}` : "");
  }
  return `${numberToWords(Math.floor(n / 1000))} thousand` + (n % 1000 ? ` ${numberToWords(n % 1000)}` : "");
}

// Spelling variants the scripts could plausibly come back in. Illustrative, not exhaustive:
// add a pair when an eval fails on a spelling difference rather than a real error.
// A Map, not an object, so a spoken word like "constructor" is not read off the prototype.
const SPELLING = new Map([
  ["harbor", "harbour"],
  ["okay", "ok"],
]);

/**
 * Lower-cases, spells out numbers, and drops punctuation, so only the words are compared.
 * Apostrophes are removed rather than split on, so "I'm" stays one word. Numbers are
 * read as plain integers below a million: years ("2019"), decimals and ordinals are out
 * of scope, and the scripts avoid them.
 */
export function normalise(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/\d{1,3}(,\d{3})+|\d+/g, (m) => ` ${numberToWords(Number(m.replace(/,/g, "")))} `)
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => SPELLING.get(w) ?? w)
    .join(" ");
}

/**
 * Word error rate: (substitutions + deletions + insertions) / reference words.
 * Standard Levenshtein over words, backtracked to split the three kinds of error.
 */
export function wer(reference, hypothesis) {
  const ref = normalise(reference).split(" ").filter(Boolean);
  const hyp = normalise(hypothesis).split(" ").filter(Boolean);

  const d = Array.from({ length: ref.length + 1 }, (_, i) => {
    const row = new Array(hyp.length + 1).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= hyp.length; j++) d[0][j] = j;

  for (let i = 1; i <= ref.length; i++) {
    for (let j = 1; j <= hyp.length; j++) {
      d[i][j] = Math.min(
        d[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1),
        d[i - 1][j] + 1,
        d[i][j - 1] + 1
      );
    }
  }

  let substitutions = 0;
  let deletions = 0;
  let insertions = 0;
  for (let i = ref.length, j = hyp.length; i > 0 || j > 0; ) {
    if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1)) {
      if (ref[i - 1] !== hyp[j - 1]) substitutions++;
      i--;
      j--;
    } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
      deletions++;
      i--;
    } else {
      insertions++;
      j--;
    }
  }

  const errors = substitutions + deletions + insertions;
  return {
    wer: ref.length ? errors / ref.length : hyp.length ? 1 : 0,
    errors,
    substitutions,
    deletions,
    insertions,
    words: ref.length,
  };
}

/** True when the normalised text contains the normalised phrase as whole words. */
export function containsPhrase(text, phrase) {
  // An empty phrase would match nothing, so a typo in a fixture would pass silently.
  if (!normalise(phrase)) throw new Error(`Fixture phrase has no words: ${JSON.stringify(phrase)}`);
  return ` ${normalise(text)} `.includes(` ${normalise(phrase)} `);
}
