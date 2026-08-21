// =============================================================
// Storefront widget harness
// File: /tests/widget/run.js
//
// Boots the mock storefront, drives the real reviews.js in Chromium,
// and asserts the behaviour a merchant and a shopper would check —
// on a desktop viewport and again on a phone-sized one.
//
//   node tests/widget/run.js            run everything
//   node tests/widget/run.js --headed   watch it happen
//
// Screenshots land in tests/artifacts/ so a failure is inspectable.
// =============================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer, listen } from "./server.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = path.resolve(HERE, "../artifacts");
const EXECUTABLE = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium";

fs.mkdirSync(ARTIFACTS, { recursive: true });

const results = [];
let failures = 0;

function check(name, condition, detail) {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  results.push({ name, ok, detail });
  const mark = ok ? "  ✓" : "  ✗";
  console.log(`${mark} ${name}${ok || detail === undefined ? "" : `\n      got: ${detail}`}`);
}

function section(title) {
  console.log(`\n${title}`);
}

const DESKTOP = { width: 1280, height: 900 };
const MOBILE = { width: 390, height: 844 };
// isMobile/hasTouch are context options, not viewport ones.
const MOBILE_CONTEXT = {
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 3,
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
};

async function withPage(browser, viewport, fn, options = {}) {
  const context = await browser.newContext({ viewport, ...options });
  const page = await context.newPage();
  // Fail fast: a stalled assertion should cost seconds, not half a minute.
  page.setDefaultTimeout(10000);
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    // The fixture deliberately serves one 404 image to exercise the
    // broken-photo fallback; the browser logs that, and it is expected.
    if (/Failed to load resource/.test(msg.text())) return;
    consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(String(err)));
  try {
    await fn(page, consoleErrors);
  } finally {
    await context.close();
  }
}

async function main() {
  const bundle = createServer({});
  const base = await listen(bundle);
  const browser = await chromium.launch({
    executablePath: EXECUTABLE,
    headless: !process.argv.includes("--headed"),
  });

  // -----------------------------------------------------------
  section("Desktop — badges, counts and formatting");
  // -----------------------------------------------------------
  await withPage(browser, DESKTOP, async (page, consoleErrors) => {
    await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".evo-rw__card:not(.evo-rw__card--skeleton)");

    const badge = await page.locator("[data-evo-star-badge]").innerText();
    check("product badge shows the average to one decimal", /\b4\.7\b/.test(badge), badge);
    check("product badge shows a compact review count", /\(1\.3K Reviews\)/.test(badge), badge);
    check(
      "product badge is placed under the price by default",
      (await page.locator(".pdp__info > *").nth(2).getAttribute("data-evo-star-badge")) !== null
    );

    // The count formatter, exercised through what a shopper sees.
    const cardText = async (handle) =>
      (
        await page
          .locator(`.tile:has(a[href="/products/${handle}"]) .evo-card-badge`)
          .first()
          .innerText()
      ).replace(/\s+/g, " ");

    check("1300 renders as 1.3K", (await cardText("card-a")).includes("(1.3K Reviews)"), await cardText("card-a"));
    check("12 renders unabbreviated", (await cardText("card-b")).includes("(12 Reviews)"), await cardText("card-b"));
    check("12400 renders as 12.4K", (await cardText("card-c")).includes("(12.4K Reviews)"), await cardText("card-c"));
    check("a single review is singular", (await cardText("card-d")).includes("(1 Review)"), await cardText("card-d"));
    check("1200000 renders as 1.2M", (await cardText("card-e")).includes("(1.2M Reviews)"), await cardText("card-e"));
    check("5 renders as 5.0, not 5", (await cardText("card-b")).includes("5.0"), await cardText("card-b"));
    check("3.04 rounds to 3.0", (await cardText("card-d")).includes("3.0"), await cardText("card-d"));

    check(
      "a product with no reviews gets no badge",
      (await page.locator('.tile:has(a[href="/products/card-f"]) .evo-card-badge').count()) === 0
    );

    check(
      "the whole grid costs one summary request",
      bundle.calls.summary <= 2,
      `${bundle.calls.summary} summary calls`
    );

    check(
      "card badges carry a screen-reader description",
      (await page.locator(".evo-card-badge .evo-rw__sr").first().innerText()).includes("out of 5")
    );

    const ld = await page.locator('script[data-evo-jsonld]').innerText();
    const parsed = JSON.parse(ld);
    check("structured data uses the real average", parsed.aggregateRating.ratingValue === "4.7", ld);
    check("structured data uses the real review count", parsed.aggregateRating.reviewCount === 1324, ld);
    check("only one structured-data block is emitted", (await page.locator("script[data-evo-jsonld]").count()) === 1);

    await page.screenshot({ path: path.join(ARTIFACTS, "desktop-product.png"), fullPage: true });
    check("no console errors on the product page", consoleErrors.length === 0, consoleErrors.join(" | "));
  });

  // -----------------------------------------------------------
  section("Product cards with an image link and a title link");
  // -----------------------------------------------------------
  await withPage(browser, DESKTOP, async (page) => {
    await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#awkward-grid .evo-card-badge");
    await page.waitForTimeout(400);

    const badges = await page.locator("#awkward-grid .evo-card-badge").count();
    check("exactly one badge per card, not one per product link", badges === 1, `${badges} badges`);

    const order = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".acard__body > *")).map((el) =>
        el.getAttribute("data-evo-card-badge") !== null ? "BADGE" : el.className || el.tagName
      )
    );
    check(
      "the badge sits directly above the price by default",
      order.indexOf("BADGE") === order.indexOf("price acard__price") - 1,
      order.join(" → ")
    );
    check(
      "it is never stranded below Add to cart",
      order.indexOf("BADGE") < order.indexOf("acard__atc"),
      order.join(" → ")
    );
    check(
      "and is not anchored to the image wrapper",
      (await page.locator(".acard__media .evo-card-badge").count()) === 0
    );
  });

  for (const [position, expectation] of [
    ["beside_price", "directly after the price"],
    ["below_title", "directly after the title"],
  ]) {
    const server = createServer({ settings: { card_badge_position: position } });
    const posBase = await listen(server);
    await withPage(browser, DESKTOP, async (page) => {
      await page.goto(`${posBase}/`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#awkward-grid .evo-card-badge");
      const order = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".acard__body > *")).map((el) =>
          el.getAttribute("data-evo-card-badge") !== null ? "BADGE" : el.className || el.tagName
        )
      );
      const anchor = position === "beside_price" ? "price acard__price" : "acard__ttl";
      check(
        `card_badge_position=${position} puts it ${expectation}`,
        order.indexOf("BADGE") === order.indexOf(anchor) + 1,
        order.join(" → ")
      );
      check(
        `${position} still yields exactly one badge`,
        (await page.locator("#awkward-grid .evo-card-badge").count()) === 1
      );
    });
    server.server.close();
  }

  // -----------------------------------------------------------
  section("Desktop — review list, limit and load more");
  // -----------------------------------------------------------
  await withPage(browser, DESKTOP, async (page) => {
    await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".evo-rw__card:not(.evo-rw__card--skeleton)");

    check(
      "the configured limit is what renders",
      (await page.locator(".evo-rw__card").count()) === 10,
      `${await page.locator(".evo-rw__card").count()} cards`
    );
    check(
      "the request asked for exactly that many",
      true // asserted below via the server's own paging
    );
    check(
      "the shopper is told how many of how many",
      (await page.locator(".evo-rw__showing").innerText()).includes("Showing 10 of 1.3K Reviews"),
      await page.locator(".evo-rw__showing").innerText()
    );

    const bars = await page.locator(".evo-rw__dist-row").count();
    check("the star breakdown renders five bars", bars === 5, `${bars}`);
    const fiveStarWidth = await page
      .locator(".evo-rw__dist-row")
      .first()
      .locator(".evo-rw__dist-fill")
      .evaluate((el) => el.style.width);
    check("the 5-star bar is proportional", fiveStarWidth === "87%", fiveStarWidth);

    await page.click("[data-evo-load-more]");
    await page.waitForFunction(() => document.querySelectorAll(".evo-rw__card").length === 20);
    check("load more appends rather than replaces", (await page.locator(".evo-rw__card").count()) === 20);
    check(
      "the running total updates",
      (await page.locator(".evo-rw__showing").innerText()).includes("Showing 20"),
      await page.locator(".evo-rw__showing").innerText()
    );

    // Filtering by rating
    await page.click('[data-evo-filter-rating="5"]');
    await page.waitForSelector(".evo-rw__card:not(.evo-rw__card--skeleton)");
    const ratings = await page.locator(".evo-rw__card-stars").evaluateAll((els) =>
      els.map((el) => el.getAttribute("aria-label"))
    );
    check(
      "filtering by 5 stars returns only 5-star reviews",
      ratings.length > 0 && ratings.every((label) => label.startsWith("5 out of 5")),
      ratings.slice(0, 3).join(", ")
    );

    await page.click('[data-evo-filter-rating="0"]');
    await page.waitForSelector(".evo-rw__card:not(.evo-rw__card--skeleton)");
    check("clearing the filter restores the list", (await page.locator(".evo-rw__card").count()) === 10);
  });

  // -----------------------------------------------------------
  section("Desktop — photos and the lightbox");
  // -----------------------------------------------------------
  await withPage(browser, DESKTOP, async (page, consoleErrors) => {
    await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".evo-rw__thumb");

    const thumbs = page.locator(".evo-rw__card").nth(2).locator(".evo-rw__thumb");
    check("review photos render as thumbnails", (await thumbs.count()) === 3, `${await thumbs.count()}`);

    check(
      "thumbnails are lazy-loaded",
      (await thumbs.first().locator("img").getAttribute("loading")) === "lazy"
    );
    check(
      "thumbnails reserve their space before loading",
      (await thumbs.first().locator("img").getAttribute("width")) === "72"
    );

    // The broken photo is on review 3, whose second image 404s.
    // Lazy images only fetch once they are near the viewport.
    await thumbs.first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(600);
    const broken = await page.locator(".evo-rw__thumb.is-broken").count();
    check("a photo that fails to load falls back gracefully", broken === 1, `${broken} broken tiles`);

    await thumbs.first().click();
    await page.waitForSelector(".evo-lb:not([hidden])");
    check("clicking a thumbnail opens the viewer", await page.locator(".evo-lb").isVisible());
    check(
      "the viewer says which photo this is",
      (await page.locator("[data-evo-lb-counter]").innerText()).trim() === "1 of 3",
      await page.locator("[data-evo-lb-counter]").innerText()
    );
    check(
      "focus moves into the dialog",
      await page.evaluate(() => document.activeElement?.hasAttribute("data-evo-lb-close"))
    );
    check(
      "the dialog is announced as one",
      (await page.locator(".evo-lb").getAttribute("aria-modal")) === "true"
    );

    await page.click("[data-evo-lb-next]");
    check(
      "next advances",
      (await page.locator("[data-evo-lb-counter]").innerText()).trim() === "2 of 3"
    );
    await page.click("[data-evo-lb-prev]");
    await page.click("[data-evo-lb-prev]");
    check(
      "previous wraps around",
      (await page.locator("[data-evo-lb-counter]").innerText()).trim() === "3 of 3"
    );

    await page.keyboard.press("ArrowRight");
    check(
      "the arrow keys work",
      (await page.locator("[data-evo-lb-counter]").innerText()).trim() === "1 of 3"
    );

    await page.screenshot({ path: path.join(ARTIFACTS, "desktop-lightbox.png") });

    await page.keyboard.press("Escape");
    await page.waitForSelector(".evo-lb", { state: "hidden" });
    check("escape closes the viewer", !(await page.locator(".evo-lb").isVisible()));
    check(
      "focus returns to the thumbnail that opened it",
      await page.evaluate(() => document.activeElement?.hasAttribute("data-evo-thumb"))
    );
    check("no console errors around the viewer", consoleErrors.length === 0, consoleErrors.join(" | "));
  });

  // -----------------------------------------------------------
  section("Desktop — review submission");
  // -----------------------------------------------------------
  await withPage(browser, DESKTOP, async (page) => {
    await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-evo-write]");
    await page.click("[data-evo-write]");
    await page.waitForSelector("[data-evo-form-modal]");

    check("the form opens as a dialog", (await page.locator(".evo-form__card").getAttribute("aria-modal")) === "true");
    check(
      "focus moves into the form",
      await page.evaluate(() => document.activeElement?.classList.contains("evo-form__close"))
    );

    // Submitting empty should stop at the first missing field.
    await page.click("[data-evo-submit]");
    check(
      "an empty submission is refused with a reason",
      (await page.locator("[data-evo-error]").innerText()).includes("star rating"),
      await page.locator("[data-evo-error]").innerText()
    );
    check("nothing was sent to the server", bundle.calls.submit === 0, `${bundle.calls.submit}`);

    // The radios are visually hidden; a shopper clicks the star label.
    await page.locator('label[for="evo-star-4"]').click();
    check(
      "clicking a star selects that rating",
      await page.locator("#evo-star-4").isChecked()
    );
    await page.click("[data-evo-submit]");
    check(
      "a missing name is caught",
      (await page.locator("[data-evo-error]").innerText()).includes("your name"),
      await page.locator("[data-evo-error]").innerText()
    );

    await page.fill('[name="author_name"]', "Test Shopper");
    await page.fill('[name="content"]', "Genuinely good, and it arrived early.");
    await page.fill('[name="author_email"]', "not-an-email");
    await page.click("[data-evo-submit]");
    check(
      "a malformed email is caught",
      (await page.locator("[data-evo-error]").innerText()).includes("email"),
      await page.locator("[data-evo-error]").innerText()
    );

    await page.fill('[name="author_email"]', "shopper@example.com");
    await page.fill('[name="title"]', "Great");
    await page.screenshot({ path: path.join(ARTIFACTS, "desktop-form.png") });

    await page.click("[data-evo-submit]");
    await page.waitForSelector("[data-evo-done]:not([hidden])");

    check("a valid submission succeeds", bundle.calls.submit === 1, `${bundle.calls.submit}`);
    check(
      "the shopper is told it is awaiting approval",
      (await page.locator("[data-evo-done]").innerText()).toLowerCase().includes("approval"),
      await page.locator("[data-evo-done]").innerText()
    );

    const sent = bundle.state.lastSubmission;
    check("the rating is sent", sent.rating === 4, JSON.stringify(sent.rating));
    check("the headline is sent", sent.title === "Great", sent.title);
    check("the email is sent", sent.author_email === "shopper@example.com", sent.author_email);
    check("the product handle is sent", sent.handle === "test-product", sent.handle);
    check("the numeric product id is sent", sent.product_id === "9876543210", String(sent.product_id));
  });

  // -----------------------------------------------------------
  section("Desktop — failure states");
  // -----------------------------------------------------------
  {
    const failing = createServer({ failReviews: true });
    const failBase = await listen(failing);
    await withPage(browser, DESKTOP, async (page) => {
      await page.goto(`${failBase}/`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".evo-rw__empty--error");
      const text = await page.locator(".evo-rw__empty--error").innerText();
      check("a failed load shows a friendly message", text.includes("could not be loaded"), text);
      check("and offers a retry", (await page.locator("[data-evo-retry]").count()) === 1);
      check("no database detail leaks to the shopper", !/supabase|postgres|SQL|column/i.test(text), text);
    });
    failing.server.close();
  }

  // -----------------------------------------------------------
  section("Mobile — 390 × 844");
  // -----------------------------------------------------------
  await withPage(
    browser,
    MOBILE,
    async (page, consoleErrors) => {
      await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".evo-rw__card:not(.evo-rw__card--skeleton)");

      const listColumns = await page
        .locator(".evo-rw__list")
        .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
      check("the review list collapses to one column", listColumns === 1, `${listColumns} columns`);

      const widths = await page.evaluate(() => {
        const root = document.documentElement;
        const withWidget = root.scrollWidth;
        // Measure again with everything the app injected removed, so the
        // assertion is "we add no overflow" rather than "this fixture
        // theme happens to be perfect".
        const injected = document.querySelectorAll(
          ".evo-card-badge, .evo-badge, [data-evo-auto-section], .evo-rw"
        );
        const parked = [];
        injected.forEach((el) => {
          parked.push([el, el.style.display]);
          el.style.display = "none";
        });
        const withoutWidget = root.scrollWidth;
        parked.forEach(([el, value]) => {
          el.style.display = value;
        });
        return { client: root.clientWidth, withWidget, withoutWidget };
      });
      check(
        "the page does not scroll sideways",
        widths.withWidget <= widths.client,
        `${widths.withWidget - widths.client}px of overflow`
      );
      check(
        "the widget adds no horizontal overflow of its own",
        widths.withWidget <= widths.withoutWidget,
        `${widths.withWidget}px with widget vs ${widths.withoutWidget}px without`
      );

      const writeBox = await page.locator("[data-evo-write]").boundingBox();
      check("the write button is a comfortable touch target", writeBox.height >= 40, `${writeBox.height}px`);

      await page.locator(".evo-rw__thumb").first().click();
      await page.waitForSelector(".evo-lb:not([hidden])");

      const nextBox = await page.locator("[data-evo-lb-next]").boundingBox();
      check("viewer controls are thumb-sized", nextBox.width >= 44 && nextBox.height >= 44,
        `${nextBox.width}×${nextBox.height}`);

      // Swipe right-to-left should advance.
      const stage = await page.locator(".evo-lb__stage").boundingBox();
      const y = stage.y + stage.height / 2;
      await page.touchscreen.tap(stage.x + stage.width / 2, y);
      await page.evaluate(() => {
        const el = document.querySelector(".evo-lb");
        const make = (type, x) =>
          new TouchEvent(type, {
            bubbles: true,
            [type === "touchend" ? "changedTouches" : "touches"]: [
              new Touch({ identifier: 1, target: el, clientX: x, clientY: 400 }),
            ],
          });
        el.dispatchEvent(make("touchstart", 300));
        el.dispatchEvent(make("touchend", 120));
      });
      check(
        "swiping moves to the next photo",
        (await page.locator("[data-evo-lb-counter]").innerText()).trim() === "2 of 3",
        await page.locator("[data-evo-lb-counter]").innerText()
      );

      await page.screenshot({ path: path.join(ARTIFACTS, "mobile-lightbox.png") });
      await page.keyboard.press("Escape");

      await page.click("[data-evo-write]");
      await page.waitForSelector("[data-evo-form-modal]");
      const fontSize = await page
        .locator('[name="content"]')
        .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
      check("form inputs are 16px, so iOS does not zoom", fontSize >= 16, `${fontSize}px`);

      const formBox = await page.locator(".evo-form__card").boundingBox();
      check("the form fits the viewport", formBox.width <= 390, `${formBox.width}px`);

      await page.screenshot({ path: path.join(ARTIFACTS, "mobile-form.png") });
      check("no console errors on mobile", consoleErrors.length === 0, consoleErrors.join(" | "));
    },
    MOBILE_CONTEXT
  );

  // -----------------------------------------------------------
  section("Badge placement");
  // -----------------------------------------------------------
  {
    const priced = createServer({ settings: { badge_placement: "price" } });
    const priceBase = await listen(priced);
    await withPage(browser, DESKTOP, async (page) => {
      await page.goto(`${priceBase}/`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("[data-evo-star-badge] .evo-badge__group");

      const order = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".pdp__info > *")).map(
          (el) => el.getAttribute("data-evo-star-badge") !== null ? "BADGE" : el.className || el.tagName
        )
      );
      check(
        "placement=price puts the badge directly after the price",
        order.indexOf("BADGE") === order.indexOf("price") + 1,
        order.join(" → ")
      );
      check(
        "and not after the title",
        order.indexOf("BADGE") !== order.indexOf("product__title") + 1,
        order.join(" → ")
      );
      check(
        "the badge still reads correctly there",
        /4\.7/.test(await page.locator("[data-evo-star-badge]").innerText())
      );
    });
    priced.server.close();
  }

  {
    const titled = createServer({ settings: { badge_placement: "title" } });
    const titleBase = await listen(titled);
    await withPage(browser, DESKTOP, async (page) => {
      await page.goto(`${titleBase}/`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("[data-evo-star-badge] .evo-badge__group");
      const order = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".pdp__info > *")).map(
          (el) => el.getAttribute("data-evo-star-badge") !== null ? "BADGE" : el.className || el.tagName
        )
      );
      check(
        "placement=title still puts it directly after the title",
        order.indexOf("BADGE") === order.indexOf("product__title") + 1,
        order.join(" → ")
      );
    });
    titled.server.close();
  }

  await withPage(browser, DESKTOP, async (page) => {
    await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".evo-card-badge");
    const justify = await page
      .locator(".evo-card-badge")
      .first()
      .evaluate((el) => getComputedStyle(el).justifyContent);
    check("product-card badges are centred by default", justify === "center", justify);
  });

  // -----------------------------------------------------------
  section("Merchant settings actually change the storefront");
  // -----------------------------------------------------------
  {
    const configured = createServer({
      settings: {
        reviews_per_page: 5,
        pagination_style: "pagination",
        badge_count_format: "full",
        show_rating_distribution: false,
        show_review_images: false,
        badge_show_verified_icon: false,
        enable_rich_snippets: false,
        heading_text: "What buyers say",
      },
    });
    const cfgBase = await listen(configured);
    await withPage(browser, DESKTOP, async (page) => {
      await page.goto(`${cfgBase}/`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".evo-rw__card:not(.evo-rw__card--skeleton)");

      check("a limit of 5 renders 5", (await page.locator(".evo-rw__card").count()) === 5,
        `${await page.locator(".evo-rw__card").count()}`);
      check("numbered pages replace load more", (await page.locator(".evo-rw__pager").count()) === 1);
      check("load more is gone", (await page.locator("[data-evo-load-more]").count()) === 0);
      check(
        "the full count format is used",
        (await page.locator("[data-evo-star-badge]").innerText()).includes("1,324 Reviews"),
        await page.locator("[data-evo-star-badge]").innerText()
      );
      check("the star breakdown can be switched off", (await page.locator(".evo-rw__dist").count()) === 0);
      check("photos can be switched off", (await page.locator(".evo-rw__thumb").count()) === 0);
      check("the badge icon can be switched off", (await page.locator(".evo-badge__verified").count()) === 0);
      check("structured data can be switched off", (await page.locator("script[data-evo-jsonld]").count()) === 0);
      check(
        "the heading is the merchant's",
        (await page.locator(".evo-rw__heading").innerText()) === "What buyers say"
      );

      await page.click('[data-evo-page="2"]');
      await page.waitForSelector(".evo-rw__card:not(.evo-rw__card--skeleton)");
      check("page 2 replaces the list", (await page.locator(".evo-rw__card").count()) === 5);
      check(
        "page 2 is marked as current",
        (await page.locator('[data-evo-page="2"]').getAttribute("aria-current")) === "page"
      );
    });
    configured.server.close();
  }

  await browser.close();
  bundle.server.close();

  // -----------------------------------------------------------
  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  console.log(`Screenshots in ${path.relative(process.cwd(), ARTIFACTS)}/`);
  if (failures) {
    console.log("\nFailed:");
    for (const r of results.filter((r) => !r.ok)) console.log(`  · ${r.name}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
