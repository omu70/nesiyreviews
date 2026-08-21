// =============================================================
// App Proxy — the storefront widget's only backend
// File: /app/routes/apps.proxy.$.jsx
//
// Storefront:  /apps/evo-reviews/<action>
//   → Shopify signs it and forwards to  /apps/proxy/<action>
//
// Why this instead of a public CORS endpoint:
//
//   · Shopify verifies the request and tells us the shop. The browser
//     cannot lie about which store it is, which is what makes tenant
//     isolation real rather than advisory — every query below is
//     scoped by `session.shop`, and `session.shop` comes only from
//     Shopify's signature, never from the request.
//   · Same-origin from the theme's perspective: no CORS, no preflight.
//   · No API key sitting in the merchant's theme source.
//
// authenticate.public.appProxy() throws 400 on a bad signature and
// enforces a 90s timestamp window, so replayed URLs die on their own.
//
// Endpoints
//   GET  /settings                       widget configuration
//   GET  /summary?handles=a,b,c          batched product-card badges
//   GET  /reviews?handle=&page=&limit=   paged reviews + distribution
//   POST /upload-url                     signed direct-to-storage URLs
//   POST /submit                         a shopper submits a review
// =============================================================
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import {
  db,
  PUBLIC_COLS,
  LIMITS,
  ALLOWED_IMAGE_TYPES,
  initialsOf,
  safeHandle,
  safeProductId,
  publicImages,
  isEmail,
  SUPABASE_URL,
} from "../db.server";
import { log, dbError } from "../utils/log.server";

const MAX_SUBMISSIONS_PER_IP_PER_HOUR = 5;
const MAX_UPLOAD_BATCHES_PER_IP_PER_HOUR = 12;

// Reviews change when a merchant moderates, which is minutes-scale,
// not seconds-scale. A short browser cache with a longer shared cache
// keeps a busy collection page off the database entirely.
const CACHE_SHORT = "public, max-age=30, s-maxage=120, stale-while-revalidate=600";
const CACHE_SETTINGS = "public, max-age=60, s-maxage=300, stale-while-revalidate=3600";

const STORAGE_PREFIX = `${SUPABASE_URL}/storage/v1/object/public/review-images/`;

const clientIp = (request) =>
  (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || null;

// -------------------------------------------------------------
// Settings
// -------------------------------------------------------------
const DEFAULT_SETTINGS = {
  auto_approve: false,
  show_badge: true,
  show_grid: true,
  show_card_badges: true,
  allow_photos: true,
  allow_submissions: true,
  accent_color: "#111111",
  star_color: "#FFC107",
  layout: "grid",
  reviews_per_page: 10,
  heading_text: "Customer Reviews",
  empty_text: "No reviews yet. Be the first to share your experience.",
  pagination_style: "load_more",
  show_rating_distribution: true,
  show_review_images: true,
  require_title: false,
  require_email: false,
  max_photos: 5,
  badge_placement: "price",
  badge_show_verified_icon: true,
  badge_count_format: "compact",
  badge_align: "center",
  enable_rich_snippets: true,
  include_store_reviews_on_product: false,
};

const SETTINGS_COLS = Object.keys(DEFAULT_SETTINGS).join(", ");

// Everything the widget is allowed to know. auto_approve and
// include_store_reviews_on_product are server-side decisions and are
// not published to the page.
const PUBLIC_SETTING_KEYS = Object.keys(DEFAULT_SETTINGS).filter(
  (k) => k !== "auto_approve" && k !== "include_store_reviews_on_product"
);

// One shop's settings are read on nearly every storefront request.
// A short in-process memo turns that into roughly one query per
// instance per minute instead of one per page view.
const settingsCache = new Map();
const SETTINGS_TTL_MS = 60_000;

async function settingsFor(shop) {
  const hit = settingsCache.get(shop);
  if (hit && hit.expires > Date.now()) return hit.value;

  const { data, error } = await db
    .from("shop_settings")
    .select(SETTINGS_COLS)
    .eq("shop_domain", shop)
    .maybeSingle();

  if (error) log.warn("proxy.settings_read_failed", { shop, error });

  const value = { ...DEFAULT_SETTINGS, ...(data || {}) };
  settingsCache.set(shop, { value, expires: Date.now() + SETTINGS_TTL_MS });
  return value;
}

function publicSettings(settings) {
  const out = {};
  for (const key of PUBLIC_SETTING_KEYS) out[key] = settings[key];
  return out;
}

// -------------------------------------------------------------
// Shared helpers
// -------------------------------------------------------------

/** The widget never sees a database error, only a sentence. */
const failure = (message, status = 500) => json({ ok: false, error: message }, { status });

function shapeReview(row) {
  // The raw storage columns are replaced by one normalised `images`
  // array, so the widget never has to know which schema version wrote
  // the row.
  const shaped = { ...row, images: publicImages(row) };
  delete shaped.image_urls;
  delete shaped.image_meta;
  return shaped;
}

function emptyDistribution() {
  return { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
}

function distributionFrom(agg) {
  if (!agg) return emptyDistribution();
  return {
    1: agg.count_1 || 0,
    2: agg.count_2 || 0,
    3: agg.count_3 || 0,
    4: agg.count_4 || 0,
    5: agg.count_5 || 0,
  };
}

/**
 * Read a JSON body without letting a storefront hand us 40MB.
 * Content-Length is a hint, so the decoded string is checked too.
 */
async function readJsonBody(request) {
  const declared = parseInt(request.headers.get("content-length") || "0", 10);
  if (declared > LIMITS.MAX_BODY_BYTES) return { tooLarge: true };
  const text = await request.text();
  if (text.length > LIMITS.MAX_BODY_BYTES) return { tooLarge: true };
  try {
    return { body: JSON.parse(text) };
  } catch {
    return { invalid: true };
  }
}

/**
 * Per-instance token bucket for endpoints that have no durable row to
 * count. Not a distributed rate limiter — it bounds abuse per running
 * instance, which is the right amount of machinery for "stop one
 * script minting a thousand signed URLs". Submissions get the durable
 * database-backed check below instead.
 */
const buckets = new Map();

function takeToken(key, limit, windowMs) {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    // Opportunistic cleanup so the map cannot grow without bound.
    if (buckets.size > 5000) {
      for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
    }
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count += 1;
  return true;
}

async function countRecent(shop, ip, source) {
  const since = new Date(Date.now() - 3_600_000).toISOString();
  let q = db
    .from("reviews")
    .select("id", { count: "exact", head: true })
    .eq("shop_domain", shop)
    .eq("submitted_ip", ip)
    .gte("created_at", since);
  if (source) q = q.eq("source", source);
  const { count } = await q;
  return count ?? 0;
}

// -------------------------------------------------------------
// GET — settings / summary / reviews
// -------------------------------------------------------------
export const loader = async ({ request, params }) => {
  const { session } = await authenticate.public.appProxy(request);

  // App uninstalled but the embed is still in the theme. Return an
  // empty, valid payload so the widget renders nothing instead of
  // throwing errors into the merchant's console.
  if (!session) {
    return json(
      { ok: false, installed: false, reviews: [], summaries: {}, settings: publicSettings(DEFAULT_SETTINGS) },
      { status: 200 }
    );
  }

  const shop = session.shop;
  const endpoint = String(params["*"] || "").split("/")[0];
  const url = new URL(request.url);

  // ---------- widget settings ----------
  if (endpoint === "settings") {
    const settings = await settingsFor(shop);
    return json(
      { ok: true, installed: true, settings: publicSettings(settings) },
      { headers: { "Cache-Control": CACHE_SETTINGS } }
    );
  }

  // ---------- batched product-card badges ----------
  if (endpoint === "summary") {
    const handles = Array.from(
      new Set(
        String(url.searchParams.get("handles") || "")
          .split(",")
          .map(safeHandle)
          .filter(Boolean)
      )
    ).slice(0, LIMITS.MAX_HANDLES_PER_SUMMARY);

    if (!handles.length) return json({ ok: true, summaries: {} });

    // Reads the trigger-maintained aggregate cache: one indexed lookup
    // for the whole grid instead of scanning reviews per card.
    const { data, error } = await db
      .from("review_aggregates")
      .select("product_handle, average, rating_count")
      .eq("shop_domain", shop)
      .in("product_handle", handles);

    if (error) {
      dbError("proxy.summary_failed", error, { shop });
      return json({ ok: false, summaries: {} }, { status: 200 });
    }

    const summaries = {};
    for (const h of handles) summaries[h] = { average: 0, count: 0 };
    for (const row of data || []) {
      summaries[row.product_handle] = {
        average: Number(row.average) || 0,
        count: row.rating_count || 0,
      };
    }
    return json({ ok: true, summaries }, { headers: { "Cache-Control": CACHE_SHORT } });
  }

  // ---------- review list ----------
  if (endpoint === "reviews") {
    const settings = await settingsFor(shop);

    const handle = safeHandle(url.searchParams.get("handle"));
    const storeWide = url.searchParams.get("store") === "true";
    if (!handle && !storeWide) {
      return failure("A product is required to load reviews.", 400);
    }

    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
    const requested = parseInt(url.searchParams.get("limit") || "", 10);
    const limit = Math.min(
      LIMITS.MAX_PAGE_SIZE,
      Math.max(1, Number.isNaN(requested) ? settings.reviews_per_page : requested)
    );
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    const ratingFilter = parseInt(url.searchParams.get("rating") || "", 10);
    const photosOnly = url.searchParams.get("photos") === "1";
    const sort = ["newest", "highest", "lowest"].includes(url.searchParams.get("sort"))
      ? url.searchParams.get("sort")
      : "newest";

    let q = db
      .from("reviews")
      .select(PUBLIC_COLS, { count: "exact" })
      .eq("shop_domain", shop)
      .eq("status", "approved")
      .is("product_deleted_at", null);

    if (storeWide) {
      // Store-wide reviews are the ones deliberately not attached to a
      // product.
      q = q.is("product_id", null).is("product_handle", null);
    } else if (settings.include_store_reviews_on_product) {
      q = q.or(
        `product_handle.eq.${handle},product_id.eq.${handle},and(product_id.is.null,product_handle.is.null)`
      );
    } else {
      q = q.or(`product_handle.eq.${handle},product_id.eq.${handle}`);
    }

    if (ratingFilter >= 1 && ratingFilter <= 5) q = q.eq("rating", ratingFilter);
    if (photosOnly) q = q.eq("has_images", true);

    if (sort === "highest") q = q.order("rating", { ascending: false });
    else if (sort === "lowest") q = q.order("rating", { ascending: true });
    else q = q.order("is_featured", { ascending: false });

    // The paging window is applied in Postgres. The old implementation
    // fetched every approved review for the product and sliced in JS,
    // which is fine at 12 reviews and a problem at 12,000.
    const rowsPromise = q.order("created_at", { ascending: false }).range(from, to);

    // The rating shown is the product's own, from the aggregate cache,
    // so it stays consistent with the product-card badge and does not
    // drift with whatever filter the shopper has applied.
    const aggPromise = storeWide
      ? Promise.resolve({ data: null })
      : db
          .from("review_aggregates")
          .select("average, rating_count, count_1, count_2, count_3, count_4, count_5, images_count")
          .eq("shop_domain", shop)
          .eq("product_handle", handle)
          .maybeSingle();

    const [rows, agg] = await Promise.all([rowsPromise, aggPromise]);

    if (rows.error) {
      dbError("proxy.reviews_failed", rows.error, { shop });
      return failure("Could not load reviews right now.");
    }

    const total = rows.count ?? 0;
    let average = 0;
    let totalRatings = 0;
    let distribution = emptyDistribution();
    let imagesCount = 0;

    if (storeWide) {
      // No aggregate row exists for store-wide reviews (they have no
      // handle to key on), so derive the summary from the unfiltered
      // set once, cheaply, using the rating column only.
      const { data: ratingRows } = await db
        .from("reviews")
        .select("rating, has_images")
        .eq("shop_domain", shop)
        .eq("status", "approved")
        .is("product_id", null)
        .is("product_handle", null);
      const list = ratingRows || [];
      totalRatings = list.length;
      average = list.length
        ? Number((list.reduce((s, r) => s + r.rating, 0) / list.length).toFixed(1))
        : 0;
      for (const r of list) {
        distribution[r.rating] = (distribution[r.rating] || 0) + 1;
        if (r.has_images) imagesCount += 1;
      }
    } else if (agg.data) {
      average = Number(agg.data.average) || 0;
      totalRatings = agg.data.rating_count || 0;
      distribution = distributionFrom(agg.data);
      imagesCount = agg.data.images_count || 0;
    }

    return json(
      {
        ok: true,
        installed: true,
        reviews: (rows.data || []).map(shapeReview),
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        hasMore: from + (rows.data || []).length < total,
        average,
        totalRatings,
        distribution,
        imagesCount,
        settings: publicSettings(settings),
      },
      { headers: { "Cache-Control": CACHE_SHORT } }
    );
  }

  return failure("Unknown endpoint", 404);
};

// -------------------------------------------------------------
// POST — upload-url / submit
// -------------------------------------------------------------
export const action = async ({ request, params }) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) {
    return failure("This shop no longer has the app installed.", 404);
  }

  const shop = session.shop;
  const endpoint = String(params["*"] || "").split("/")[0];
  const url = new URL(request.url);

  // Shopify tells us who the logged-in customer is, signed. The
  // signature proves the URL was not tampered with, so this value is
  // trustworthy — unlike anything in the request body.
  const loggedInCustomerId = url.searchParams.get("logged_in_customer_id") || null;

  const parsed = await readJsonBody(request);
  if (parsed.tooLarge) return failure("That request was too large.", 413);
  if (parsed.invalid) return failure("Invalid request.", 400);
  const body = parsed.body || {};

  const settings = await settingsFor(shop);
  const ip = clientIp(request);

  // ---------- signed direct-to-storage upload ----------
  if (endpoint === "upload-url") {
    if (!settings.allow_photos) {
      return failure("Photo uploads are turned off for this store.", 403);
    }

    // Minting signed URLs is cheap for us and expensive for the
    // storage bill if abused, so it gets its own ceiling.
    if (ip && !takeToken(`up:${shop}:${ip}`, MAX_UPLOAD_BATCHES_PER_IP_PER_HOUR, 3_600_000)) {
      return failure("Too many uploads from this connection. Please try again later.", 429);
    }

    const maxPhotos = Math.min(LIMITS.MAX_PHOTOS, settings.max_photos || 5);
    const files = Array.isArray(body.files) ? body.files.slice(0, maxPhotos) : [];
    if (!files.length) return failure("No files to upload.", 400);

    const uploads = [];
    for (const f of files) {
      const type = String(f?.type || "").toLowerCase();
      const size = Number(f?.size) || 0;
      if (!ALLOWED_IMAGE_TYPES.includes(type)) continue;
      if (size > LIMITS.MAX_UPLOAD_BYTES) continue;

      const safeName = String(f?.name || "photo")
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .slice(0, 60);

      // One signed URL per variant: the compressed full-size image the
      // lightbox opens, and the small thumbnail the review card shows.
      // Uploading both means a thumbnail strip costs a few KB instead
      // of several megabytes.
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const paths = {
        full: `${shop}/${stamp}-${safeName}`,
        thumb: `${shop}/${stamp}-thumb-${safeName}`,
      };

      try {
        const [fullSigned, thumbSigned] = await Promise.all([
          db.storage.from("review-images").createSignedUploadUrl(paths.full),
          db.storage.from("review-images").createSignedUploadUrl(paths.thumb),
        ]);
        if (fullSigned.error || thumbSigned.error) {
          log.warn("proxy.signed_url_failed", {
            shop,
            error: fullSigned.error || thumbSigned.error,
          });
          continue;
        }
        uploads.push({
          signedUrl: fullSigned.data.signedUrl,
          publicUrl: db.storage.from("review-images").getPublicUrl(paths.full).data?.publicUrl || null,
          thumbSignedUrl: thumbSigned.data.signedUrl,
          thumbPublicUrl:
            db.storage.from("review-images").getPublicUrl(paths.thumb).data?.publicUrl || null,
        });
      } catch (error) {
        log.warn("proxy.signed_url_threw", { shop, error });
      }
    }

    if (!uploads.length) {
      return failure("Those files could not be accepted. Use JPG, PNG, WebP or GIF under 8MB.", 400);
    }
    return json({ ok: true, uploads });
  }

  // ---------- a shopper submits a review ----------
  if (endpoint === "submit") {
    if (!settings.allow_submissions) {
      return failure("This store is not accepting new reviews right now.", 403);
    }

    const authorName = String(body.author_name || "").trim();
    const content = String(body.content || "").trim();
    const title = String(body.title || "").trim();
    const email = String(body.author_email || "").trim();
    const location = String(body.author_location || "").trim();
    const ratingInt = parseInt(body.rating, 10);

    // Server-side validation, deliberately mirroring the client's but
    // never trusting it. Each message names the one field to fix.
    if (!authorName) return failure("Please add your name.", 400);
    if (authorName.length > LIMITS.MAX_NAME) return failure("That name is too long.", 400);
    if (Number.isNaN(ratingInt) || ratingInt < 1 || ratingInt > 5) {
      return failure("Please choose a rating between 1 and 5 stars.", 400);
    }
    if (!content) return failure("Please write your review.", 400);
    if (content.length > LIMITS.MAX_CONTENT) {
      return failure(`Please keep your review under ${LIMITS.MAX_CONTENT} characters.`, 400);
    }
    if (settings.require_title && !title) return failure("Please add a headline.", 400);
    if (title.length > LIMITS.MAX_TITLE) return failure("That headline is too long.", 400);
    if (settings.require_email && !email) return failure("Please add your email address.", 400);
    if (email && !isEmail(email)) return failure("That email address does not look right.", 400);
    if (email.length > LIMITS.MAX_EMAIL) return failure("That email address is too long.", 400);

    if (ip && (await countRecent(shop, ip, "app_proxy")) >= MAX_SUBMISSIONS_PER_IP_PER_HOUR) {
      return failure(
        "You have submitted several reviews recently. Please try again later.",
        429
      );
    }

    // Only accept image URLs that came out of our own signed-upload
    // endpoint. Anything else is an arbitrary URL from the page, and
    // a review body is not a place to let strangers embed images.
    const ours = (u) => typeof u === "string" && u.startsWith(STORAGE_PREFIX) && u.length < 500;
    const maxPhotos = Math.min(LIMITS.MAX_PHOTOS, settings.max_photos || 5);

    const rawImages = Array.isArray(body.images) ? body.images : [];
    const imageMeta = rawImages
      .filter((img) => img && ours(img.url))
      .slice(0, maxPhotos)
      .map((img) => ({
        url: img.url,
        thumb: ours(img.thumb) ? img.thumb : img.url,
        w: Number.isFinite(Number(img.w)) ? Math.min(10000, Math.round(Number(img.w))) : null,
        h: Number.isFinite(Number(img.h)) ? Math.min(10000, Math.round(Number(img.h))) : null,
      }));

    // Older widget builds posted a flat image_urls array. Accept it so
    // a cached theme asset does not silently drop a shopper's photos.
    if (!imageMeta.length && Array.isArray(body.image_urls)) {
      for (const u of body.image_urls.filter(ours).slice(0, maxPhotos)) {
        imageMeta.push({ url: u, thumb: u, w: null, h: null });
      }
    }

    const cleanHandle = safeHandle(body.handle);
    const productId = safeProductId(body.product_id);
    const now = new Date().toISOString();

    const { error } = await db.from("reviews").insert({
      shop_domain: shop,
      product_id: cleanHandle,
      product_handle: cleanHandle,
      shopify_product_id: productId,
      shopify_product_gid: productId ? `gid://shopify/Product/${productId}` : null,
      author_name: authorName.slice(0, LIMITS.MAX_NAME),
      author_initials: initialsOf(authorName),
      author_email: email ? email.slice(0, LIMITS.MAX_EMAIL) : null,
      author_location: location ? location.slice(0, LIMITS.MAX_NAME) : null,
      rating: ratingInt,
      title: title ? title.slice(0, LIMITS.MAX_TITLE) : null,
      content: content.slice(0, LIMITS.MAX_CONTENT),
      image_urls: imageMeta.map((i) => i.url),
      image_meta: imageMeta,
      status: settings.auto_approve ? "approved" : "pending",
      source: "app_proxy",
      submitted_ip: ip,
      submitted_at: now,
      shopify_customer_id: loggedInCustomerId,
      // "Verified" is reserved for reviews tied to a real order. A
      // logged-in shopper is not by itself proof of purchase, and
      // labelling one as verified would be falsified data.
      is_verified: false,
      app_verification_status: "not_verified",
    });

    if (error) {
      dbError("proxy.submit_failed", error, { shop });
      return failure("Could not save your review. Please try again.");
    }

    log.info("review.submitted", {
      shop,
      auto_approved: Boolean(settings.auto_approve),
      photos: imageMeta.length,
      rating: ratingInt,
    });

    return json(
      {
        ok: true,
        pending: !settings.auto_approve,
        message: settings.auto_approve
          ? "Thanks! Your review is now live."
          : "Thanks! Your review has been sent to the store for approval.",
      },
      { status: 201 }
    );
  }

  return failure("Unknown endpoint", 404);
};
