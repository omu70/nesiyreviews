// =============================================================
// Duplicate review detection
// File: /lib/duplicates.js
//
// Pure functions, no database. Kept out of the route so the rule that
// decides what gets deleted can be tested directly — this is the one
// piece of the admin that destroys data, and "it looked right in the
// modal" is not a test.
// =============================================================

/**
 * Reduce a piece of text to the part worth comparing.
 *
 * Case, punctuation and runs of whitespace all vary between a review
 * and its re-import (a CSV round-trip reflows text, a copy-paste picks
 * up a smart quote) without changing what the review says.
 *
 * The character class is \p{L}\p{N} rather than \w so that Hindi,
 * Tamil and every other non-Latin script survives normalisation
 * instead of collapsing to an empty string — which would make every
 * non-Latin review look identical to every other one.
 */
export function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * The four things that must all match for two rows to be the same
 * review: product, rating, author, words.
 *
 * Deliberately strict. Two different customers can both write "Nice
 * product" at five stars, and a rule keyed on the text alone would
 * quietly delete one of them. Requiring the author to match costs
 * nothing against the real causes — a re-imported CSV and a
 * double-submitted form both repeat the author — and removes that
 * whole class of mistake.
 */
export function duplicateKey(row) {
  return [
    row.product_handle || row.product_id || "",
    row.rating,
    normalizeText(row.author_name),
    normalizeText(row.content),
  ].join("|");
}

/**
 * Which copy of a duplicate set to keep. Higher wins.
 *
 * Photos outrank everything because deleting them is the only part of
 * this that cannot be undone — the row could be re-imported, the
 * shopper's photo could not.
 */
export function keeperScore(row) {
  let score = 0;
  if (Array.isArray(row.image_urls) && row.image_urls.length) score += 8;
  if (row.status === "approved") score += 4;
  if (row.reply) score += 2;
  if (row.is_featured) score += 1;
  return score;
}

/**
 * Split rows into the ones to keep and the ones to delete.
 *
 * Returns { duplicateIds, preview, scanned }. A group of n always
 * keeps exactly one, so no bug in the ordering can empty a shop.
 */
export function planDuplicateRemoval(rows) {
  const groups = new Map();

  for (const row of rows || []) {
    // A review with no text is not something this rule can judge, and
    // guessing would delete real reviews that are a bare rating.
    if (!normalizeText(row.content)) continue;
    const key = duplicateKey(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const duplicateIds = [];
  const preview = [];

  for (const set of groups.values()) {
    if (set.length < 2) continue;

    const sorted = [...set].sort((a, b) => {
      const byScore = keeperScore(b) - keeperScore(a);
      if (byScore) return byScore;
      // Oldest first: the original, not the accidental re-import.
      return new Date(a.created_at || 0) - new Date(b.created_at || 0);
    });

    const [keep, ...extras] = sorted;
    for (const row of extras) duplicateIds.push(row.id);

    preview.push({
      author: keep.author_name,
      rating: keep.rating,
      product: keep.product_handle || keep.product_id || "store-wide",
      excerpt: String(keep.content || "").slice(0, 120),
      copies: set.length,
      removing: extras.length,
    });
  }

  // Worst offenders first — that is the list worth reading.
  preview.sort((a, b) => b.removing - a.removing);

  return { duplicateIds, preview, scanned: (rows || []).length };
}
