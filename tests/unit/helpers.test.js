// =============================================================
// Server helper tests
// File: /tests/unit/helpers.test.js
//
//   node --test tests/unit/*.test.js
//
// These cover the functions that stand between untrusted storefront
// input and a database query, plus the compatibility shim that lets
// review rows written before and after migration 008 render the same.
// =============================================================
import { test } from "node:test";
import assert from "node:assert/strict";

// db.server.js validates its environment at import time.
process.env.SUPABASE_URL ||= "https://project.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";

const { safeHandle, safeProductId, publicImages, isEmail, initialsOf, idFromGid, normalizeShop } =
  await import("../../app/db.server.js");

test("safeHandle strips anything that could break out of a PostgREST filter", () => {
  assert.equal(safeHandle("woodfire-pillar"), "woodfire-pillar");
  assert.equal(safeHandle("  spaced-handle  "), "spaced-handle");

  // A comma or a paren would end the current filter term and start a
  // new one — this is the injection this function exists to stop.
  assert.equal(safeHandle("a,b"), "ab");
  assert.equal(safeHandle("x.eq.1,or(status.eq.approved)"), "x.eq.1orstatus.eq.approved");
  assert.equal(safeHandle("drop*table"), "droptable");
  assert.equal(safeHandle("%25"), "25");

  assert.equal(safeHandle(""), null);
  assert.equal(safeHandle(null), null);
  assert.equal(safeHandle(undefined), null);
  assert.equal(safeHandle(",,,"), null);
  assert.equal(safeHandle("a".repeat(400)).length, 120);
});

test("safeProductId accepts only a Shopify numeric id", () => {
  assert.equal(safeProductId("9876543210"), "9876543210");
  assert.equal(safeProductId(9876543210), "9876543210");
  assert.equal(safeProductId("gid://shopify/Product/9876543210"), "9876543210");

  assert.equal(safeProductId("12"), null); // too short to be real
  assert.equal(safeProductId("not-an-id"), null);
  assert.equal(safeProductId(""), null);
  assert.equal(safeProductId(null), null);
  assert.equal(safeProductId("123456; drop"), null);
});

test("publicImages normalises both schema generations", () => {
  // Rows written after migration 008 carry a thumbnail and dimensions.
  assert.deepEqual(
    publicImages({
      image_meta: [{ url: "https://x/full.jpg", thumb: "https://x/thumb.jpg", w: 1600, h: 1200 }],
      image_urls: ["https://x/full.jpg"],
    }),
    [{ url: "https://x/full.jpg", thumb: "https://x/thumb.jpg", w: 1600, h: 1200 }]
  );

  // Rows written before it only have the flat URL list; the full-size
  // image doubles as its own thumbnail.
  assert.deepEqual(publicImages({ image_urls: ["https://x/old.jpg"], image_meta: [] }), [
    { url: "https://x/old.jpg", thumb: "https://x/old.jpg", w: null, h: null },
  ]);

  assert.deepEqual(publicImages({}), []);
  assert.deepEqual(publicImages(null), []);

  // Junk in a jsonb column must not reach the storefront.
  assert.deepEqual(publicImages({ image_meta: [null, { thumb: "no-url" }, 7] }), []);
});

test("isEmail is a shape check, not a delivery guarantee", () => {
  assert.ok(isEmail("shopper@example.com"));
  assert.ok(isEmail("first.last+tag@sub.example.co.uk"));

  assert.ok(!isEmail("shopper@example"));
  assert.ok(!isEmail("shopper.example.com"));
  assert.ok(!isEmail("two @spaces.com"));
  assert.ok(!isEmail(""));
  assert.ok(!isEmail(null));
});

test("initialsOf never produces an empty avatar", () => {
  assert.equal(initialsOf("Aman Sharma"), "AS");
  assert.equal(initialsOf("cher"), "C");
  assert.equal(initialsOf("  多  空白  "), "多空");
  assert.equal(initialsOf(""), "AN");
  assert.equal(initialsOf(null), "AN");
});

test("idFromGid pulls the numeric id out of a global id", () => {
  assert.equal(idFromGid("gid://shopify/Product/123456789"), "123456789");
  assert.equal(idFromGid("gid://shopify/Order/42"), "42");
  assert.equal(idFromGid("nonsense"), null);
  assert.equal(idFromGid(null), null);
});

test("normalizeShop reduces any form of a shop reference to its domain", () => {
  assert.equal(normalizeShop("https://Demo-Store.myshopify.com/admin"), "demo-store.myshopify.com");
  assert.equal(normalizeShop("  demo.myshopify.com  "), "demo.myshopify.com");
  assert.equal(normalizeShop(""), "");
});
