import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { scoreCase } from "./repair.eval.js";

const cases = JSON.parse(fs.readFileSync(new URL("./fixtures/repair.json", import.meta.url), "utf8"));
const byId = (id) => cases.find((c) => c.id === id);
const passes = (score) => [...score.fixes, ...score.guards].every((c) => c.pass);

test("returning the input untouched fails every case that needs a fix", () => {
  for (const c of cases.filter((c) => c.mustFix.length)) {
    assert.ok(!scoreCase(c, c.turns).fixes.every((f) => f.pass), c.id);
  }
});

test("returning the input untouched passes every case that expects no change", () => {
  for (const c of cases.filter((c) => c.expectUnchanged)) {
    assert.ok(passes(scoreCase(c, c.turns)), c.id);
  }
});

test("a tidied grammar-only turn fails the guards", () => {
  const c = byId("grammar-only");
  const tidied = ["Yesterday I bought a new phone because the old one was broken. It is faster than before."];
  assert.ok(!passes(scoreCase(c, tidied)));
});

test("fixing the word but also the plural fails: many recipes", () => {
  const c = byId("receipt-for-recipe");
  const score = scoreCase(c, ["My mother cook many recipes for me when I was a child."]);
  assert.ok(!passes(score));
});

test("the correct repair passes", () => {
  const c = byId("receipt-for-recipe");
  assert.ok(passes(scoreCase(c, ["My mother cook many recipe for me when I was a child."])));
});

test("a missing turn counts as a change, so expectUnchanged fails", () => {
  const c = byId("clean-fluent");
  assert.ok(!passes(scoreCase(c, [""])));
});

test("index alignment: a fix landing on the wrong turn fails", () => {
  const c = byId("index-alignment");
  const shifted = ["I am work as a developer.", "My mother cook many receipt for me.", "He don't like football."];
  assert.ok(!passes(scoreCase(c, shifted)));
});
