/* =============================================================
   Reviews — theme app extension storefront script
   File: /extensions/reviews-widget/assets/reviews.js

   Served from Shopify's CDN, configured by app-embed.liquid, and
   talking only to the signed App Proxy on the merchant's own domain.
   No cross-origin request, no API key in the theme source.

   Design constraints this file is written to:

     · It runs on someone else's storefront. Every selector is
       defensive, every failure is silent, and nothing it does can
       break the merchant's theme.
     · It is on the critical path of a product page. Images are lazy,
       requests are batched, and space is reserved before paint so the
       page does not jump.
     · Shoppers use it on phones. The lightbox swipes, the form is
       reachable by keyboard, and every control has a label.
   ============================================================= */
(function () {
  "use strict";

  // The embed loads this in <head>; the app blocks may load it again.
  // Running twice would double every listener.
  if (window.__EVO_REVIEWS_LOADED__) return;
  window.__EVO_REVIEWS_LOADED__ = true;

  var cfg = window.__EVO_REVIEWS__ || {};

  // Same-origin path on the merchant's storefront. Shopify signs the
  // request and forwards it to the app.
  var BASE = String(cfg.proxyBase || "/apps/evo-reviews").replace(/\/$/, "");

  // Shopify's routes.root_url — "/" on a single-market shop, "/en-in/"
  // and friends once markets or a locale prefix are in play. Building
  // a product link without it drops shoppers out of their locale.
  var ROOT = String(cfg.rootUrl || "/").replace(/\/?$/, "/");

  function rootUrl() {
    return ROOT;
  }

  var settings = {};
  var opts = {};

  var isProductPage = false;
  var productHandle = null;
  var productId = null;
  var badgeTarget = "";
  var gridTarget = "";

  function flag(name, dflt) {
    if (settings[name] === undefined || settings[name] === null) return dflt;
    return Boolean(settings[name]);
  }
  function num(name, dflt) {
    var n = parseInt(settings[name], 10);
    return isNaN(n) ? dflt : n;
  }
  function str(name, dflt) {
    return settings[name] == null || settings[name] === "" ? dflt : String(settings[name]);
  }

  var TITLE_TARGETS =
    ".product__title, .product-single__title, [data-product-title], h1.product-title, h1";

  // Ordered most specific first: `.price` alone is common enough to
  // appear inside a related-products card, so anything that names the
  // product context gets a chance to match before it does.
  var PRICE_TARGETS = [
    ".product__info-container .price",
    ".product-single__price",
    "[data-product-price]",
    ".product__price",
    ".price__container",
    ".price--large",
    ".product-price",
    ".price",
  ].join(", ");

  /**
   * Read the merchant's configuration into `opts`.
   *
   * Called once at boot, after the settings request resolves (or
   * immediately, with defaults, if it does not). Everything the widget
   * renders reads from here, so a missing settings response degrades
   * to sensible defaults rather than to a broken page.
   */
  function configure() {
    settings = cfg.settings || {};

    opts = {
      showBadge: flag("show_badge", true),
      showGrid: flag("show_grid", true),
      showCardBadges: flag("show_card_badges", true),
      showImages: flag("show_review_images", true),
      showDistribution: flag("show_rating_distribution", true),
      allowPhotos: flag("allow_photos", true),
      allowSubmissions: flag("allow_submissions", true),
      requireTitle: flag("require_title", false),
      requireEmail: flag("require_email", false),
      verifiedIcon: flag("badge_show_verified_icon", true),
      richSnippets: flag("enable_rich_snippets", true),
      perPage: Math.max(1, Math.min(100, num("reviews_per_page", 10))),
      maxPhotos: Math.max(1, Math.min(10, num("max_photos", 5))),
      pagination: str("pagination_style", "load_more"),
      countFormat: str("badge_count_format", "compact"),
      badgeAlign: str("badge_align", "center"),
      badgePlacement: str("badge_placement", "price"),
      cardBadgePosition: str("card_badge_position", "above_price"),
      heading: str("heading_text", "Customer Reviews"),
      emptyText: str("empty_text", "No reviews yet. Be the first to share your experience."),
    };

    isProductPage = Boolean(cfg.productHandle);
    productHandle = cfg.productHandle || null;
    productId = cfg.productId || null;

    // Where the automatically placed rating goes. A selector typed into
    // the app embed always wins — a merchant who went to that trouble
    // knows their theme better than a default list does.
    badgeTarget =
      cfg.badgeTarget ||
      (opts.badgePlacement === "price" ? PRICE_TARGETS : TITLE_TARGETS);
    gridTarget =
      cfg.gridTarget ||
      ".product__description, .product-single__description, [data-product-description], main";

    // Merchant-configured colours arrive as CSS custom properties, so
    // the stylesheet itself stays static and CDN-cacheable.
    try {
      var root = document.documentElement;
      if (settings.star_color) root.style.setProperty("--evo-star", settings.star_color);
      if (settings.accent_color) root.style.setProperty("--evo-accent", settings.accent_color);
      if (opts.badgeAlign !== "inherit") {
        root.style.setProperty(
          "--evo-card-badge-justify",
          opts.badgeAlign === "center" ? "center" : "flex-start"
        );
      }
    } catch (e) {
      /* a locked-down CSP can refuse inline style writes; defaults apply */
    }
  }

  // ===========================================================
  // Formatting
  // ===========================================================

  /**
   * 12 → "12", 128 → "128", 1300 → "1.3K", 12400 → "12.4K",
   * 850000 → "850K", 1200000 → "1.2M".
   *
   * One decimal below 100 of a unit, none above, so the badge never
   * grows wide enough to wrap a product card.
   */
  function compact(n) {
    n = Math.max(0, Math.round(Number(n) || 0));
    if (n < 1000) return String(n);
    function scale(value) {
      return value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
    }
    if (n < 999950) return String(scale(n / 1e3)) + "K";
    if (n < 999950000) return String(scale(n / 1e6)) + "M";
    return String(scale(n / 1e9)) + "B";
  }

  function grouped(n) {
    n = Math.max(0, Math.round(Number(n) || 0));
    try {
      return n.toLocaleString();
    } catch (e) {
      return String(n);
    }
  }

  function countText(n) {
    var value = opts.countFormat === "full" ? grouped(n) : compact(n);
    return value + " " + (Number(n) === 1 ? "Review" : "Reviews");
  }

  function ratingText(avg) {
    return (Number(avg) || 0).toFixed(1);
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function fmtDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    try {
      return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
    } catch (e) {
      return d.toDateString();
    }
  }

  function timeAgo(iso) {
    var t = new Date(iso).getTime();
    if (isNaN(t)) return "";
    var s = Math.max(1, Math.floor((Date.now() - t) / 1000));
    var units = [
      ["year", 31536000],
      ["month", 2592000],
      ["week", 604800],
      ["day", 86400],
      ["hour", 3600],
      ["minute", 60],
    ];
    for (var i = 0; i < units.length; i++) {
      var v = Math.floor(s / units[i][1]);
      if (v >= 1) return v + " " + units[i][0] + (v > 1 ? "s" : "") + " ago";
    }
    return "just now";
  }

  // ===========================================================
  // Icons
  // ===========================================================
  var STAR_PATH =
    "M12 2.5l2.95 6.4 7.05.7-5.3 4.85 1.55 6.95L12 17.9l-6.25 3.5L7.3 14.45 2 9.6l7.05-.7L12 2.5z";

  function starSVG(fill, size) {
    return (
      '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" aria-hidden="true" focusable="false">' +
      '<path d="' + STAR_PATH + '" fill="' + fill + '"/></svg>'
    );
  }

  function starsHTML(rating, size) {
    var full = Math.round(Number(rating) || 0);
    var out = "";
    for (var i = 1; i <= 5; i++) {
      out += starSVG(i <= full ? "var(--evo-star, #FFC107)" : "#E5E7EB", size || 16);
    }
    return out;
  }

  /**
   * The review badge. The seal is the brand's own 26-point polygon on a
   * 0 0 18 18 canvas — not a generic tick — with a white check laid over
   * it so it reads as a verification mark rather than a decoration.
   */
  function verifiedSVG(size) {
    return (
      '<svg viewBox="0 0 18 18" width="' + size + '" height="' + size + '" aria-hidden="true" focusable="false">' +
      '<polygon fill="#005eff" points="9,16 7.1,16.9 5.8,15.2 3.7,15.1 3.4,13 1.5,12 2.2,9.9 1.1,8.2 2.6,6.7 2.4,4.6 4.5,4 5.3,2 7.4,2.4 9,1.1 10.7,2.4 12.7,2 13.6,4 15.6,4.6 15.5,6.7 17,8.2 15.9,9.9 16.5,12 14.7,13 14.3,15.1 12.2,15.2 10.9,16.9"/>' +
      '<path d="M5.7 9.1l2.2 2.2 4.4-4.6" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg>'
    );
  }

  function checkSVG() {
    return (
      '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" focusable="false">' +
      '<path d="M9 16.2l-3.5-3.5-1.4 1.4L9 19l11-11-1.4-1.4z" fill="currentColor"/></svg>'
    );
  }

  // ===========================================================
  // Network
  // ===========================================================
  function getJSON(path, params) {
    var qs = [];
    for (var k in params) {
      if (params[k] !== undefined && params[k] !== null && params[k] !== "") {
        qs.push(encodeURIComponent(k) + "=" + encodeURIComponent(params[k]));
      }
    }
    var url = BASE + path + (qs.length ? "?" + qs.join("&") : "");
    return fetch(url, { headers: { Accept: "application/json" }, credentials: "same-origin" }).then(
      function (r) {
        if (!r.ok && r.status >= 500) throw new Error("server");
        return r.json();
      }
    );
  }

  function postJSON(path, body) {
    return fetch(BASE + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.json().then(
        function (d) {
          return { ok: r.ok, status: r.status, data: d };
        },
        function () {
          return { ok: false, status: r.status, data: {} };
        }
      );
    });
  }

  function findFirst(selectors) {
    if (!selectors) return null;
    var list = String(selectors).split(",");
    for (var i = 0; i < list.length; i++) {
      var sel = list[i].trim();
      if (!sel) continue;
      try {
        var el = document.querySelector(sel);
        if (el) return el;
      } catch (e) {
        /* a merchant typo in the selector setting must not throw */
      }
    }
    return null;
  }

  // ===========================================================
  // Lightbox — one instance, shared by every review on the page
  // ===========================================================
  var lightbox = null;

  function buildLightbox() {
    var el = document.createElement("div");
    el.className = "evo-lb";
    el.setAttribute("data-evo-lightbox", "");
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", "Review photo viewer");
    el.hidden = true;
    el.innerHTML =
      '<div class="evo-lb__backdrop" data-evo-lb-backdrop></div>' +
      '<div class="evo-lb__stage">' +
        '<div class="evo-lb__frame">' +
          '<div class="evo-lb__spinner" data-evo-lb-spinner aria-hidden="true"></div>' +
          '<img class="evo-lb__img" data-evo-lb-img alt=""/>' +
          '<p class="evo-lb__failed" data-evo-lb-failed hidden>This photo could not be loaded.</p>' +
        '</div>' +
        '<p class="evo-lb__caption" data-evo-lb-caption></p>' +
      '</div>' +
      '<button class="evo-lb__btn evo-lb__btn--close" type="button" data-evo-lb-close aria-label="Close photo viewer">' +
        '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>' +
      '</button>' +
      '<button class="evo-lb__btn evo-lb__btn--prev" type="button" data-evo-lb-prev aria-label="Previous photo">' +
        '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      '</button>' +
      '<button class="evo-lb__btn evo-lb__btn--next" type="button" data-evo-lb-next aria-label="Next photo">' +
        '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      '</button>' +
      '<p class="evo-lb__counter" data-evo-lb-counter aria-live="polite"></p>';

    document.body.appendChild(el);

    var img = el.querySelector("[data-evo-lb-img]");
    var spinner = el.querySelector("[data-evo-lb-spinner]");
    var failed = el.querySelector("[data-evo-lb-failed]");
    var counter = el.querySelector("[data-evo-lb-counter]");
    var caption = el.querySelector("[data-evo-lb-caption]");
    var prevBtn = el.querySelector("[data-evo-lb-prev]");
    var nextBtn = el.querySelector("[data-evo-lb-next]");
    var closeBtn = el.querySelector("[data-evo-lb-close]");

    var state = { images: [], index: 0, label: "", opener: null };

    function render() {
      var item = state.images[state.index];
      if (!item) return;

      var single = state.images.length < 2;
      prevBtn.hidden = single;
      nextBtn.hidden = single;
      counter.textContent = single ? "" : state.index + 1 + " of " + state.images.length;
      caption.textContent = state.label || "";

      failed.hidden = true;
      img.hidden = false;
      spinner.hidden = false;
      img.removeAttribute("src");
      img.alt = state.label
        ? "Photo " + (state.index + 1) + " from a review by " + state.label
        : "Review photo " + (state.index + 1);
      img.src = item.url;

      // Warm the neighbours so arrowing through feels instant without
      // downloading the whole set up front.
      [state.index - 1, state.index + 1].forEach(function (i) {
        var neighbour = state.images[(i + state.images.length) % state.images.length];
        if (neighbour && neighbour !== item) {
          var pre = new Image();
          pre.src = neighbour.url;
        }
      });
    }

    img.addEventListener("load", function () {
      spinner.hidden = true;
    });
    img.addEventListener("error", function () {
      spinner.hidden = true;
      img.hidden = true;
      failed.hidden = false;
    });

    function step(delta) {
      if (state.images.length < 2) return;
      state.index = (state.index + delta + state.images.length) % state.images.length;
      render();
    }

    function close() {
      el.hidden = true;
      document.documentElement.classList.remove("evo-lb-open");
      img.removeAttribute("src");
      if (state.opener && document.contains(state.opener)) {
        // Return the keyboard where it came from, or the shopper loses
        // their place in the review list.
        try {
          state.opener.focus();
        } catch (e) {}
      }
      state.opener = null;
    }

    prevBtn.addEventListener("click", function () {
      step(-1);
    });
    nextBtn.addEventListener("click", function () {
      step(1);
    });
    closeBtn.addEventListener("click", close);
    el.querySelector("[data-evo-lb-backdrop]").addEventListener("click", close);

    document.addEventListener("keydown", function (e) {
      if (el.hidden) return;
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      } else if (e.key === "ArrowLeft") {
        step(-1);
      } else if (e.key === "ArrowRight") {
        step(1);
      } else if (e.key === "Tab") {
        // Keep focus inside the dialog while it is open.
        var focusables = [closeBtn, prevBtn, nextBtn].filter(function (b) {
          return !b.hidden;
        });
        var first = focusables[0];
        var last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    });

    // Touch: a horizontal drag moves between photos, a vertical one is
    // left alone so the shopper can still scroll away.
    var touch = null;
    el.addEventListener(
      "touchstart",
      function (e) {
        if (!e.touches || e.touches.length !== 1) return;
        touch = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
      },
      { passive: true }
    );
    el.addEventListener(
      "touchend",
      function (e) {
        if (!touch || !e.changedTouches || !e.changedTouches.length) return;
        var dx = e.changedTouches[0].clientX - touch.x;
        var dy = e.changedTouches[0].clientY - touch.y;
        var quick = Date.now() - touch.t < 600;
        if (quick && Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.5) {
          step(dx < 0 ? 1 : -1);
        }
        touch = null;
      },
      { passive: true }
    );

    return {
      open: function (images, index, label, opener) {
        if (!images || !images.length) return;
        state.images = images;
        state.index = Math.max(0, Math.min(index || 0, images.length - 1));
        state.label = label || "";
        state.opener = opener || null;
        el.hidden = false;
        document.documentElement.classList.add("evo-lb-open");
        render();
        try {
          closeBtn.focus();
        } catch (e) {}
      },
    };
  }

  function openLightbox(images, index, label, opener) {
    if (!lightbox) lightbox = buildLightbox();
    lightbox.open(images, index, label, opener);
  }

  // ===========================================================
  // Client-side image processing
  //
  // A phone camera photo is 4–12MB. Uploading five of them is a slow,
  // failure-prone experience on mobile data, and nothing on the page
  // ever displays more than ~1600px. So each file is decoded, resized
  // twice, and re-encoded before it leaves the device:
  //
  //   full  ≤ 1600px  → what the lightbox opens
  //   thumb ≤  400px  → what the review card shows
  //
  // If anything in that pipeline is unavailable the original file is
  // uploaded unchanged rather than dropping the shopper's photo.
  // ===========================================================
  var MAX_SOURCE_BYTES = 8 * 1024 * 1024;

  function loadImageElement(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        resolve({ img: img, revoke: function () { URL.revokeObjectURL(url); } });
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("decode"));
      };
      img.src = url;
    });
  }

  function canvasToBlob(canvas, quality) {
    return new Promise(function (resolve) {
      if (canvas.toBlob) canvas.toBlob(function (b) { resolve(b); }, "image/jpeg", quality);
      else resolve(null);
    });
  }

  function resizeTo(img, maxEdge, quality) {
    var w = img.naturalWidth || img.width;
    var h = img.naturalHeight || img.height;
    if (!w || !h) return Promise.resolve(null);

    var scale = Math.min(1, maxEdge / Math.max(w, h));
    var tw = Math.max(1, Math.round(w * scale));
    var th = Math.max(1, Math.round(h * scale));

    var canvas = document.createElement("canvas");
    canvas.width = tw;
    canvas.height = th;
    var ctx = canvas.getContext("2d");
    if (!ctx) return Promise.resolve(null);
    ctx.drawImage(img, 0, 0, tw, th);

    return canvasToBlob(canvas, quality).then(function (blob) {
      return blob ? { blob: blob, w: tw, h: th } : null;
    });
  }

  function processFile(file) {
    return loadImageElement(file)
      .then(function (loaded) {
        return Promise.all([
          resizeTo(loaded.img, 1600, 0.82),
          resizeTo(loaded.img, 400, 0.72),
        ]).then(function (pair) {
          loaded.revoke();
          var full = pair[0];
          var thumb = pair[1];
          if (!full) return null;
          return {
            full: full.blob,
            thumb: thumb ? thumb.blob : full.blob,
            w: full.w,
            h: full.h,
            type: "image/jpeg",
            name: (file.name || "photo").replace(/\.[^.]+$/, "") + ".jpg",
          };
        });
      })
      .catch(function () {
        // Canvas unavailable, or an image format the browser cannot
        // decode (some HEIC). Send the original and let the server's
        // type and size checks decide.
        if (file.size > MAX_SOURCE_BYTES) return null;
        return {
          full: file,
          thumb: file,
          w: null,
          h: null,
          type: file.type || "image/jpeg",
          name: file.name || "photo",
        };
      });
  }

  function uploadPhotos(processed, onProgress) {
    if (!processed.length) return Promise.resolve([]);

    var meta = processed.map(function (p) {
      return { name: p.name, type: p.type, size: p.full.size };
    });

    return postJSON("/upload-url", { files: meta }).then(function (res) {
      if (!res.ok || !res.data || !res.data.uploads || !res.data.uploads.length) {
        throw new Error((res.data && res.data.error) || "Could not prepare the photo upload.");
      }

      var uploads = res.data.uploads;
      var done = 0;

      function put(url, blob, type) {
        if (!url) return Promise.resolve(false);
        return fetch(url, {
          method: "PUT",
          headers: { "Content-Type": type || "image/jpeg" },
          body: blob,
        })
          .then(function (r) { return r.ok; })
          .catch(function () { return false; });
      }

      return Promise.all(
        uploads.map(function (slot, i) {
          var p = processed[i];
          if (!p) return Promise.resolve(null);
          return Promise.all([
            put(slot.signedUrl, p.full, p.type),
            put(slot.thumbSignedUrl, p.thumb, p.type),
          ]).then(function (results) {
            done += 1;
            if (onProgress) onProgress(done, uploads.length);
            if (!results[0]) return null;
            return {
              url: slot.publicUrl,
              thumb: results[1] ? slot.thumbPublicUrl : slot.publicUrl,
              w: p.w,
              h: p.h,
            };
          });
        })
      ).then(function (list) {
        return list.filter(Boolean);
      });
    });
  }

  // ===========================================================
  // Star badge (product page, under the title)
  // ===========================================================
  function badgeInnerHTML(average, count) {
    var label =
      count > 0
        ? "Rated " + ratingText(average) + " out of 5 from " + grouped(count) + " reviews"
        : "No reviews yet";

    return (
      '<span class="evo-badge__group" role="img" aria-label="' + esc(label) + '">' +
        '<span class="evo-badge__star">' + starSVG("var(--evo-star, #FFC107)", 18) + "</span>" +
        '<span class="evo-badge__avg">' + ratingText(average) + "</span>" +
        (opts.verifiedIcon
          ? '<span class="evo-badge__verified">' + verifiedSVG(16) + "</span>"
          : "") +
        '<span class="evo-badge__count">(' + esc(countText(count)) + ")</span>" +
      "</span>"
    );
  }

  function renderBadge(host, average, count) {
    if (!count) {
      // A product with no reviews shows nothing rather than "0.0",
      // and gives its reserved space back to the page.
      host.innerHTML = "";
      host.classList.add("evo-badge--empty");
      return;
    }
    host.classList.remove("evo-badge--empty");
    host.innerHTML = badgeInnerHTML(average, count);

    // Clicking the rating jumps to the reviews, the way a shopper
    // expects it to.
    host.onclick = function () {
      var section = document.querySelector("[data-evo-review-widget]");
      if (section) section.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    host.setAttribute("tabindex", "0");
    host.setAttribute("role", "link");
    host.onkeydown = function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        host.onclick();
      }
    };
  }

  function mountBadge() {
    if (!isProductPage) return;

    // A merchant-placed badge block wins over automatic injection.
    var placed = document.querySelectorAll("[data-evo-badge-block]");
    var hosts = [];

    for (var i = 0; i < placed.length; i++) hosts.push(placed[i]);

    if (!hosts.length && opts.showBadge && !document.querySelector("[data-evo-star-badge]")) {
      var target = findFirst(badgeTarget);
      if (target) {
        var insertAfter = target;
        try {
          var parentStyle = window.getComputedStyle(target.parentNode || target);
          var display = parentStyle && parentStyle.display;
          if (display === "flex" || display === "inline-flex" || display === "grid") {
            // In a flex/grid title row the badge would squeeze in
            // beside the title; one level up it gets its own line.
            insertAfter = target.parentNode;
          }
        } catch (e) {}

        var host = document.createElement("div");
        host.className = "evo-badge";
        host.setAttribute("data-evo-star-badge", "");
        if (insertAfter.parentNode) {
          insertAfter.parentNode.insertBefore(host, insertAfter.nextSibling);
          hosts.push(host);
        }
      }
    }

    if (!hosts.length) return;

    // A badge block may have pre-painted from the product metafield in
    // Liquid. If so it is already correct; this call only refreshes it.
    getJSON("/summary", { handles: productHandle })
      .then(function (d) {
        var s = (d && d.summaries && d.summaries[productHandle]) || { average: 0, count: 0 };
        hosts.forEach(function (host) {
          renderBadge(host, s.average, s.count);
        });
        state.summary = s;
        maybeInjectRichSnippet(s.average, s.count);
      })
      .catch(function () {
        hosts.forEach(function (host) {
          if (!host.getAttribute("data-evo-prepainted")) host.innerHTML = "";
        });
      });
  }

  // ===========================================================
  // Structured data
  //
  // Only ever emitted from numbers that are actually on the page, and
  // only when the merchant has not turned it off (a theme that already
  // outputs its own rating markup would otherwise produce two).
  // ===========================================================
  function maybeInjectRichSnippet(average, count) {
    if (!opts.richSnippets || !isProductPage || !count) return;
    if (document.querySelector("[data-evo-jsonld]")) return;

    var node = {
      "@context": "https://schema.org",
      "@type": "Product",
      name: cfg.productTitle || document.title,
      url: cfg.productUrl || location.origin + location.pathname,
      aggregateRating: {
        "@type": "AggregateRating",
        ratingValue: ratingText(average),
        reviewCount: count,
        bestRating: 5,
        worstRating: 1,
      },
    };
    if (cfg.productImage) node.image = cfg.productImage;
    if (cfg.productSku) node.sku = cfg.productSku;

    var script = document.createElement("script");
    script.type = "application/ld+json";
    script.setAttribute("data-evo-jsonld", "");
    script.textContent = JSON.stringify(node);
    document.head.appendChild(script);
  }

  // ===========================================================
  // Review section
  // ===========================================================
  var state = { summary: null };

  var SECTION_HTML =
    '<div class="evo-rw__inner">' +
      '<header class="evo-rw__header">' +
        '<h2 class="evo-rw__heading" data-evo-heading></h2>' +
        '<div class="evo-rw__summary" data-evo-summary></div>' +
      "</header>" +
      '<div class="evo-rw__photos" data-evo-photos hidden></div>' +
      '<div class="evo-rw__toolbar" data-evo-toolbar hidden></div>' +
      '<div class="evo-rw__list" data-evo-list aria-live="polite" aria-busy="true"></div>' +
      '<div class="evo-rw__more" data-evo-more></div>' +
    "</div>";

  function chevronSVG(dir) {
    var d = dir === "left" ? "M11.5 3.5L6 9l5.5 5.5" : "M6.5 3.5L12 9l-5.5 5.5";
    return (
      '<svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true" focusable="false">' +
        '<path d="' + d + '" fill="none" stroke="currentColor" stroke-width="2" ' +
          'stroke-linecap="round" stroke-linejoin="round"/>' +
      "</svg>"
    );
  }

  function skeletonHTML(n) {
    var card =
      '<div class="evo-rw__card evo-rw__card--skeleton" aria-hidden="true">' +
        '<div class="evo-sk evo-sk--stars"></div>' +
        '<div class="evo-sk evo-sk--line"></div>' +
        '<div class="evo-sk evo-sk--line evo-sk--short"></div>' +
        '<div class="evo-sk evo-sk--author"></div>' +
      "</div>";
    var out = "";
    for (var i = 0; i < n; i++) out += card;
    return out;
  }

  function distributionHTML(distribution, total) {
    if (!opts.showDistribution || !total) return "";
    var rows = "";
    for (var stars = 5; stars >= 1; stars--) {
      var n = Number(distribution[stars] || distribution[String(stars)] || 0);
      var pct = total ? Math.round((n / total) * 100) : 0;
      rows +=
        '<button class="evo-rw__dist-row" type="button" data-evo-filter-rating="' + stars + '" ' +
          'aria-label="Show only ' + stars + ' star reviews, ' + grouped(n) + ' of them">' +
          '<span class="evo-rw__dist-label">' + stars + ' star</span>' +
          '<span class="evo-rw__dist-track"><span class="evo-rw__dist-fill" style="width:' + pct + '%"></span></span>' +
          '<span class="evo-rw__dist-count">' + grouped(n) + "</span>" +
        "</button>";
    }
    return '<div class="evo-rw__dist">' + rows + "</div>";
  }

  function summaryHTML(data) {
    if (!data.totalRatings) return "";
    return (
      '<div class="evo-rw__score">' +
        '<div class="evo-rw__score-value">' + ratingText(data.average) + "</div>" +
        '<div class="evo-rw__score-meta">' +
          '<div class="evo-rw__score-stars" role="img" aria-label="Average rating ' +
            ratingText(data.average) + ' out of 5">' + starsHTML(data.average, 20) + "</div>" +
          '<div class="evo-rw__score-count">Based on ' + esc(countText(data.totalRatings)) + "</div>" +
        "</div>" +
      "</div>" +
      distributionHTML(data.distribution || {}, data.totalRatings)
    );
  }

  function toolbarHTML(view, data) {
    var pills = '<button class="evo-rw__pill" type="button" data-evo-filter-rating="0"' +
      (view.rating ? "" : ' aria-pressed="true"') + ">All</button>";
    for (var s = 5; s >= 1; s--) {
      pills +=
        '<button class="evo-rw__pill" type="button" data-evo-filter-rating="' + s + '"' +
        (view.rating === s ? ' aria-pressed="true"' : "") +
        ">" + s + "★</button>";
    }

    var photos =
      opts.showImages && data.imagesCount
        ? '<button class="evo-rw__pill evo-rw__pill--photos" type="button" data-evo-filter-photos' +
          (view.photosOnly ? ' aria-pressed="true"' : "") +
          ">With photos (" + grouped(data.imagesCount) + ")</button>"
        : "";

    var sort =
      '<label class="evo-rw__sort"><span class="evo-rw__sr">Sort reviews by</span>' +
        '<select data-evo-sort>' +
          '<option value="newest"' + (view.sort === "newest" ? " selected" : "") + ">Most recent</option>" +
          '<option value="highest"' + (view.sort === "highest" ? " selected" : "") + ">Highest rated</option>" +
          '<option value="lowest"' + (view.sort === "lowest" ? " selected" : "") + ">Lowest rated</option>" +
        "</select></label>";

    return (
      '<div class="evo-rw__filters">' + pills + photos + "</div>" +
      '<div class="evo-rw__toolbar-right">' + sort +
        (opts.allowSubmissions
          ? '<button class="evo-rw__btn evo-rw__btn--primary" type="button" data-evo-write>Write a review</button>'
          : "") +
      "</div>"
    );
  }

  function thumbsHTML(review) {
    if (!opts.showImages) return "";
    var images = review.images || [];
    if (!images.length) return "";

    var VISIBLE = 5;
    var shown = images.slice(0, VISIBLE);
    var html = '<ul class="evo-rw__thumbs" data-evo-thumbs>';

    for (var i = 0; i < shown.length; i++) {
      var img = shown[i];
      var overflow = i === VISIBLE - 1 && images.length > VISIBLE;
      // width/height reserve the tile before the image arrives, so the
      // review card does not resize as photos load in.
      html +=
        "<li>" +
          '<button class="evo-rw__thumb" type="button" data-evo-thumb data-review="' +
            esc(review.id) + '" data-index="' + i + '" ' +
            'aria-label="Open photo ' + (i + 1) + " of " + images.length +
            ' from the review by ' + esc(review.author_name || "a customer") + '">' +
            '<img src="' + esc(img.thumb || img.url) + '" alt="" loading="lazy" decoding="async" ' +
              'width="72" height="72"/>' +
            (overflow
              ? '<span class="evo-rw__thumb-more">+' + (images.length - VISIBLE + 1) + "</span>"
              : "") +
          "</button>" +
        "</li>";
    }
    return html + "</ul>";
  }

  /**
   * "Reviews with images" — the horizontal band of customer photos
   * Amazon puts between the rating summary and the reviews.
   *
   * Two things make it worth its own component rather than a row of
   * card thumbnails. It is drawn from the whole matching set, not the
   * visible page, so it is populated before anyone scrolls. And a click
   * opens a gallery of every photo in the strip rather than the photos
   * of the one review it came from, which is what a shopper scanning
   * for "what does this actually look like" is after.
   */
  function photoStripHTML(photos) {
    if (!opts.showImages || !photos || photos.length < 2) return "";

    var items = "";
    for (var i = 0; i < photos.length; i++) {
      var img = photos[i];
      items +=
        "<li>" +
          '<button class="evo-rw__strip-item" type="button" data-evo-strip-photo data-index="' + i + '" ' +
            'aria-label="Open customer photo ' + (i + 1) + " of " + photos.length +
            (img.author_name ? ", by " + esc(img.author_name) : "") + '">' +
            '<img src="' + esc(img.thumb || img.url) + '" alt="" loading="lazy" decoding="async" ' +
              'width="150" height="150"/>' +
          "</button>" +
        "</li>";
    }

    return (
      '<div class="evo-rw__photos-head">' +
        '<h3 class="evo-rw__photos-title">Reviews with images</h3>' +
        '<button class="evo-rw__photos-all" type="button" data-evo-see-all-photos>' +
          "See all photos" +
          '<span aria-hidden="true"> \u203a</span>' +
        "</button>" +
      "</div>" +
      '<div class="evo-rw__strip-wrap">' +
        '<button class="evo-rw__strip-nav evo-rw__strip-nav--prev" type="button" ' +
          'data-evo-strip-scroll="-1" aria-label="Scroll photos left">' + chevronSVG("left") + "</button>" +
        '<ul class="evo-rw__strip" data-evo-strip>' + items + "</ul>" +
        '<button class="evo-rw__strip-nav evo-rw__strip-nav--next" type="button" ' +
          'data-evo-strip-scroll="1" aria-label="Scroll photos right">' + chevronSVG("right") + "</button>" +
      "</div>"
    );
  }

  /** "wireless-neckband-z2" -> "Wireless Neckband Z2" */
  function titleFromHandle(handle) {
    return String(handle || "")
      .split("-")
      .filter(Boolean)
      .map(function (w) {
        return w.charAt(0).toUpperCase() + w.slice(1);
      })
      .join(" ");
  }

  function cardHTML(review, mode) {
    // On a store-wide wall every card is about a different product, so
    // without this the reviews read as unattributed praise.
    var product =
      mode === "store" && review.product_handle
        ? '<a class="evo-rw__card-product" href="' +
            esc(rootUrl() + "products/" + review.product_handle) + '">' +
            esc(titleFromHandle(review.product_handle)) +
          "</a>"
        : "";

    var verifiedMark = review.is_verified
      ? '<span class="evo-rw__verified">' + checkSVG() + "Verified purchase</span>"
      : "";
    var location = review.author_location
      ? '<span class="evo-rw__loc">' + esc(review.author_location) + "</span>"
      : "";
    var title = review.title
      ? '<h3 class="evo-rw__card-title">' + esc(review.title) + "</h3>"
      : "";
    var reply = review.reply
      ? '<div class="evo-rw__reply"><span class="evo-rw__reply-label">Store response</span>' +
        "<p>" + esc(review.reply) + "</p></div>"
      : "";

    return (
      '<article class="evo-rw__card">' +
        '<div class="evo-rw__card-head">' +
          '<span class="evo-rw__card-stars" role="img" aria-label="' + review.rating +
            ' out of 5 stars">' + starsHTML(review.rating, 15) + "</span>" +
          '<time class="evo-rw__card-date" datetime="' + esc(review.created_at) + '" title="' +
            esc(fmtDate(review.created_at)) + '">' + esc(timeAgo(review.created_at)) + "</time>" +
        "</div>" +
        product +
        title +
        '<p class="evo-rw__card-body">' + esc(review.content) + "</p>" +
        thumbsHTML(review) +
        '<footer class="evo-rw__card-foot">' +
          '<span class="evo-rw__avatar" aria-hidden="true">' +
            esc(review.author_initials || "AN") + "</span>" +
          '<span class="evo-rw__author">' +
            '<span class="evo-rw__author-name">' + esc(review.author_name || "Anonymous") + "</span>" +
            '<span class="evo-rw__author-meta">' + verifiedMark + location + "</span>" +
          "</span>" +
        "</footer>" +
        reply +
      "</article>"
    );
  }

  function emptyHTML(view) {
    var filtered = view.rating || view.photosOnly;
    return (
      '<div class="evo-rw__empty">' +
        "<p>" +
          (filtered
            ? "No reviews match that filter."
            : esc(opts.emptyText)) +
        "</p>" +
        (filtered
          ? '<button class="evo-rw__btn" type="button" data-evo-filter-rating="0">Show all reviews</button>'
          : opts.allowSubmissions
            ? '<button class="evo-rw__btn evo-rw__btn--primary" type="button" data-evo-write>Write a review</button>'
            : "") +
      "</div>"
    );
  }

  function errorHTML() {
    return (
      '<div class="evo-rw__empty evo-rw__empty--error">' +
        "<p>Reviews could not be loaded right now.</p>" +
        '<button class="evo-rw__btn" type="button" data-evo-retry>Try again</button>' +
      "</div>"
    );
  }

  function mountSection(host, mode, limitOverride, scope) {
    if (host.getAttribute("data-evo-mounted") === "1") return;
    host.setAttribute("data-evo-mounted", "1");
    host.classList.add("evo-rw");
    host.setAttribute("data-evo-review-widget", "");
    host.innerHTML = SECTION_HTML;

    var listEl = host.querySelector("[data-evo-list]");
    var summaryEl = host.querySelector("[data-evo-summary]");
    var headingEl = host.querySelector("[data-evo-heading]");
    var toolbarEl = host.querySelector("[data-evo-toolbar]");
    var photosEl = host.querySelector("[data-evo-photos]");
    var moreEl = host.querySelector("[data-evo-more]");
    var stripPainted = false;

    headingEl.textContent = opts.heading;

    var perPage = Math.max(1, Math.min(100, limitOverride || opts.perPage));

    var view = { page: 1, rating: 0, photosOnly: false, sort: "newest" };
    var cache = { reviews: [], byId: {}, data: null, photos: [] };

    listEl.innerHTML = skeletonHTML(Math.min(perPage, 4));

    function request(page) {
      return getJSON("/reviews", {
        handle: mode === "store" ? "" : productHandle || productId,
        store: mode === "store" ? "true" : "",
        scope: mode === "store" && scope === "unattached" ? "unattached" : "",
        page: page,
        limit: perPage,
        rating: view.rating || "",
        photos: view.photosOnly ? "1" : "",
        sort: view.sort,
      });
    }

    function renderMore(data) {
      if (opts.pagination === "pagination") {
        if (data.totalPages <= 1) {
          moreEl.innerHTML = "";
          return;
        }
        var start = Math.max(1, view.page - 2);
        var end = Math.min(data.totalPages, start + 4);
        start = Math.max(1, end - 4);
        var html =
          '<nav class="evo-rw__pager" aria-label="Reviews pages">' +
          '<button type="button" data-evo-page="' + (view.page - 1) + '"' +
          (view.page <= 1 ? " disabled" : "") + ' aria-label="Previous page">Prev</button>';
        for (var i = start; i <= end; i++) {
          html +=
            '<button type="button" data-evo-page="' + i + '"' +
            (i === view.page ? ' aria-current="page"' : "") +
            ' aria-label="Page ' + i + '">' + i + "</button>";
        }
        html +=
          '<button type="button" data-evo-page="' + (view.page + 1) + '"' +
          (view.page >= data.totalPages ? " disabled" : "") +
          ' aria-label="Next page">Next</button></nav>';
        moreEl.innerHTML = html;
        return;
      }

      if (!data.hasMore) {
        moreEl.innerHTML = cache.reviews.length
          ? '<p class="evo-rw__showing">Showing all ' + esc(countText(data.total)) + "</p>"
          : "";
        return;
      }
      moreEl.innerHTML =
        '<p class="evo-rw__showing">Showing ' + grouped(cache.reviews.length) + " of " +
          esc(countText(data.total)) + "</p>" +
        '<button class="evo-rw__btn evo-rw__btn--more" type="button" data-evo-load-more>' +
          "Load more reviews</button>";
    }

    function paint(data, append) {
      cache.data = data;
      var rows = data.reviews || [];

      if (append) cache.reviews = cache.reviews.concat(rows);
      else cache.reviews = rows;

      cache.reviews.forEach(function (r) {
        cache.byId[r.id] = r;
      });

      summaryEl.innerHTML = summaryHTML(data);

      // The strip describes the whole review set, not the current
      // filter, so it is painted once from the first unfiltered
      // response and then left alone. Re-rendering it on every filter
      // change would make it flicker and jump the page.
      if (!append && !stripPainted) {
        cache.photos = data.photos || [];
        var stripHTML = photoStripHTML(cache.photos);
        photosEl.innerHTML = stripHTML;
        photosEl.hidden = !stripHTML;
        stripPainted = true;
      }

      toolbarEl.hidden = !data.totalRatings;
      if (data.totalRatings) toolbarEl.innerHTML = toolbarHTML(view, data);

      listEl.setAttribute("aria-busy", "false");
      listEl.innerHTML = cache.reviews.length
        ? cache.reviews
            .map(function (r) {
              return cardHTML(r, mode);
            })
            .join("")
        : emptyHTML(view);

      renderMore(data);

      if (mode !== "store") maybeInjectRichSnippet(data.average, data.totalRatings);
    }

    function load(page, append) {
      if (!append) {
        listEl.setAttribute("aria-busy", "true");
        listEl.innerHTML = skeletonHTML(Math.min(perPage, 4));
      }
      view.page = page;
      return request(page)
        .then(function (data) {
          if (!data || data.ok === false) {
            if (data && data.installed === false) {
              // The app was removed but the embed is still in the
              // theme. Render nothing rather than an error.
              host.innerHTML = "";
              return;
            }
            throw new Error("payload");
          }
          paint(data, append);
        })
        .catch(function () {
          listEl.setAttribute("aria-busy", "false");
          if (!append) listEl.innerHTML = errorHTML();
          else moreEl.innerHTML = errorHTML();
        });
    }

    function reload() {
      cache.reviews = [];
      load(1, false);
    }

    // A photo that 404s (storage pruned, a bad CDN day) must not leave
    // a broken-image icon in the middle of a review. `error` does not
    // bubble, so this listens in the capture phase.
    host.addEventListener(
      "error",
      function (e) {
        var img = e.target;
        if (!img || img.tagName !== "IMG") return;
        var thumb = img.closest(".evo-rw__thumb");
        if (thumb) {
          thumb.classList.add("is-broken");
          return;
        }
        // A dead tile in the photo strip is removed outright: unlike a
        // review card, there is nothing else in it worth keeping.
        var tile = img.closest(".evo-rw__strip-item");
        if (tile && tile.parentNode) tile.parentNode.remove();
      },
      true
    );

    // ---- delegated interaction ----
    host.addEventListener("click", function (e) {
      var el;

      el = e.target.closest("[data-evo-thumb]");
      if (el) {
        var review = cache.byId[el.getAttribute("data-review")];
        if (review && review.images) {
          openLightbox(
            review.images,
            parseInt(el.getAttribute("data-index"), 10) || 0,
            review.author_name,
            el
          );
        }
        return;
      }

      el = e.target.closest("[data-evo-strip-photo]");
      if (el) {
        // Amazon opens the whole band as one gallery, not the photos of
        // the single review the tile came from.
        openLightbox(
          cache.photos,
          parseInt(el.getAttribute("data-index"), 10) || 0,
          "Customer photos",
          el
        );
        return;
      }

      el = e.target.closest("[data-evo-strip-scroll]");
      if (el) {
        var strip = host.querySelector("[data-evo-strip]");
        if (strip) {
          var dir = parseInt(el.getAttribute("data-evo-strip-scroll"), 10) || 1;
          // Roughly one screenful, so repeated clicks walk the band
          // rather than nudging it.
          strip.scrollBy({
            left: dir * Math.max(160, strip.clientWidth * 0.8),
            behavior: "smooth",
          });
        }
        return;
      }

      el = e.target.closest("[data-evo-see-all-photos]");
      if (el) {
        view.photosOnly = true;
        reload();
        return;
      }

      el = e.target.closest("[data-evo-filter-rating]");
      if (el) {
        var next = parseInt(el.getAttribute("data-evo-filter-rating"), 10) || 0;
        view.rating = view.rating === next ? 0 : next;
        reload();
        return;
      }

      el = e.target.closest("[data-evo-filter-photos]");
      if (el) {
        view.photosOnly = !view.photosOnly;
        reload();
        return;
      }

      el = e.target.closest("[data-evo-load-more]");
      if (el) {
        el.disabled = true;
        el.textContent = "Loading…";
        load(view.page + 1, true);
        return;
      }

      el = e.target.closest("[data-evo-page]");
      if (el && !el.disabled) {
        load(parseInt(el.getAttribute("data-evo-page"), 10) || 1, false);
        host.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }

      el = e.target.closest("[data-evo-retry]");
      if (el) {
        reload();
        return;
      }

      el = e.target.closest("[data-evo-write]");
      if (el) {
        openForm(host, mode, reload, el);
      }
    });

    host.addEventListener("change", function (e) {
      var select = e.target.closest("[data-evo-sort]");
      if (!select) return;
      view.sort = select.value;
      reload();
    });

    load(1, false);
  }

  // ===========================================================
  // Submission form
  // ===========================================================
  function formHTML() {
    // Emitted high → low; the stylesheet reverses the row visually.
    var stars = "";
    for (var i = 5; i >= 1; i--) {
      stars +=
        '<input class="evo-rw__sr" type="radio" name="rating" id="evo-star-' + i +
          '" value="' + i + '" required/>' +
        '<label class="evo-form__star" for="evo-star-' + i + '" title="' + i +
          ' star' + (i > 1 ? "s" : "") + '">' +
          '<span class="evo-rw__sr">' + i + " star" + (i > 1 ? "s" : "") + "</span>" +
          starSVG("currentColor", 30) +
        "</label>";
    }

    return (
      '<div class="evo-form__backdrop" data-evo-form-backdrop></div>' +
      '<div class="evo-form__card" role="dialog" aria-modal="true" aria-labelledby="evo-form-title">' +
        '<button class="evo-form__close" type="button" data-evo-form-close aria-label="Close review form">' +
          '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>' +
        "</button>" +
        '<h2 class="evo-form__title" id="evo-form-title">Write a review</h2>' +
        '<form data-evo-form novalidate>' +
          '<fieldset class="evo-form__rating">' +
            "<legend>Your rating</legend>" +
            '<div class="evo-form__stars">' + stars + "</div>" +
          "</fieldset>" +

          '<label class="evo-form__field">' +
            "<span>Headline" + (opts.requireTitle ? ' <em aria-hidden="true">*</em>' : "") + "</span>" +
            '<input type="text" name="title" maxlength="120" autocomplete="off" placeholder="Sum it up in a few words"' +
              (opts.requireTitle ? " required" : "") + "/>" +
          "</label>" +

          '<label class="evo-form__field">' +
            '<span>Your review <em aria-hidden="true">*</em></span>' +
            '<textarea name="content" rows="5" maxlength="4000" required ' +
              'placeholder="What did you like or dislike? How did you use it?"></textarea>' +
            '<span class="evo-form__hint" data-evo-counter>0 / 4000</span>' +
          "</label>" +

          '<div class="evo-form__row">' +
            '<label class="evo-form__field">' +
              '<span>Your name <em aria-hidden="true">*</em></span>' +
              '<input type="text" name="author_name" maxlength="80" required autocomplete="name" placeholder="e.g. Aman S."/>' +
            "</label>" +
            '<label class="evo-form__field">' +
              "<span>Location</span>" +
              '<input type="text" name="author_location" maxlength="80" autocomplete="address-level2" placeholder="e.g. Mumbai"/>' +
            "</label>" +
          "</div>" +

          '<label class="evo-form__field">' +
            "<span>Email" + (opts.requireEmail ? ' <em aria-hidden="true">*</em>' : " (optional)") + "</span>" +
            '<input type="email" name="author_email" maxlength="160" autocomplete="email" placeholder="you@example.com"' +
              (opts.requireEmail ? " required" : "") + "/>" +
            '<span class="evo-form__hint">Never shown publicly. Used only if the store needs to reach you.</span>' +
          "</label>" +

          (opts.allowPhotos
            ? '<div class="evo-form__field evo-form__photos">' +
                "<span>Add photos (up to " + opts.maxPhotos + ", 8MB each)</span>" +
                '<label class="evo-form__file">' +
                  '<input type="file" class="evo-rw__sr" accept="image/jpeg,image/png,image/webp,image/gif,image/heic" multiple data-evo-photos/>' +
                  "<span>Choose photos</span>" +
                "</label>" +
                '<ul class="evo-form__previews" data-evo-previews></ul>' +
              "</div>"
            : "") +

          '<p class="evo-form__error" data-evo-error role="alert" hidden></p>' +
          '<button class="evo-rw__btn evo-rw__btn--primary evo-form__submit" type="submit" data-evo-submit>' +
            "Submit review</button>" +
          '<p class="evo-form__legal">Your review is sent to the store and published after review.</p>' +
        "</form>" +
        '<div class="evo-form__done" data-evo-done hidden>' +
          '<div class="evo-form__done-icon" aria-hidden="true">' + checkSVG() + "</div>" +
          '<h3 data-evo-done-title>Thank you</h3>' +
          "<p data-evo-done-text></p>" +
          '<button class="evo-rw__btn" type="button" data-evo-form-close>Close</button>' +
        "</div>" +
      "</div>"
    );
  }

  function openForm(sectionHost, mode, onSubmitted, opener) {
    var modal = document.createElement("div");
    modal.className = "evo-form";
    modal.setAttribute("data-evo-form-modal", "");
    modal.innerHTML = formHTML();
    document.body.appendChild(modal);
    document.documentElement.classList.add("evo-lb-open");

    var form = modal.querySelector("[data-evo-form]");
    var errorEl = modal.querySelector("[data-evo-error]");
    var submitBtn = modal.querySelector("[data-evo-submit]");
    var doneEl = modal.querySelector("[data-evo-done]");
    var counter = modal.querySelector("[data-evo-counter]");
    var fileInput = modal.querySelector("[data-evo-photos]");
    var previews = modal.querySelector("[data-evo-previews]");
    var card = modal.querySelector(".evo-form__card");

    var chosen = []; // { file, url }

    function close() {
      document.documentElement.classList.remove("evo-lb-open");
      chosen.forEach(function (c) {
        URL.revokeObjectURL(c.url);
      });
      modal.remove();
      if (opener && document.contains(opener)) {
        try {
          opener.focus();
        } catch (e) {}
      }
    }

    modal.addEventListener("click", function (e) {
      if (e.target.closest("[data-evo-form-close]") || e.target.closest("[data-evo-form-backdrop]")) {
        close();
      }
    });

    modal.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== "Tab") return;
      var focusables = card.querySelectorAll(
        'button:not([disabled]), input:not([disabled]):not(.evo-rw__sr), select, textarea, [href], label.evo-form__star, label.evo-form__file'
      );
      if (!focusables.length) return;
      var first = focusables[0];
      var last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });

    var body = form.querySelector('[name="content"]');
    body.addEventListener("input", function () {
      counter.textContent = body.value.length + " / 4000";
    });

    function showError(message, field) {
      errorEl.textContent = message;
      errorEl.hidden = false;
      if (field) {
        var el = form.querySelector('[name="' + field + '"]');
        if (el) {
          el.classList.add("is-invalid");
          try {
            el.focus();
          } catch (e) {}
        }
      }
    }
    function clearError() {
      errorEl.hidden = true;
      errorEl.textContent = "";
      Array.prototype.forEach.call(form.querySelectorAll(".is-invalid"), function (el) {
        el.classList.remove("is-invalid");
      });
    }

    function renderPreviews() {
      previews.innerHTML = chosen
        .map(function (c, i) {
          return (
            "<li>" +
              '<img src="' + c.url + '" alt="Selected photo ' + (i + 1) + '"/>' +
              '<button type="button" data-evo-remove="' + i + '" aria-label="Remove photo ' +
                (i + 1) + '">&times;</button>' +
            "</li>"
          );
        })
        .join("");
    }

    if (fileInput) {
      fileInput.addEventListener("change", function () {
        clearError();
        var files = Array.prototype.slice.call(fileInput.files || []);
        for (var i = 0; i < files.length; i++) {
          var f = files[i];
          if (chosen.length >= opts.maxPhotos) {
            showError("You can add up to " + opts.maxPhotos + " photos.");
            break;
          }
          if (!/^image\//.test(f.type || "")) {
            showError("“" + f.name + "” is not an image file.");
            continue;
          }
          if (f.size > MAX_SOURCE_BYTES) {
            showError("“" + f.name + "” is larger than 8MB.");
            continue;
          }
          chosen.push({ file: f, url: URL.createObjectURL(f) });
        }
        fileInput.value = "";
        renderPreviews();
      });

      previews.addEventListener("click", function (e) {
        var btn = e.target.closest("[data-evo-remove]");
        if (!btn) return;
        var idx = parseInt(btn.getAttribute("data-evo-remove"), 10);
        if (chosen[idx]) {
          URL.revokeObjectURL(chosen[idx].url);
          chosen.splice(idx, 1);
          renderPreviews();
        }
      });
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      clearError();

      var data = new FormData(form);
      var rating = parseInt(data.get("rating"), 10);
      var name = String(data.get("author_name") || "").trim();
      var content = String(data.get("content") || "").trim();
      var title = String(data.get("title") || "").trim();
      var email = String(data.get("author_email") || "").trim();

      // Client-side validation is for the shopper's benefit only. The
      // same rules run again on the server, which is the one that
      // decides.
      if (!rating) return showError("Please choose a star rating.");
      if (!name) return showError("Please add your name.", "author_name");
      if (!content) return showError("Please write your review.", "content");
      if (content.length < 5) return showError("Please write a little more.", "content");
      if (opts.requireTitle && !title) return showError("Please add a headline.", "title");
      if (opts.requireEmail && !email) return showError("Please add your email address.", "author_email");
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
        return showError("That email address does not look right.", "author_email");
      }

      submitBtn.disabled = true;
      submitBtn.textContent = chosen.length ? "Preparing photos…" : "Submitting…";

      var work = chosen.length
        ? Promise.all(chosen.map(function (c) { return processFile(c.file); }))
            .then(function (processed) {
              var usable = processed.filter(Boolean);
              if (!usable.length) return [];
              submitBtn.textContent = "Uploading photos…";
              return uploadPhotos(usable, function (done, total) {
                submitBtn.textContent = "Uploading photo " + done + " of " + total + "…";
              });
            })
        : Promise.resolve([]);

      work
        .then(function (images) {
          submitBtn.textContent = "Submitting…";
          return postJSON("/submit", {
            handle: mode === "store" ? "" : productHandle || "",
            product_id: mode === "store" ? null : productId,
            author_name: name,
            author_email: email,
            author_location: String(data.get("author_location") || "").trim(),
            rating: rating,
            title: title,
            content: content,
            images: images,
          });
        })
        .then(function (res) {
          if (!res.ok) {
            submitBtn.disabled = false;
            submitBtn.textContent = "Submit review";
            return showError(
              (res.data && res.data.error) || "Your review could not be submitted. Please try again."
            );
          }
          form.hidden = true;
          doneEl.hidden = false;
          modal.querySelector("[data-evo-done-title]").textContent = res.data.pending
            ? "Thanks — it's on its way"
            : "Thanks — your review is live";
          modal.querySelector("[data-evo-done-text]").textContent =
            res.data.message || "We appreciate you taking the time.";
          try {
            modal.querySelector("[data-evo-done] [data-evo-form-close]").focus();
          } catch (err) {}
          if (!res.data.pending && typeof onSubmitted === "function") onSubmitted();
        })
        .catch(function () {
          submitBtn.disabled = false;
          submitBtn.textContent = "Submit review";
          showError("Something went wrong. Please check your connection and try again.");
        });
    });

    try {
      modal.querySelector(".evo-form__close").focus();
    } catch (e) {}
  }

  // ===========================================================
  // Product-card badges — collections, search, related rows
  // ===========================================================
  function getLinkHandle(link) {
    if (!link) return null;
    var m = (link.getAttribute("href") || "").match(/\/products\/([^/?#]+)/);
    return m ? m[1] : null;
  }

  function uniqueHandlesIn(el) {
    var seen = {};
    var count = 0;
    var anchors = el.querySelectorAll('a[href*="/products/"]');
    for (var i = 0; i < anchors.length; i++) {
      var h = getLinkHandle(anchors[i]);
      if (h && !seen[h]) {
        seen[h] = true;
        count += 1;
      }
      if (count > 1) return 2;
    }
    return count;
  }

  /**
   * Walk up from a product link to the smallest ancestor that contains
   * an image and links to exactly one product. That is the card.
   * Hitting a container with two products means we left the card and
   * entered the grid, so stop.
   *
   * This is why the widget survives themes it has never seen: it never
   * asks for `.product-card`, it works out what a card is from the
   * structure every card must have.
   */
  function findCard(link) {
    var node = link.parentElement;
    for (var depth = 0; depth < 6 && node; depth++) {
      var handles = uniqueHandlesIn(node);
      if (handles > 1) return null;
      if (handles === 1 && node.querySelector("img")) return node;
      node = node.parentElement;
    }
    return null;
  }

  /**
   * The element a card badge should sit under.
   *
   * Tried in order: a real heading, then a class that names itself a
   * title, then the first product link that actually carries text.
   * That last step matters — most themes put an image-only link first,
   * and matching it would put the rating under the photo.
   */
  function findCardTitle(card) {
    var heading = card.querySelector("h1, h2, h3, h4, h5, h6");
    if (heading && (heading.textContent || "").trim()) return heading;

    var byClass = card.querySelector(TITLE_SELECTORS);
    if (byClass && (byClass.textContent || "").trim()) return byClass;

    // The last resort is a product link that carries text. Skip any that
    // wraps an image — that is the photo link, and anchoring to it puts
    // the rating above the price instead of under the title.
    var links = card.querySelectorAll('a[href*="/products/"]');
    for (var i = 0; i < links.length; i++) {
      if (links[i].querySelector("img")) continue;
      if ((links[i].textContent || "").trim()) return links[i];
    }
    return null;
  }

  var TITLE_SELECTORS = [
    ".card__heading", ".card__title", ".card-title",
    ".product-card__title", ".product-card-title", ".product__title",
    ".product-title", ".grid-product__title",
    "[class*='card-title']", "[class*='card__title']",
    "[class*='product-title']", "[class*='product-card__title']",
    "[class*='card__heading']",
  ].join(",");

  function cardBadgeHTML(average, count) {
    var label =
      "Rated " + ratingText(average) + " out of 5 from " + grouped(count) + " reviews";
    return (
      '<span class="evo-card-badge__star">' + starSVG("var(--evo-star, #FFC107)", 15) + "</span>" +
      '<span class="evo-card-badge__avg">' + ratingText(average) + "</span>" +
      (opts.verifiedIcon
        ? '<span class="evo-card-badge__verified">' + verifiedSVG(14) + "</span>"
        : "") +
      '<span class="evo-card-badge__count">(' + esc(countText(count)) + ")</span>" +
      '<span class="evo-rw__sr">' + esc(label) + "</span>"
    );
  }

  // The price inside a product card. First match wins, and a compare-at
  // price is usually a child of the same element, so this lands on the
  // price block rather than on one of the two amounts.
  var CARD_PRICE_TARGETS = [
    ".price",
    "[data-price]",
    "[class*='price__regular']",
    "[class*='product-price']",
    "[class*='card__price']",
    "[class*='price']",
  ].join(", ");

  function firstIn(card, selectors) {
    try {
      return card.querySelector(selectors);
    } catch (e) {
      return null;
    }
  }

  /**
   * Put the badge where the merchant asked for it.
   *
   * Both sensible positions on a card are anchored on the price: "under
   * the image" is the slot immediately before it, "next to the price" is
   * immediately after. Anchoring on the price rather than the image is
   * what makes this survive themes that wrap the photo in three nested
   * divs.
   *
   * Falls back to the title, then gives up — a rating stranded under the
   * Add to cart button is worse than no rating at all.
   */
  function placeCardBadge(card, badge) {
    var where = opts.cardBadgePosition;

    if (where === "above_price" || where === "beside_price") {
      var price = firstIn(card, CARD_PRICE_TARGETS);
      if (price && price.parentNode) {
        if (where === "beside_price") {
          badge.className += " evo-card-badge--inline";
          price.parentNode.insertBefore(badge, price.nextSibling);
        } else {
          price.parentNode.insertBefore(badge, price);
        }
        return true;
      }
    }

    var title = findCardTitle(card);
    if (title && title.parentNode) {
      // Directly after the title, never after the title's PARENT. The
      // hop up was there to escape an inline link, but on a theme whose
      // title is a link inside the card body it selected the whole body
      // — which is how the rating ended up below Add to cart.
      title.parentNode.insertBefore(badge, title.nextSibling);
      return true;
    }

    return false;
  }

  var cardBadgeRunning = false;

  function injectCardBadges() {
    if (!opts.showCardBadges || cardBadgeRunning) return;

    var byHandle = {};
    var seen = [];
    var links = document.querySelectorAll('a[href*="/products/"]');

    for (var i = 0; i < links.length; i++) {
      var handle = getLinkHandle(links[i]);
      if (!handle) continue;
      // The product page has its own badge under the title.
      if (isProductPage && handle === productHandle) continue;

      var card = findCard(links[i]);
      if (!card || seen.indexOf(card) !== -1) continue;
      seen.push(card);
      if (card.querySelector("[data-evo-card-badge]")) continue;

      (byHandle[handle] = byHandle[handle] || []).push(card);
    }

    // A card usually links to its product twice — once on the image,
    // once on the title. Walking up from each lands on two different
    // ancestors: the image link stops at a small media wrapper (it has
    // an image and one handle, so it looks like a card), the title link
    // climbs past the text column to the real card. Both qualify, and
    // the store gets two badges.
    //
    // Keep only candidates that no other candidate contains — the real
    // card, not the media wrapper inside it.
    Object.keys(byHandle).forEach(function (handle) {
      var list = byHandle[handle];
      byHandle[handle] = list.filter(function (card) {
        for (var i = 0; i < list.length; i++) {
          if (list[i] !== card && list[i].contains(card)) return false;
        }
        return true;
      });
    });

    var wanted = Object.keys(byHandle);
    if (!wanted.length) return;

    cardBadgeRunning = true;

    // One request for the whole grid, not one per card. A 40-product
    // collection page costs a single round trip.
    getJSON("/summary", { handles: wanted.join(",") })
      .then(function (payload) {
        var summaries = (payload && payload.summaries) || {};
        wanted.forEach(function (handle) {
          var s = summaries[handle];
          if (!s || !s.count) return;

          byHandle[handle].forEach(function (card) {
            // Re-checked here as well as at collection time: the fetch
            // in between is long enough for a theme's own script to have
            // re-rendered the grid underneath us.
            if (card.querySelector("[data-evo-card-badge]")) return;

            var badge = document.createElement("div");
            badge.className = "evo-card-badge";
            badge.setAttribute("data-evo-card-badge", "");
            badge.innerHTML = cardBadgeHTML(s.average, s.count);
            placeCardBadge(card, badge);
          });
        });
      })
      .catch(function () {})
      .then(function () {
        cardBadgeRunning = false;
      });
  }

  // ===========================================================
  // Boot
  // ===========================================================
  /**
   * Walk up from an element until we reach one that spans most of the
   * page, so an inserted section lands in the page's main column
   * rather than inside a narrow product-info panel.
   */
  function fullWidthAncestor(el) {
    var pageWidth = document.documentElement.clientWidth || 0;
    if (!pageWidth) return el;

    var node = el;
    for (var i = 0; i < 8 && node && node.parentElement; i++) {
      var width = 0;
      try {
        width = node.getBoundingClientRect().width;
      } catch (e) {}
      if (width >= pageWidth * 0.9) return node;
      if (node.tagName === "MAIN" || node.tagName === "BODY") return node;
      node = node.parentElement;
    }
    return node || el;
  }

  function mountSections() {
    // Merchant-placed blocks first.
    var placed = document.querySelectorAll("[data-evo-reviews-block]");
    for (var i = 0; i < placed.length; i++) {
      mountSection(
        placed[i],
        placed[i].getAttribute("data-evo-mode") === "store" ? "store" : "product",
        parseInt(placed[i].getAttribute("data-evo-limit"), 10) || 0,
        placed[i].getAttribute("data-evo-scope") || "all"
      );
    }

    // Legacy store-wide section block.
    var legacy = document.querySelectorAll("[data-evo-store-reviews]");
    for (var j = 0; j < legacy.length; j++) {
      mountSection(legacy[j], "store", parseInt(legacy[j].getAttribute("data-limit"), 10) || 0);
    }

    // Automatic placement on a product page, only if the merchant has
    // not placed a product-mode block themselves.
    var placedProduct = document.querySelector('[data-evo-reviews-block][data-evo-mode="product"]');
    if (isProductPage && opts.showGrid && !placedProduct) {
      if (document.querySelector("[data-evo-auto-section]")) return;

      var target = findFirst(gridTarget) || document.querySelector("main") || document.body;

      // The product description usually sits in the narrow right-hand
      // column beside the gallery. Dropping a full review section in
      // there squeezes it — or, in a flex row, pushes the page sideways.
      // Unless the merchant named their own selector, climb out to
      // something close to full width first.
      if (!cfg.gridTarget) target = fullWidthAncestor(target);

      var section = document.createElement("section");
      section.setAttribute("data-evo-auto-section", "");
      if (target.tagName === "MAIN" || target.tagName === "BODY") target.appendChild(section);
      else if (target.parentNode) target.parentNode.insertBefore(section, target.nextSibling);
      else return;
      mountSection(section, "product", 0);
    }
  }

  function init() {
    try { mountBadge(); } catch (e) {}
    try { mountSections(); } catch (e) {}
    try { injectCardBadges(); } catch (e) {}
    watchForNewCards();
  }

  /**
   * Themes that paginate or filter a collection with AJAX replace the
   * grid without a page load. Re-scan when that happens, debounced so
   * a chatty theme cannot turn this into a busy loop.
   */
  function watchForNewCards() {
    var rescan = null;
    try {
      var observer = new MutationObserver(function (mutations) {
        for (var i = 0; i < mutations.length; i++) {
          var added = mutations[i].addedNodes;
          for (var j = 0; j < added.length; j++) {
            var node = added[j];
            if (
              node.nodeType === 1 &&
              node.querySelector &&
              node.querySelector('a[href*="/products/"]')
            ) {
              clearTimeout(rescan);
              rescan = setTimeout(function () {
                try { injectCardBadges(); } catch (e) {}
              }, 150);
              return;
            }
          }
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {}
  }

  function start() {
    configure();
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init);
    } else {
      init();
    }
  }

  // app-embed.liquid kicks off the settings request and hands us the
  // promise, so this script downloads in parallel with it rather than
  // after it. If it fails, or the embed is an older build, the widget
  // still boots — on defaults.
  if (cfg.settingsReady && typeof cfg.settingsReady.then === "function") {
    cfg.settingsReady
      .then(function (resolved) {
        if (resolved) cfg.settings = resolved;
      })
      .catch(function () {})
      .then(start, start);
  } else {
    start();
  }
})();
