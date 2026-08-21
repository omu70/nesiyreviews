// =============================================================
// Supabase service-role client
// File: /app/db.server.js
//
// Server-only. The service role key bypasses RLS, so this module
// must never be imported from anything that ships to the browser
// (the `.server.js` suffix is what guarantees that in Remix).
// =============================================================
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  throw new Error(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. " +
      "Set both in your host's environment variables before starting the app."
  );
}

export const db = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { headers: { "x-client-info": "evo-product-reviews" } },
});

export const SUPABASE_URL = url;

/**
 * Columns the storefront is allowed to see.
 *
 * author_email is deliberately absent. A reviewer's email address is
 * protected customer data and has no business leaving the admin — one
 * stray column in this list would publish every reviewer's email in a
 * response any shopper can read.
 */
export const PUBLIC_COLS =
  "id, title, author_name, author_initials, author_location, author_country, " +
  "is_verified, is_featured, rating, content, image_urls, image_meta, video_url, " +
  "reply, reply_at, created_at";

/** Columns the merchant sees in the admin. */
export const ADMIN_COLS =
  "id, product_id, product_handle, shopify_product_id, product_deleted_at, title, " +
  "author_name, author_location, author_email, rating, content, status, is_featured, " +
  "is_verified, image_urls, image_meta, reply, reply_at, source, created_at";

export function initialsOf(name) {
  return (
    String(name || "")
      .trim()
      .split(/\s+/)
      .map((p) => p[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "AN"
  );
}

/**
 * PostgREST `or=` filters are comma/paren delimited, so any value that
 * reaches one has to be scrubbed or it can break out of the filter.
 */
export function safeHandle(v) {
  if (v == null) return null;
  const s = String(v).trim().slice(0, 120).replace(/[^a-zA-Z0-9._\-/]/g, "");
  return s || null;
}

export function normalizeShop(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
}

/** Numeric id out of a gid://shopify/Product/123 */
export function idFromGid(gid) {
  const m = String(gid || "").match(/\/(\d+)$/);
  return m ? m[1] : null;
}

/**
 * A Shopify numeric product id, or null.
 *
 * The storefront sends this in a request body, so it is untrusted
 * input — but it is also only ever compared against rows already
 * scoped to the signed shop, so the worst a forged value can do is
 * attach a review to the wrong product in the merchant's own store.
 * Constraining it to digits keeps it out of any query fragment.
 */
export function safeProductId(v) {
  if (v == null) return null;
  const s = String(v).trim();
  const m = s.match(/(\d{5,20})\s*$/); // accepts 123 and gid://shopify/Product/123
  return m ? m[1] : null;
}

/** Hard ceilings the storefront cannot raise by asking nicely. */
export const LIMITS = {
  MAX_PHOTOS: 10,
  MAX_UPLOAD_BYTES: 8 * 1024 * 1024,
  MAX_BODY_BYTES: 64 * 1024,
  MAX_CONTENT: 4000,
  MAX_TITLE: 120,
  MAX_NAME: 80,
  MAX_EMAIL: 160,
  MAX_PAGE_SIZE: 100,
  MAX_HANDLES_PER_SUMMARY: 60,
};

export const ALLOWED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
];

/**
 * Normalise a review row's photos into one shape for the storefront.
 *
 * Rows written before migration 008 only have image_urls (full-size
 * only). Rows written since also have image_meta with a thumbnail and
 * intrinsic dimensions. The widget should not have to know which is
 * which, so collapse both into { url, thumb, w, h }.
 */
export function publicImages(row) {
  const meta = Array.isArray(row?.image_meta) ? row.image_meta : [];
  if (meta.length) {
    return meta
      .filter((m) => m && typeof m.url === "string")
      .map((m) => ({
        url: m.url,
        thumb: typeof m.thumb === "string" ? m.thumb : m.url,
        w: Number(m.w) || null,
        h: Number(m.h) || null,
      }));
  }
  const urls = Array.isArray(row?.image_urls) ? row.image_urls : [];
  return urls
    .filter((u) => typeof u === "string" && u)
    .map((u) => ({ url: u, thumb: u, w: null, h: null }));
}

/** Basic shape check. Real deliverability is not our problem here. */
export function isEmail(v) {
  return typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim());
}
