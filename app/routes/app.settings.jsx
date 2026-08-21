// =============================================================
// Widget settings
// File: /app/routes/app.settings.jsx
//
// Settings live in Postgres, keyed by shop, and are read by the
// storefront through the app proxy. A merchant configures the widget
// here rather than in theme code (App Store req 5.1.1), and one
// store's settings can never be read or written by another — every
// query below is scoped by the shop on the authenticated session.
// =============================================================
import { json } from "@remix-run/node";
import { useEffect, useMemo, useState } from "react";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  Divider,
  InlineGrid,
  InlineStack,
  Layout,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { dbError } from "../utils/log.server";

const HEX = /^#[0-9a-fA-F]{6}$/;

const BOOLEANS = [
  "auto_approve",
  "show_badge",
  "show_grid",
  "show_card_badges",
  "allow_photos",
  "allow_submissions",
  "show_rating_distribution",
  "show_review_images",
  "require_title",
  "require_email",
  "badge_show_verified_icon",
  "enable_rich_snippets",
  "include_store_reviews_on_product",
];

const ENUMS = {
  layout: ["grid", "list", "carousel"],
  badge_placement: ["title", "price"],
  pagination_style: ["load_more", "pagination"],
  badge_count_format: ["compact", "full"],
  badge_align: ["inherit", "start", "center"],
};

const DISPLAY_PRESETS = ["5", "10", "20", "50"];

const DEFAULTS = {
  auto_approve: false,
  show_badge: true,
  show_grid: true,
  show_card_badges: true,
  allow_photos: true,
  allow_submissions: true,
  show_rating_distribution: true,
  show_review_images: true,
  require_title: false,
  require_email: false,
  badge_show_verified_icon: true,
  enable_rich_snippets: true,
  include_store_reviews_on_product: false,
  accent_color: "#111111",
  star_color: "#FFC107",
  layout: "grid",
  pagination_style: "load_more",
  badge_count_format: "compact",
  badge_align: "center",
  badge_placement: "price",
  reviews_per_page: 10,
  max_photos: 5,
  heading_text: "Customer Reviews",
  empty_text: "No reviews yet. Be the first to share your experience.",
};

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [{ data }, { count: pendingCount }] = await Promise.all([
    db.from("shop_settings").select("*").eq("shop_domain", shop).maybeSingle(),
    db
      .from("reviews")
      .select("id", { count: "exact", head: true })
      .eq("shop_domain", shop)
      .eq("status", "pending"),
  ]);

  return json({
    shop,
    settings: { ...DEFAULTS, ...(data || {}) },
    pendingCount: pendingCount ?? 0,
  });
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();

  const patch = { updated_at: new Date().toISOString() };

  for (const key of BOOLEANS) patch[key] = form.get(key) === "true";

  for (const [key, allowed] of Object.entries(ENUMS)) {
    const value = String(form.get(key) || "");
    if (!allowed.includes(value)) {
      return json({ ok: false, error: `Unsupported value for ${key.replace(/_/g, " ")}` }, { status: 400 });
    }
    patch[key] = value;
  }

  const accent = String(form.get("accent_color") || "").trim();
  const star = String(form.get("star_color") || "").trim();
  if (accent && !HEX.test(accent)) {
    return json({ ok: false, error: "Accent colour must be a hex value like #111111" }, { status: 400 });
  }
  if (star && !HEX.test(star)) {
    return json({ ok: false, error: "Star colour must be a hex value like #FFC107" }, { status: 400 });
  }
  if (accent) patch.accent_color = accent;
  if (star) patch.star_color = star;

  // Validated server-side as well as in the form, because the form is
  // not the only thing that can post here.
  const perPage = parseInt(form.get("reviews_per_page"), 10);
  if (Number.isNaN(perPage) || perPage < 1 || perPage > 100) {
    return json(
      { ok: false, error: "Reviews shown must be a whole number between 1 and 100" },
      { status: 400 }
    );
  }
  patch.reviews_per_page = perPage;

  const maxPhotos = parseInt(form.get("max_photos"), 10);
  if (Number.isNaN(maxPhotos) || maxPhotos < 1 || maxPhotos > 10) {
    return json({ ok: false, error: "Photos per review must be between 1 and 10" }, { status: 400 });
  }
  patch.max_photos = maxPhotos;

  patch.heading_text = String(form.get("heading_text") || DEFAULTS.heading_text).slice(0, 80);
  patch.empty_text = String(form.get("empty_text") || DEFAULTS.empty_text).slice(0, 200);

  const { error } = await db
    .from("shop_settings")
    .upsert({ shop_domain: session.shop, ...patch }, { onConflict: "shop_domain" });

  if (error) {
    return json({ ok: false, error: dbError("settings.save_failed", error, { shop: session.shop }) }, { status: 500 });
  }

  return json({ ok: true, message: "Settings saved" });
};

// -------------------------------------------------------------
// A small preview so a merchant can see the badge they are
// configuring. Rendered from the settings on screen, never persisted,
// and clearly labelled as an example.
// -------------------------------------------------------------
function BadgePreview({ starColor, showVerified, format }) {
  const count = format === "full" ? "1,324" : "1.3K";
  return (
    <InlineStack gap="200" blockAlign="center">
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <path
          d="M12 2.5l2.95 6.4 7.05.7-5.3 4.85 1.55 6.95L12 17.9l-6.25 3.5L7.3 14.45 2 9.6l7.05-.7L12 2.5z"
          fill={starColor}
        />
      </svg>
      <Text as="span" fontWeight="bold">4.7</Text>
      {showVerified ? (
        <svg viewBox="0 0 18 18" width="16" height="16" aria-hidden="true">
          <polygon fill="#005eff" points="9,16 7.1,16.9 5.8,15.2 3.7,15.1 3.4,13 1.5,12 2.2,9.9 1.1,8.2 2.6,6.7 2.4,4.6 4.5,4 5.3,2 7.4,2.4 9,1.1 10.7,2.4 12.7,2 13.6,4 15.6,4.6 15.5,6.7 17,8.2 15.9,9.9 16.5,12 14.7,13 14.3,15.1 12.2,15.2 10.9,16.9" />
          <path
            d="M5.7 9.1l2.2 2.2 4.4-4.6"
            fill="none"
            stroke="#fff"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : null}
      <Text as="span" tone="subdued">{`(${count} Reviews)`}</Text>
    </InlineStack>
  );
}

export default function Settings() {
  const { settings, pendingCount } = useLoaderData();
  const fetcher = useFetcher();
  const busy = fetcher.state !== "idle";

  const [form, setForm] = useState(() => ({
    ...settings,
    reviews_per_page: String(settings.reviews_per_page ?? 10),
    max_photos: String(settings.max_photos ?? 5),
  }));

  const [dirty, setDirty] = useState(false);

  // "10" is a preset; "13" is a custom value. Which one the merchant
  // started with decides whether the number field is shown.
  const [customLimit, setCustomLimit] = useState(
    () => !DISPLAY_PRESETS.includes(String(settings.reviews_per_page ?? 10))
  );

  const set = (key) => (value) => {
    setForm((f) => ({ ...f, [key]: value }));
    setDirty(true);
  };

  useEffect(() => {
    if (fetcher.data?.ok) setDirty(false);
  }, [fetcher.data]);

  const limitError = useMemo(() => {
    const n = parseInt(form.reviews_per_page, 10);
    if (Number.isNaN(n)) return "Enter a number";
    if (n < 1 || n > 100) return "Between 1 and 100";
    return undefined;
  }, [form.reviews_per_page]);

  const colourError = (value) => (value && !HEX.test(value) ? "Use a hex value like #111111" : undefined);

  const canSave =
    dirty &&
    !busy &&
    !limitError &&
    !colourError(form.accent_color) &&
    !colourError(form.star_color);

  const save = () => {
    const fd = new FormData();
    Object.entries(form).forEach(([k, v]) => {
      if (v !== null && v !== undefined) fd.set(k, String(v));
    });
    fetcher.submit(fd, { method: "post" });
  };

  return (
    <Page>
      <TitleBar title="Settings">
        <button variant="primary" onClick={save} disabled={!canSave}>
          {busy ? "Saving…" : "Save"}
        </button>
      </TitleBar>

      <Layout>
        <Layout.Section>
          <BlockStack gap="500">
            {fetcher.data?.ok ? (
              <Banner tone="success" title="Settings saved">
                <Text as="p">Your storefront picks these up within a minute.</Text>
              </Banner>
            ) : null}
            {fetcher.data && fetcher.data.ok === false ? (
              <Banner tone="critical" title="Could not save">
                <Text as="p">{fetcher.data.error}</Text>
              </Banner>
            ) : null}

            {/* ---------- Display ---------- */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  How many reviews to show
                </Text>
                <Text as="p" tone="subdued">
                  Only this many are loaded when the page opens. The rest arrive
                  when a shopper asks for them, so a product with thousands of
                  reviews is no slower than one with ten.
                </Text>

                <InlineStack gap="400" blockAlign="end" wrap>
                  <Box minWidth="220px">
                    <Select
                      label="Reviews displayed initially"
                      options={[
                        { label: "5 reviews", value: "5" },
                        { label: "10 reviews", value: "10" },
                        { label: "20 reviews", value: "20" },
                        { label: "50 reviews", value: "50" },
                        { label: "Custom…", value: "custom" },
                      ]}
                      value={customLimit ? "custom" : String(form.reviews_per_page)}
                      onChange={(value) => {
                        if (value === "custom") {
                          setCustomLimit(true);
                        } else {
                          setCustomLimit(false);
                          set("reviews_per_page")(value);
                        }
                      }}
                    />
                  </Box>
                  {customLimit ? (
                    <Box minWidth="180px">
                      <TextField
                        label="Custom number"
                        type="number"
                        min={1}
                        max={100}
                        value={String(form.reviews_per_page)}
                        onChange={set("reviews_per_page")}
                        error={limitError}
                        autoComplete="off"
                        helpText="1 to 100"
                      />
                    </Box>
                  ) : null}
                  <Box minWidth="220px">
                    <Select
                      label="How shoppers see the rest"
                      options={[
                        { label: "Load more button", value: "load_more" },
                        { label: "Numbered pages", value: "pagination" },
                      ]}
                      value={form.pagination_style}
                      onChange={set("pagination_style")}
                    />
                  </Box>
                </InlineStack>

                <Divider />

                <Checkbox
                  label="Show the star breakdown"
                  helpText="The 5 / 4 / 3 / 2 / 1 bars above the reviews. Shoppers can tap a bar to filter."
                  checked={form.show_rating_distribution}
                  onChange={set("show_rating_distribution")}
                />
                <Checkbox
                  label="Mix store-wide reviews into product pages"
                  helpText={
                    form.include_store_reviews_on_product
                      ? "Reviews about your store appear on every product page. The product page count will be higher than the number on the product card."
                      : "Off is recommended: each product shows only its own reviews, so the count on the product card matches the product page."
                  }
                  checked={form.include_store_reviews_on_product}
                  onChange={set("include_store_reviews_on_product")}
                />
              </BlockStack>
            </Card>

            {/* ---------- Moderation ---------- */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Moderation</Text>
                <Checkbox
                  label="Publish new reviews automatically"
                  helpText={
                    form.auto_approve
                      ? "Reviews from shoppers go live immediately. You can still hide any review afterwards."
                      : "Reviews from shoppers wait in your queue until you approve them. Recommended."
                  }
                  checked={form.auto_approve}
                  onChange={set("auto_approve")}
                />
                {pendingCount > 0 ? (
                  <InlineStack gap="200" blockAlign="center">
                    <Badge tone="attention">{`${pendingCount} pending`}</Badge>
                    <Button variant="plain" url="/app/reviews">Review them now</Button>
                  </InlineStack>
                ) : null}

                <Divider />

                <Checkbox
                  label="Let shoppers write reviews from the storefront"
                  helpText="Turn this off to display existing reviews without accepting new ones."
                  checked={form.allow_submissions}
                  onChange={set("allow_submissions")}
                />
                <Checkbox
                  label="Require a headline"
                  checked={form.require_title}
                  onChange={set("require_title")}
                  disabled={!form.allow_submissions}
                />
                <Checkbox
                  label="Require an email address"
                  helpText="Never shown publicly. Useful if you want to be able to reply directly."
                  checked={form.require_email}
                  onChange={set("require_email")}
                  disabled={!form.allow_submissions}
                />
              </BlockStack>
            </Card>

            {/* ---------- Photos ---------- */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Review photos</Text>
                <Checkbox
                  label="Show photos on the storefront"
                  helpText="Thumbnails under each review, opening in a full-screen viewer."
                  checked={form.show_review_images}
                  onChange={set("show_review_images")}
                />
                <Checkbox
                  label="Let shoppers attach photos"
                  helpText="Photos are resized on the shopper's device before upload and held for approval with the review."
                  checked={form.allow_photos}
                  onChange={set("allow_photos")}
                  disabled={!form.allow_submissions}
                />
                <Box minWidth="200px">
                  <TextField
                    label="Photos per review"
                    type="number"
                    min={1}
                    max={10}
                    value={String(form.max_photos)}
                    onChange={set("max_photos")}
                    disabled={!form.allow_photos}
                    autoComplete="off"
                    helpText="1 to 10"
                  />
                </Box>
              </BlockStack>
            </Card>

            {/* ---------- Placement ---------- */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Where reviews appear</Text>
                <Text as="p" tone="subdued">
                  These control the automatic placement. If you have added the
                  Reviews blocks from the theme editor, those take precedence and
                  appear exactly where you put them.
                </Text>
                <Checkbox
                  label="Star rating on the product page"
                  checked={form.show_badge}
                  onChange={set("show_badge")}
                />
                <Box paddingInlineStart="600" minWidth="260px">
                  <Select
                    label="Place it under"
                    options={[
                      { label: "The product title", value: "title" },
                      { label: "The price", value: "price" },
                    ]}
                    value={form.badge_placement}
                    onChange={set("badge_placement")}
                    disabled={!form.show_badge}
                    helpText="Only affects automatic placement. If you add the Product rating badge block in the theme editor, it appears exactly where you put it."
                  />
                </Box>
                <Checkbox
                  label="Full review section on product pages"
                  checked={form.show_grid}
                  onChange={set("show_grid")}
                />
                <Checkbox
                  label="Star rating on product cards"
                  helpText="Collection pages, search results and related-product rows."
                  checked={form.show_card_badges}
                  onChange={set("show_card_badges")}
                />
              </BlockStack>
            </Card>

            {/* ---------- Badge appearance ---------- */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Rating badge</Text>
                <Box padding="400" background="bg-surface-secondary" borderRadius="200">
                  <BadgePreview
                    starColor={HEX.test(form.star_color) ? form.star_color : "#FFC107"}
                    showVerified={form.badge_show_verified_icon}
                    format={form.badge_count_format}
                  />
                </Box>
                <Checkbox
                  label="Show the review badge icon"
                  helpText="The blue mark beside the rating."
                  checked={form.badge_show_verified_icon}
                  onChange={set("badge_show_verified_icon")}
                />
                <InlineGrid columns={{ xs: 1, sm: 2 }} gap="400">
                  <Select
                    label="Review count format"
                    options={[
                      { label: "Compact — 1.3K Reviews", value: "compact" },
                      { label: "Full — 1,324 Reviews", value: "full" },
                    ]}
                    value={form.badge_count_format}
                    onChange={set("badge_count_format")}
                  />
                  <Select
                    label="Alignment on product cards"
                    options={[
                      { label: "Follow the theme", value: "inherit" },
                      { label: "Left", value: "start" },
                      { label: "Centre", value: "center" },
                    ]}
                    value={form.badge_align}
                    onChange={set("badge_align")}
                  />
                </InlineGrid>
              </BlockStack>
            </Card>

            {/* ---------- Appearance ---------- */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Appearance</Text>
                <InlineGrid columns={{ xs: 1, sm: 3 }} gap="400">
                  <Select
                    label="Layout"
                    options={[
                      { label: "Grid", value: "grid" },
                      { label: "List", value: "list" },
                      { label: "Carousel", value: "carousel" },
                    ]}
                    value={form.layout}
                    onChange={set("layout")}
                  />
                  <TextField
                    label="Accent colour"
                    value={form.accent_color}
                    onChange={set("accent_color")}
                    autoComplete="off"
                    error={colourError(form.accent_color)}
                  />
                  <TextField
                    label="Star colour"
                    value={form.star_color}
                    onChange={set("star_color")}
                    autoComplete="off"
                    error={colourError(form.star_color)}
                  />
                </InlineGrid>
                <TextField
                  label="Section heading"
                  value={form.heading_text}
                  onChange={set("heading_text")}
                  autoComplete="off"
                  maxLength={80}
                />
                <TextField
                  label="Text shown when a product has no reviews"
                  value={form.empty_text}
                  onChange={set("empty_text")}
                  autoComplete="off"
                  maxLength={200}
                />
              </BlockStack>
            </Card>

            {/* ---------- Search results ---------- */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Search results</Text>
                <Checkbox
                  label="Add rating markup for search engines"
                  helpText={
                    "Publishes your real average and review count as structured data, so " +
                    "stars can appear in Google results. Turn this off if your theme already " +
                    "outputs its own rating markup — two sets on one page is worse than none."
                  }
                  checked={form.enable_rich_snippets}
                  onChange={set("enable_rich_snippets")}
                />
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <BlockStack gap="500">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Not showing up?</Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  The widget needs the app embed switched on in your theme, or one
                  of the Reviews blocks added from the theme editor. If a theme
                  puts the automatic placement somewhere awkward, the embed's own
                  settings let you point it at a different element.
                </Text>
                <Button url="/app" variant="plain">Back to setup steps</Button>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">About verified reviews</Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  A review is only marked verified when it can be tied to a real
                  order. Reviews you add by hand, and reviews brought in from a
                  CSV, are never labelled verified — saying otherwise would be
                  misleading to your shoppers and is not permitted.
                </Text>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
