// =============================================================
// Trustoo-compatible CSV parsing
// File: /lib/csv.js
// =============================================================

// Self-contained on purpose: this module is imported by a Remix route,
// so it must not pull in the server-only Supabase client.
function initialsOf(name) {
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

const truthy = (v) =>
  ["1", "true", "yes", "y", "on", "approved"].includes(String(v ?? "").trim().toLowerCase());

export function parseDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    let [, mo, da, ye] = m;
    if (ye.length === 2) ye = "20" + ye;
    const dd = new Date(`${ye}-${mo.padStart(2, "0")}-${da.padStart(2, "0")}`);
    if (!isNaN(dd.getTime())) return dd.toISOString();
  }
  return null;
}

export function parseCSV(text) {
  const out = [];
  let row = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') inQ = false;
      else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") {
        row.push(cur);
        cur = "";
      } else if (c === "\n") {
        row.push(cur);
        out.push(row);
        row = [];
        cur = "";
      } else if (c === "\r") {
        /* skip */
      } else cur += c;
    }
  }
  if (cur || row.length) {
    row.push(cur);
    out.push(row);
  }
  return out;
}

/**
 * Turn CSV text into review rows for one shop.
 * Returns { records, errors, fatal }.
 */
export function csvToReviews(csvText, shopDomain) {
  const rows = parseCSV(csvText);
  if (rows.length < 2) return { records: [], errors: [], fatal: "CSV is empty" };

  const headers = rows[0].map((h) => String(h).replace(/\*/g, "").trim().toLowerCase());
  const idx = (k) => headers.indexOf(k);

  if (idx("rating") < 0) return { records: [], errors: [], fatal: "Missing column: rating" };

  const authorCol = idx("author_name") >= 0 ? "author_name" : "author";
  if (idx(authorCol) < 0) {
    return { records: [], errors: [], fatal: "Missing column: author or author_name" };
  }

  const hasContent = idx("content") >= 0;
  const hasTitle = idx("title") >= 0;

  const records = [];
  const errors = [];

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.every((c) => !c)) continue;

    const get = (k) => (idx(k) >= 0 ? String(r[idx(k)] ?? "").trim() : "");

    const rating = parseInt(get("rating"), 10);
    const author_name = get(authorCol);
    const content = hasContent ? get("content") : "";
    const title = hasTitle ? get("title") : "";
    const product_id = get("product_id");
    const product_handle = get("product_handle");

    if (!author_name) {
      errors.push(`Row ${i + 1}: missing author`);
      continue;
    }
    if (Number.isNaN(rating) || rating < 1 || rating > 5) {
      errors.push(`Row ${i + 1}: rating must be 1-5`);
      continue;
    }
    if (!content && !title) {
      errors.push(`Row ${i + 1}: needs at least content or title`);
      continue;
    }

    let image_urls = [];
    for (let n = 1; n <= 5; n++) {
      const u = get(`photo_url_${n}`);
      if (u) image_urls.push(u);
    }
    if (idx("image_urls") >= 0) {
      image_urls = image_urls.concat(
        get("image_urls").split(",").map((s) => s.trim()).filter(Boolean)
      );
    }

    // Defaults to FALSE, deliberately. A "verified purchase" badge means
    // the review is tied to a real order, and a CSV has no order behind
    // it. Defaulting to true would silently label every imported review
    // as verified — which is exactly the kind of falsified data that
    // fails App Store review, and misleads shoppers besides.
    //
    // A column can still set it, for exports from another review app
    // that genuinely tracked it. app.import.jsx overrides even that,
    // because we cannot check someone else's claim.
    const is_verified =
      idx("verify_purchase") >= 0
        ? truthy(get("verify_purchase"))
        : idx("is_verified") >= 0
        ? truthy(get("is_verified"))
        : false;

    const publishRaw = get("publish");
    const status = publishRaw ? (truthy(publishRaw) ? "approved" : "hidden") : "approved";
    const is_featured = idx("feature") >= 0 ? truthy(get("feature")) : false;

    const author_country = get("author_country");
    const author_location = get("author_location") || author_country || null;
    const commented_at = parseDate(get("commented_at"));
    const reply_at = parseDate(get("reply_at"));

    const record = {
      shop_domain: shopDomain,
      product_id: product_id || null,
      product_handle: product_handle || null,
      author_name: author_name.slice(0, 80),
      author_initials: initialsOf(author_name),
      author_email: get("author_email") || null,
      author_country: author_country || null,
      author_location,
      is_verified,
      rating,
      title: title || null,
      content: (content || title).slice(0, 4000),
      image_urls,
      video_url: get("video_url") || null,
      reply: get("reply") || null,
      reply_at,
      is_featured,
      item_type: get("item_type") || null,
      status,
      source: "csv_import",
    };

    // Handle-only rows: mirror the handle into product_id so either
    // lookup path matches.
    if (!record.product_id && record.product_handle) record.product_id = record.product_handle;
    if (commented_at) record.created_at = commented_at;

    records.push(record);
  }

  return { records, errors, fatal: null };
}
