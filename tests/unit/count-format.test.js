// =============================================================
// Review-count formatting agreement
// File: /tests/unit/count-format.test.js
//
// The compact review count is produced in two completely different
// places, and they must never disagree:
//
//   · JavaScript, in reviews.js — every badge the widget paints
//   · Liquid, in product-badge.liquid — the server-rendered badge
//     that paints before JavaScript runs
//
// If they drift, a shopper sees "1.3K Reviews" flicker to "1300
// Reviews" (or the reverse) on every page load. So this test runs the
// real JS implementation, lifted out of the widget source, against a
// faithful port of the Liquid arithmetic, and asserts both against the
// same expectations.
// =============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WIDGET = path.resolve(HERE, "../../extensions/reviews-widget/assets/reviews.js");

/**
 * Lift `compact()` straight out of the shipped widget, so this test
 * cannot pass against a stale copy of the algorithm.
 */
function loadCompactFromWidget() {
  const source = fs.readFileSync(WIDGET, "utf8");
  const start = source.indexOf("function compact(n) {");
  assert.notEqual(start, -1, "compact() not found in reviews.js — did it get renamed?");
  const end = source.indexOf("\n  }", start) + 4;
  const body = source.slice(start, end);
  return new Function(`${body}; return compact;`)();
}

/**
 * A faithful port of the Liquid in product-badge.liquid.
 *
 * Liquid's `divided_by` is integer division when both operands are
 * integers, and that is exactly what the template relies on to get one
 * decimal place without a rounding filter. Modelling it with Math.floor
 * here is what makes this a real check of the template rather than a
 * restatement of the JS.
 */
function liquidCount(rc) {
  const div = (a, b) => Math.floor(a / b);
  const mod = (a, b) => a % b;

  if (rc < 1000) return String(rc);

  const band = (unit, suffix) => {
    const tenths = div(rc + unit / 20, unit / 10);
    const whole = div(tenths, 10);
    const frac = mod(tenths, 10);
    if (frac === 0 || whole >= 100) return `${div(rc + unit / 2, unit)}${suffix}`;
    return `${whole}.${frac}${suffix}`;
  };

  if (rc < 999950) return band(1000, "K");
  if (rc < 999950000) return band(1000000, "M");
  return band(1000000000, "B");
}

// The table in the spec, plus the boundaries either implementation
// could get wrong.
const CASES = [
  [0, "0"],
  [1, "1"],
  [12, "12"],
  [128, "128"],
  [999, "999"],
  [1000, "1K"],
  [1300, "1.3K"],
  [1324, "1.3K"],
  [9999, "10K"],
  [12400, "12.4K"],
  [12450, "12.5K"],
  [99900, "99.9K"],
  [100000, "100K"],
  [850000, "850K"],
  [1200000, "1.2M"],
  [1250000, "1.3M"],
];

test("the JavaScript formatter matches the specification", () => {
  const compact = loadCompactFromWidget();
  for (const [input, expected] of CASES) {
    assert.equal(compact(input), expected, `compact(${input})`);
  }
});

test("the Liquid formatter matches the specification", () => {
  for (const [input, expected] of CASES) {
    assert.equal(liquidCount(input), expected, `liquidCount(${input})`);
  }
});

test("the two formatters never disagree", () => {
  const compact = loadCompactFromWidget();
  const disagreements = [];

  // Every value up to 2000, then a spread across the larger ranges.
  const samples = [];
  for (let n = 0; n <= 2000; n++) samples.push(n);
  for (let n = 2000; n < 1000000; n += 337) samples.push(n);
  for (let n = 1000000; n < 50000000; n += 65537) samples.push(n);

  for (const n of samples) {
    const js = compact(n);
    const liquid = liquidCount(n);
    if (js !== liquid) disagreements.push(`${n}: js=${js} liquid=${liquid}`);
  }

  assert.deepEqual(
    disagreements.slice(0, 10),
    [],
    `${disagreements.length} of ${samples.length} values disagree`
  );
});

test("the formatter is defensive about its input", () => {
  const compact = loadCompactFromWidget();
  assert.equal(compact(null), "0");
  assert.equal(compact(undefined), "0");
  assert.equal(compact(-5), "0");
  assert.equal(compact("1300"), "1.3K");
  assert.equal(compact(1300.6), "1.3K");
});
