import test from "node:test";
import assert from "node:assert/strict";

import { normalise, wer, containsPhrase } from "./text.js";

test("normalise drops case and punctuation and spells out numbers", () => {
  assert.equal(normalise("It cost me 40,000 naira!"), "it cost me forty thousand naira");
  assert.equal(normalise("Um, I have 3 bedrooms."), "um i have three bedrooms");
});

test("wer is zero for identical text regardless of case and punctuation", () => {
  assert.equal(wer("I am work here.", "i am work here").wer, 0);
});

const kinds = ({ substitutions, deletions, insertions }) => ({ substitutions, deletions, insertions });

test("wer counts substitutions, deletions and insertions separately", () => {
  assert.deepEqual(kinds(wer("a b c", "a x c")), { substitutions: 1, deletions: 0, insertions: 0 });
  assert.deepEqual(kinds(wer("a b c", "a c")), { substitutions: 0, deletions: 1, insertions: 0 });
  assert.deepEqual(kinds(wer("a c", "a b c")), { substitutions: 0, deletions: 0, insertions: 1 });
});

test("wer divides total errors by reference length", () => {
  // Several alignments tie here, so only the total is asserted.
  const r = wer("my college is near", "my colleague near here");
  assert.equal(r.errors, 3);
  assert.equal(r.words, 4);
  assert.equal(r.wer, 0.75);
});

test("tidying a learner error counts as a transcription error", () => {
  assert.ok(wer("I am work as a developer", "I am working as a developer").wer > 0);
});

test("containsPhrase matches whole words only", () => {
  assert.ok(containsPhrase("He don't like football", "he don't like"));
  assert.ok(!containsPhrase("many recipes", "many recipe"));
});

test("a spoken word that is also an Object property is left alone", () => {
  assert.equal(normalise("the constructor"), "the constructor");
});

test("apostrophes join rather than split words", () => {
  assert.equal(normalise("I'm sure he don’t"), "im sure he dont");
});

test("empty and missing text are handled", () => {
  assert.equal(normalise(undefined), "");
  assert.equal(wer("", "").wer, 0);
  assert.equal(wer("a b", "").wer, 1);
  assert.equal(wer("", "a").wer, 1);
});

test("a phrase with no words is a fixture bug, not a match", () => {
  assert.throws(() => containsPhrase("anything", "?"));
});
