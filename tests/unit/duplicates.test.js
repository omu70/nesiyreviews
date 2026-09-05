// =============================================================
// Duplicate detection
// File: /tests/unit/duplicates.test.js
//
// This is the only rule in the app that decides which rows get
// destroyed, so the cases below are mostly about what it must NOT
// delete.
// =============================================================
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeText, duplicateKey, planDuplicateRemoval } from "../../lib/duplicates.js";

const row = (over) => ({
  id: "x",
  product_handle: "kurta",
  author_name: "Priya S",
  rating: 5,
  content: "Fabric is soft and the fit is perfect.",
  status: "approved",
  created_at: "2026-01-01T00:00:00Z",
  ...over,
});

test("normalisation ignores case, punctuation and whitespace runs", () => {
  assert.equal(normalizeText("Great   product!!"), normalizeText("great product"));
  // The case that actually shows up: a CSV round-trip turns a straight
  // quote into a curly one. Both are punctuation, so both drop out.
  assert.equal(normalizeText("It\u2019s good"), normalizeText("It's good"));
});

test("normalisation keeps non-Latin scripts instead of emptying them", () => {
  // Two different Hindi reviews must not normalise to the same string.
  assert.notEqual(normalizeText("बहुत अच्छा है"), normalizeText("खराब क्वालिटी"));
  assert.notEqual(normalizeText("बहुत अच्छा है"), "");
});

test("a re-imported CSV collapses to one copy", () => {
  const rows = [
    row({ id: "a", created_at: "2026-01-01T00:00:00Z" }),
    row({ id: "b", created_at: "2026-03-01T00:00:00Z" }),
    row({ id: "c", created_at: "2026-03-01T00:00:01Z" }),
  ];
  const { duplicateIds, preview } = planDuplicateRemoval(rows);
  assert.deepEqual(duplicateIds.sort(), ["b", "c"]);
  assert.equal(preview[0].copies, 3);
  assert.equal(preview[0].removing, 2);
});

test("the earliest copy is the one kept", () => {
  const { duplicateIds } = planDuplicateRemoval([
    row({ id: "new", created_at: "2026-05-01T00:00:00Z" }),
    row({ id: "old", created_at: "2026-01-01T00:00:00Z" }),
  ]);
  assert.deepEqual(duplicateIds, ["new"]);
});

test("a copy with photos outranks an earlier copy without", () => {
  const { duplicateIds } = planDuplicateRemoval([
    row({ id: "bare", created_at: "2026-01-01T00:00:00Z" }),
    row({ id: "photos", created_at: "2026-04-01T00:00:00Z", image_urls: ["https://x/1.jpg"] }),
  ]);
  assert.deepEqual(duplicateIds, ["bare"], "the shopper's photo is the irreplaceable part");
});

test("two different people saying the same thing are left alone", () => {
  const { duplicateIds } = planDuplicateRemoval([
    row({ id: "a", author_name: "Priya S" }),
    row({ id: "b", author_name: "Anita R" }),
  ]);
  assert.deepEqual(duplicateIds, []);
});

test("the same words about a different product are left alone", () => {
  const { duplicateIds } = planDuplicateRemoval([
    row({ id: "a", product_handle: "kurta" }),
    row({ id: "b", product_handle: "saree" }),
  ]);
  assert.deepEqual(duplicateIds, []);
});

test("the same words at a different rating are left alone", () => {
  const { duplicateIds } = planDuplicateRemoval([
    row({ id: "a", rating: 5 }),
    row({ id: "b", rating: 3 }),
  ]);
  assert.deepEqual(duplicateIds, []);
});

test("empty-bodied reviews are never grouped", () => {
  const { duplicateIds } = planDuplicateRemoval([
    row({ id: "a", content: "" }),
    row({ id: "b", content: "   " }),
    row({ id: "c", content: "!!!" }),
  ]);
  assert.deepEqual(duplicateIds, [], "a bare rating is not evidence of a duplicate");
});

test("a group of n always keeps exactly one", () => {
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push(row({ id: `r${i}`, created_at: `2026-01-01T00:00:${String(i).padStart(2, "0")}Z` }));
  const { duplicateIds } = planDuplicateRemoval(rows);
  assert.equal(duplicateIds.length, rows.length - 1);
  assert.equal(duplicateIds.includes("r0"), false, "the original survives");
});

test("distinct reviews across a whole shop produce no deletions", () => {
  const rows = [];
  for (let i = 0; i < 50; i++) {
    rows.push(row({ id: `r${i}`, author_name: `Buyer ${i}`, content: `Review number ${i}` }));
  }
  assert.deepEqual(planDuplicateRemoval(rows).duplicateIds, []);
});

test("the key is stable across whitespace and case drift", () => {
  assert.equal(
    duplicateKey(row({ content: "Fabric is SOFT and the fit is perfect!" })),
    duplicateKey(row({ content: "fabric is soft   and the fit is perfect" }))
  );
});

test("nothing to scan is not an error", () => {
  assert.deepEqual(planDuplicateRemoval([]), { duplicateIds: [], preview: [], scanned: 0 });
  assert.deepEqual(planDuplicateRemoval(undefined).duplicateIds, []);
});
