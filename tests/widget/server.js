// =============================================================
// Mock storefront for the widget harness
// File: /tests/widget/server.js
//
// Serves two things:
//
//   1. A page shaped like a Shopify product page and a collection
//      grid — a theme the widget has never seen, with class names it
//      cannot have been written against. That is the point: the card
//      detection has to work structurally, not by selector.
//
//   2. The app proxy endpoints, returning the same JSON shape
//      apps.proxy.$.jsx returns, from fixtures rather than a database.
//
// This is not a substitute for a dev-store pass. It proves the parts
// that live entirely in the browser — formatting, paging, the
// lightbox, image failure, form validation — without needing Shopify,
// Supabase, or a network.
// =============================================================
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.resolve(HERE, "../../extensions/reviews-widget/assets");

const TOTAL_REVIEWS = 1324;
const AVERAGE = 4.7;

// A 1x1 transparent PNG, so photos "load" without any network.
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

function makeReview(i, opts = {}) {
  const photos = opts.photos ?? (i % 3 === 0 ? 3 : 0);
  const images = [];
  for (let p = 0; p < photos; p++) {
    // Review 3's second photo points at a URL the server 404s, to
    // exercise the broken-image fallback. (Review 3 is the first one
    // the fixture gives photos to.)
    const broken = i === 3 && p === 1;
    images.push({
      url: broken ? "/img/missing.png" : `/img/photo-${i}-${p}.png`,
      thumb: broken ? "/img/missing.png" : `/img/thumb-${i}-${p}.png`,
      w: 1600,
      h: 1200,
    });
  }
  return {
    id: `review-${i}`,
    title: i % 2 ? `Headline number ${i}` : null,
    author_name: `Customer ${i}`,
    author_initials: "C" + (i % 10),
    author_location: i % 4 === 0 ? "Mumbai" : null,
    is_verified: i % 5 === 0,
    is_featured: false,
    rating: 5 - (i % 5),
    content: `This is review number ${i}. It has enough text to wrap onto more than one line in a card.`,
    images,
    reply: i === 1 ? "Thanks for the kind words!" : null,
    reply_at: i === 1 ? "2026-08-01T10:00:00.000Z" : null,
    created_at: new Date(Date.UTC(2026, 6, Math.max(1, 28 - (i % 27)))).toISOString(),
  };
}

const SETTINGS = {
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
  badge_show_verified_icon: true,
  badge_count_format: "compact",
  badge_align: "inherit",
  enable_rich_snippets: true,
};

const DISTRIBUTION = { 1: 8, 2: 12, 3: 35, 4: 120, 5: 1149 };

// Counts chosen to pin every branch of the compact formatter.
const SUMMARY_FIXTURES = {
  "test-product": { average: AVERAGE, count: TOTAL_REVIEWS },
  "card-a": { average: 4.7, count: 1300 },
  "card-b": { average: 5, count: 12 },
  "card-c": { average: 4.85, count: 12400 },
  "card-d": { average: 3.04, count: 1 },
  "card-e": { average: 4.2, count: 1200000 },
  "card-f": { average: 0, count: 0 },
};

const PRODUCT_PAGE = (overrides = {}) => `
<div class="pdp">
  <div class="pdp__media"><img src="/img/hero.png" alt="" width="80" height="80"></div>
  <div class="pdp__info">
    <h1 class="product__title">A Test Product</h1>
    <div class="price">$49.00</div>
    <div class="product__description"><p>Product copy goes here.</p></div>
  </div>
</div>

<!-- A collection grid using class names this widget has never seen. -->
<ul class="tiles" id="grid">
  ${Object.keys(SUMMARY_FIXTURES)
    .filter((h) => h !== "test-product")
    .map(
      (handle) => `
  <li class="tile">
    <a class="tile__link" href="/products/${handle}"><img src="/img/${handle}.png" alt="" width="60" height="60"></a>
    <div class="tile__body">
      <a class="tile__name" href="/products/${handle}">Product ${handle}</a>
      <span class="tile__price">$10.00</span>
    </div>
  </li>`
    )
    .join("")}
</ul>

<!--
  A card shaped like a real jewellery theme: the image is a product link
  of its own, the price sits ABOVE the title, and the title is a second
  product link. Walking up from the two links lands on different
  ancestors, which is how a card ends up with two badges.
-->
<ul class="tiles" id="awkward-grid">
  <li class="acard">
    <div class="acard__media"><a href="/products/card-a"><img src="/img/card-a.png" alt="" width="60" height="60"></a></div>
    <div class="acard__body">
      <span class="price acard__price">Rs. 749.00 <s>Rs. 1,498.00</s></span>
      <h3 class="acard__ttl"><a href="/products/card-a">Rose Gold Pendant with AAA+ Stones</a></h3>
      <button class="acard__atc">Add to cart</button>
    </div>
  </li>
</ul>

<script>
  window.__EVO_REVIEWS__ = {
    proxyBase: "/apps/evo-reviews",
    productId: "9876543210",
    productHandle: "test-product",
    productTitle: "A Test Product",
    productUrl: "https://shop.test/products/test-product",
    productImage: null,
    productSku: "SKU-1",
    template: "product",
    badgeTarget: "",
    gridTarget: "",
    settings: {}
  };
  ${overrides.script || ""}
  window.__EVO_REVIEWS__.settingsReady = fetch("/apps/evo-reviews/settings")
    .then(function (r) { return r.json(); })
    .then(function (d) { return d.settings; })
    .catch(function () { return null; });
</script>
<link rel="stylesheet" href="/assets/reviews.css">
<script src="/assets/reviews.js" defer></script>
`;

/**
 * A homepage carrying the Store reviews block, emitted exactly as
 * store-reviews.liquid does. No product context at all — this is the
 * page where the block used to render an empty shell.
 */
const STORE_PAGE = (overrides = {}) => `
<h1>Welcome</h1>

<div
  class="evo-rw"
  data-evo-reviews-block
  data-evo-mode="store"
  data-evo-scope="${overrides.storeScope || "all"}"
  data-evo-limit="12"
  style="--evo-rw-max: 1200px;"
>
  <div class="evo-rw__reserve" aria-hidden="true"></div>
</div>

<script>
  window.__EVO_REVIEWS__ = {
    proxyBase: "/apps/evo-reviews",
    rootUrl: "/",
    productId: null,
    productHandle: null,
    productTitle: null,
    productUrl: null,
    productImage: null,
    productSku: null,
    template: "index",
    badgeTarget: "",
    gridTarget: "",
    settings: {}
  };
  ${overrides.script || ""}
  window.__EVO_REVIEWS__.settingsReady = fetch("/apps/evo-reviews/settings")
    .then(function (r) { return r.json(); })
    .then(function (d) { return d.settings; })
    .catch(function () { return null; });
</script>
<link rel="stylesheet" href="/assets/reviews.css">
<script src="/assets/reviews.js" defer></script>
`;

function html(body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mock storefront</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 24px; }
  .pdp { display: flex; gap: 24px; }
  .tiles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; list-style: none; padding: 0; }
  @media (max-width: 640px) { .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  .tile { border: 1px solid #eee; padding: 8px; }
</style>
</head><body>${body}</body></html>`;
}

export function createServer(state = {}) {
  const calls = { summary: 0, reviews: 0, settings: 0, submit: 0, uploadUrl: 0 };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const send = (status, body, type = "application/json") => {
      res.writeHead(status, { "Content-Type": type });
      res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };

    // ---- page ----
    if (url.pathname === "/" || url.pathname === "/product") {
      return send(200, html(PRODUCT_PAGE(state)), "text/html; charset=utf-8");
    }

    if (url.pathname === "/store-reviews") {
      return send(200, html(STORE_PAGE(state)), "text/html; charset=utf-8");
    }

    // ---- extension assets, straight off disk ----
    if (url.pathname.startsWith("/assets/")) {
      const name = path.basename(url.pathname);
      const file = path.join(ASSETS, name);
      if (!fs.existsSync(file)) return send(404, "not found", "text/plain");
      return send(200, fs.readFileSync(file), name.endsWith(".css") ? "text/css" : "text/javascript");
    }

    // ---- images ----
    if (url.pathname.startsWith("/img/")) {
      if (url.pathname.endsWith("missing.png")) return send(404, "gone", "text/plain");
      return send(200, PIXEL, "image/png");
    }

    // ---- app proxy ----
    if (url.pathname === "/apps/evo-reviews/settings") {
      calls.settings += 1;
      return send(200, { ok: true, installed: true, settings: { ...SETTINGS, ...(state.settings || {}) } });
    }

    if (url.pathname === "/apps/evo-reviews/summary") {
      calls.summary += 1;
      const handles = String(url.searchParams.get("handles") || "").split(",").filter(Boolean);
      const summaries = {};
      for (const h of handles) summaries[h] = SUMMARY_FIXTURES[h] || { average: 0, count: 0 };
      return send(200, { ok: true, summaries });
    }

    if (url.pathname === "/apps/evo-reviews/reviews") {
      calls.reviews += 1;
      if (state.failReviews) return send(500, { ok: false, error: "Could not load reviews right now." });

      const settings = { ...SETTINGS, ...(state.settings || {}) };
      const page = parseInt(url.searchParams.get("page") || "1", 10);
      const limit = parseInt(url.searchParams.get("limit") || String(settings.reviews_per_page), 10);
      const ratingFilter = parseInt(url.searchParams.get("rating") || "", 10);
      const photosOnly = url.searchParams.get("photos") === "1";

      // Remembered so a check can assert what the store block asked
      // for, not just what it rendered.
      state.lastReviewsQuery = {
        store: url.searchParams.get("store") || "",
        scope: url.searchParams.get("scope") || "",
        handle: url.searchParams.get("handle") || "",
      };

      const storeWide = url.searchParams.get("store") === "true";

      let all = Array.from({ length: TOTAL_REVIEWS }, (_, i) => makeReview(i + 1));
      // Store-wide rows carry the product they belong to; product-page
      // rows do not, exactly as the proxy returns them.
      if (storeWide) {
        all = all.map((r, i) => ({
          ...r,
          product_handle: i % 2 === 0 ? "card-a" : "card-b",
        }));
      }
      if (ratingFilter >= 1 && ratingFilter <= 5) all = all.filter((r) => r.rating === ratingFilter);
      if (photosOnly) all = all.filter((r) => r.images.length > 0);

      const from = (page - 1) * limit;
      const slice = all.slice(from, from + limit);

      return send(200, {
        ok: true,
        installed: true,
        reviews: slice,
        page,
        limit,
        total: all.length,
        totalPages: Math.max(1, Math.ceil(all.length / limit)),
        hasMore: from + slice.length < all.length,
        average: AVERAGE,
        totalRatings: TOTAL_REVIEWS,
        distribution: DISTRIBUTION,
        imagesCount: 438,
        // The photo strip is drawn from the whole set, not the page —
        // twelve tiles is what the real endpoint caps a first band at.
        photos: state.noPhotoStrip
          ? []
          : Array.from({ length: 12 }, (_, i) => ({
              url: `/img/strip-${i}.png`,
              thumb: `/img/strip-thumb-${i}.png`,
              w: 1600,
              h: 1200,
              review_id: `review-${i + 1}`,
              author_name: `Customer ${i + 1}`,
            })),
        settings,
      });
    }

    if (url.pathname === "/apps/evo-reviews/upload-url") {
      calls.uploadUrl += 1;
      return send(200, {
        ok: true,
        uploads: [
          {
            signedUrl: "/upload/full",
            publicUrl: "/img/uploaded.png",
            thumbSignedUrl: "/upload/thumb",
            thumbPublicUrl: "/img/uploaded-thumb.png",
          },
        ],
      });
    }

    if (url.pathname.startsWith("/upload/")) return send(200, { ok: true });

    if (url.pathname === "/apps/evo-reviews/submit") {
      calls.submit += 1;
      let body = "";
      for await (const chunk of req) body += chunk;
      let parsed = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        /* leave empty */
      }
      state.lastSubmission = parsed;

      if (state.rejectSubmit) {
        return send(400, { ok: false, error: "Please choose a rating between 1 and 5 stars." });
      }
      return send(201, {
        ok: true,
        pending: true,
        message: "Thanks! Your review has been sent to the store for approval.",
      });
    }

    return send(404, { ok: false, error: "not found" });
  });

  return { server, calls, state };
}

export function listen(bundle) {
  return new Promise((resolve) => {
    bundle.server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${bundle.server.address().port}`);
    });
  });
}
