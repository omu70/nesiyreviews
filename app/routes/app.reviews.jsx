// =============================================================
// Moderation queue + manual entry
// File: /app/routes/app.reviews.jsx
//
// App Store req 5.1.5: data collected on the storefront must be
// visible to the merchant in the Shopify admin. This page is that,
// and it is also where every review's status is decided.
//
// Tenant isolation note: every read and every write below is filtered
// by `shop_domain` taken from the authenticated session, in addition
// to the row id. A forged id from another store matches nothing.
// =============================================================
import { json } from "@remix-run/node";
import { useEffect, useState } from "react";
import { useFetcher, useLoaderData, useSearchParams } from "@remix-run/react";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  Card,
  EmptyState,
  InlineStack,
  Layout,
  Modal,
  Page,
  Pagination,
  Select,
  Text,
  TextField,
  Thumbnail,
  Tooltip,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { db, ADMIN_COLS, initialsOf, safeHandle, publicImages, SUPABASE_URL } from "../db.server";
import { log, dbError } from "../utils/log.server";
import { syncRatingMetafieldsInBackground } from "../utils/metafields.server";

const PAGE_SIZE = 20;
const STATUSES = ["approved", "pending", "hidden", "rejected"];
const STORAGE_PREFIX = `${SUPABASE_URL}/storage/v1/object/public/review-images/`;

/** PostgREST `or=` is comma and paren delimited; scrub anything that could break out. */
function safeSearch(value) {
  return String(value || "")
    .replace(/[,()%*\\]/g, " ")
    .trim()
    .slice(0, 80);
}

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);

  const status = url.searchParams.get("status") || "pending";
  const product = safeHandle(url.searchParams.get("product"));
  const search = safeSearch(url.searchParams.get("q"));
  const rating = parseInt(url.searchParams.get("rating") || "", 10);
  const photos = url.searchParams.get("photos") || "";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const from = (page - 1) * PAGE_SIZE;

  let q = db.from("reviews").select(ADMIN_COLS, { count: "exact" }).eq("shop_domain", shop);

  if (status === "rejected") q = q.in("status", ["rejected", "hidden"]);
  else if (status !== "all") q = q.eq("status", status);

  if (product) q = q.or(`product_handle.eq.${product},product_id.eq.${product}`);
  if (search) q = q.or(`content.ilike.%${search}%,author_name.ilike.%${search}%,title.ilike.%${search}%`);
  if (rating >= 1 && rating <= 5) q = q.eq("rating", rating);
  if (photos === "with") q = q.eq("has_images", true);
  if (photos === "without") q = q.eq("has_images", false);

  const [rows, pending] = await Promise.all([
    q.order("created_at", { ascending: false }).range(from, from + PAGE_SIZE - 1),
    db
      .from("reviews")
      .select("id", { count: "exact", head: true })
      .eq("shop_domain", shop)
      .eq("status", "pending"),
  ]);

  if (rows.error) log.warn("admin.reviews_query_failed", { shop, error: rows.error });

  return json({
    reviews: (rows.data || []).map((r) => ({ ...r, images: publicImages(r) })),
    total: rows.count ?? 0,
    page,
    pageSize: PAGE_SIZE,
    pendingCount: pending.count ?? 0,
    filters: {
      status,
      product: product || "",
      q: search,
      rating: rating >= 1 && rating <= 5 ? String(rating) : "",
      photos,
    },
  });
};

/**
 * Delete a review's photos from storage as well as its row.
 *
 * Object storage is not covered by a database delete, and a shopper's
 * photo outliving the review it belonged to is exactly the kind of
 * orphaned personal data a privacy review asks about.
 */
async function removeImages(rows) {
  const paths = [];
  for (const row of rows || []) {
    const urls = []
      .concat(Array.isArray(row.image_urls) ? row.image_urls : [])
      .concat((Array.isArray(row.image_meta) ? row.image_meta : []).map((m) => m && m.thumb));
    for (const url of urls) {
      if (typeof url === "string" && url.startsWith(STORAGE_PREFIX)) {
        paths.push(decodeURIComponent(url.slice(STORAGE_PREFIX.length)));
      }
    }
  }
  if (!paths.length) return;
  const { error } = await db.storage.from("review-images").remove(Array.from(new Set(paths)));
  if (error) log.warn("admin.image_delete_failed", { error, count: paths.length });
}

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = form.get("intent");

  const idsFrom = (field) =>
    String(form.get(field) || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 200);

  try {
    if (intent === "setStatus") {
      const status = String(form.get("status"));
      if (!STATUSES.includes(status)) {
        return json({ ok: false, error: "Unknown status" }, { status: 400 });
      }
      const ids = idsFrom("ids");
      if (!ids.length) return json({ ok: false, error: "Nothing selected" }, { status: 400 });

      const { data, error } = await db
        .from("reviews")
        .update({ status })
        .eq("shop_domain", shop)
        .in("id", ids)
        .select("product_handle");
      if (error) throw error;

      // Publishing or hiding a review changes the product's rating, so
      // the metafields the theme reads have to follow.
      syncRatingMetafieldsInBackground(
        admin,
        shop,
        (data || []).map((r) => r.product_handle)
      );

      const n = data?.length ?? 0;
      return json({
        ok: true,
        message: `${n} review${n === 1 ? "" : "s"} ${status === "approved" ? "published" : status}`,
      });
    }

    if (intent === "delete") {
      const ids = idsFrom("ids");
      if (!ids.length) return json({ ok: false, error: "Nothing selected" }, { status: 400 });

      // Read the photo URLs before the rows go, or they are unreachable.
      const { data: doomed } = await db
        .from("reviews")
        .select("product_handle, image_urls, image_meta")
        .eq("shop_domain", shop)
        .in("id", ids);

      const { error } = await db.from("reviews").delete().eq("shop_domain", shop).in("id", ids);
      if (error) throw error;

      await removeImages(doomed);
      syncRatingMetafieldsInBackground(
        admin,
        shop,
        (doomed || []).map((r) => r.product_handle)
      );

      return json({ ok: true, message: `${ids.length} deleted` });
    }

    if (intent === "feature") {
      const { error } = await db
        .from("reviews")
        .update({ is_featured: form.get("value") === "true" })
        .eq("shop_domain", shop)
        .eq("id", form.get("id"));
      if (error) throw error;
      return json({ ok: true, message: "Updated" });
    }

    if (intent === "reply") {
      const text = String(form.get("reply") || "").trim().slice(0, 2000);
      const { error } = await db
        .from("reviews")
        .update({ reply: text || null, reply_at: text ? new Date().toISOString() : null })
        .eq("shop_domain", shop)
        .eq("id", form.get("id"));
      if (error) throw error;
      return json({ ok: true, message: text ? "Reply published" : "Reply removed" });
    }

    if (intent === "create") {
      const author = String(form.get("author_name") || "").trim();
      const content = String(form.get("content") || "").trim();
      const rating = parseInt(form.get("rating"), 10);

      if (!author) return json({ ok: false, error: "Add the customer's name" }, { status: 400 });
      if (!content) return json({ ok: false, error: "Add the review text" }, { status: 400 });
      if (Number.isNaN(rating) || rating < 1 || rating > 5) {
        return json({ ok: false, error: "Rating must be between 1 and 5" }, { status: 400 });
      }

      const handle = safeHandle(form.get("product_handle"));
      const dateStr = String(form.get("created_at") || "");
      const when = dateStr ? new Date(dateStr) : null;
      if (when && Number.isNaN(when.getTime())) {
        return json({ ok: false, error: "That date is not valid" }, { status: 400 });
      }

      const { error } = await db.from("reviews").insert({
        shop_domain: shop,
        product_id: handle,
        product_handle: handle,
        author_name: author.slice(0, 80),
        author_initials: initialsOf(author),
        author_location: String(form.get("author_location") || "").trim().slice(0, 80) || null,
        rating,
        title: String(form.get("title") || "").trim().slice(0, 120) || null,
        content: content.slice(0, 4000),
        status: "approved",
        source: "manual",
        // Never claim a manually entered review is order-verified.
        is_verified: false,
        app_verification_status: "not_verified",
        ...(when ? { created_at: when.toISOString() } : {}),
      });
      if (error) throw error;

      syncRatingMetafieldsInBackground(admin, shop, [handle]);
      return json({ ok: true, message: "Review added" });
    }

    return json({ ok: false, error: "Unknown action" }, { status: 400 });
  } catch (error) {
    return json({ ok: false, error: dbError("admin.review_action_failed", error, { shop, intent }) }, { status: 500 });
  }
};

const STARS = (n) => "★★★★★".slice(0, n) + "☆☆☆☆☆".slice(0, 5 - n);
const TONE = { approved: "success", pending: "attention", rejected: "critical", hidden: undefined };
const LABEL = { approved: "published", pending: "pending", rejected: "rejected", hidden: "hidden" };

export default function Reviews() {
  const { reviews, total, page, pageSize, pendingCount, filters } = useLoaderData();
  const [params, setParams] = useSearchParams();
  const fetcher = useFetcher();

  const [selected, setSelected] = useState([]);
  const [search, setSearch] = useState(filters.q);
  const [addOpen, setAddOpen] = useState(false);
  const [replyFor, setReplyFor] = useState(null);
  const [viewing, setViewing] = useState(null); // { review, index }
  const [toast, setToast] = useState("");

  const busy = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data?.message) {
      setToast(fetcher.data.message);
      setSelected([]);
    } else if (fetcher.data?.error) {
      setToast(fetcher.data.error);
    }
  }, [fetcher.data]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const setParam = (key, value) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete("page");
    setParams(next);
  };

  const goToPage = (n) => {
    const next = new URLSearchParams(params);
    next.set("page", String(n));
    setParams(next);
  };

  const submit = (fields) => fetcher.submit(fields, { method: "post" });
  const bulk = (status) => submit({ intent: "setStatus", status, ids: selected.join(",") });
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const anyFilter = filters.q || filters.rating || filters.photos || filters.product;

  return (
    <Page>
      <TitleBar title="Reviews">
        <button variant="primary" onClick={() => setAddOpen(true)}>
          Add review
        </button>
      </TitleBar>

      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {toast ? (
              <Card>
                <Text as="p" tone={fetcher.data?.ok === false ? "critical" : "success"}>
                  {toast}
                </Text>
              </Card>
            ) : null}

            <Card padding="0">
              <Box padding="300" borderBlockEndWidth="025" borderColor="border">
                <InlineStack gap="300" blockAlign="center" wrap>
                  <Select
                    label="Status"
                    labelHidden
                    options={[
                      { label: `Pending${pendingCount ? ` (${pendingCount})` : ""}`, value: "pending" },
                      { label: "Published", value: "approved" },
                      { label: "Rejected or hidden", value: "rejected" },
                      { label: "All", value: "all" },
                    ]}
                    value={filters.status}
                    onChange={(v) => setParam("status", v === "pending" ? "" : v)}
                  />
                  <Select
                    label="Rating"
                    labelHidden
                    options={[
                      { label: "Any rating", value: "" },
                      { label: "5 stars", value: "5" },
                      { label: "4 stars", value: "4" },
                      { label: "3 stars", value: "3" },
                      { label: "2 stars", value: "2" },
                      { label: "1 star", value: "1" },
                    ]}
                    value={filters.rating}
                    onChange={(v) => setParam("rating", v)}
                  />
                  <Select
                    label="Photos"
                    labelHidden
                    options={[
                      { label: "Photos: any", value: "" },
                      { label: "With photos", value: "with" },
                      { label: "Without photos", value: "without" },
                    ]}
                    value={filters.photos}
                    onChange={(v) => setParam("photos", v)}
                  />
                  <Box minWidth="220px">
                    <TextField
                      label="Search"
                      labelHidden
                      placeholder="Search text, name or headline"
                      value={search}
                      onChange={setSearch}
                      onBlur={() => setParam("q", search)}
                      clearButton
                      onClearButtonClick={() => {
                        setSearch("");
                        setParam("q", "");
                      }}
                      autoComplete="off"
                    />
                  </Box>
                  {filters.product ? (
                    <InlineStack gap="150" blockAlign="center">
                      <Badge tone="info">{`Product: ${filters.product}`}</Badge>
                      <Button variant="plain" onClick={() => setParam("product", "")}>
                        Clear
                      </Button>
                    </InlineStack>
                  ) : null}
                </InlineStack>
              </Box>

              {selected.length > 0 ? (
                <Box padding="300" background="bg-surface-secondary">
                  <InlineStack gap="200" blockAlign="center" wrap>
                    <Text as="span" fontWeight="semibold">{`${selected.length} selected`}</Text>
                    <Button size="slim" loading={busy} onClick={() => bulk("approved")}>
                      Approve
                    </Button>
                    <Button size="slim" loading={busy} onClick={() => bulk("rejected")}>
                      Reject
                    </Button>
                    <Button size="slim" loading={busy} onClick={() => bulk("pending")}>
                      Back to pending
                    </Button>
                    <Button
                      size="slim"
                      tone="critical"
                      loading={busy}
                      onClick={() => submit({ intent: "delete", ids: selected.join(",") })}
                    >
                      Delete
                    </Button>
                    <Button size="slim" variant="plain" onClick={() => setSelected([])}>
                      Clear
                    </Button>
                  </InlineStack>
                </Box>
              ) : null}

              {reviews.length === 0 ? (
                <Box padding="600">
                  <EmptyState
                    heading={
                      anyFilter
                        ? "No reviews match those filters"
                        : filters.status === "pending"
                          ? "Nothing waiting for approval"
                          : "No reviews here yet"
                    }
                    image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                    action={
                      anyFilter
                        ? { content: "Clear filters", onAction: () => setParams(new URLSearchParams()) }
                        : { content: "Import from CSV", url: "/app/import" }
                    }
                    secondaryAction={{ content: "Add manually", onAction: () => setAddOpen(true) }}
                  >
                    <p>
                      Reviews left by shoppers appear here for approval before they
                      show on your storefront.
                    </p>
                  </EmptyState>
                </Box>
              ) : (
                <BlockStack gap="0">
                  {reviews.map((r) => (
                    <Box key={r.id} padding="400" borderBlockEndWidth="025" borderColor="border">
                      <BlockStack gap="200">
                        <InlineStack gap="200" blockAlign="center" wrap>
                          <input
                            type="checkbox"
                            checked={selected.includes(r.id)}
                            onChange={(e) =>
                              setSelected((s) =>
                                e.target.checked ? [...s, r.id] : s.filter((x) => x !== r.id)
                              )
                            }
                            aria-label={`Select the review by ${r.author_name}`}
                          />
                          <Text as="span" fontWeight="semibold">
                            {r.author_name}
                          </Text>
                          <Tooltip content={`${r.rating} out of 5`}>
                            <Text as="span" tone="caution">
                              {STARS(r.rating)}
                            </Text>
                          </Tooltip>
                          <Badge tone={TONE[r.status]}>{LABEL[r.status] || r.status}</Badge>
                          {r.is_featured ? <Badge tone="info">featured</Badge> : null}
                          {r.images.length ? (
                            <Badge>{`${r.images.length} photo${r.images.length > 1 ? "s" : ""}`}</Badge>
                          ) : null}
                          {r.product_deleted_at ? (
                            <Tooltip content="This product no longer exists in your store, so the review is not counted or shown.">
                              <Badge tone="warning">product deleted</Badge>
                            </Tooltip>
                          ) : null}
                          {r.product_handle ? (
                            <Text as="span" variant="bodySm" tone="subdued">
                              {r.product_handle}
                            </Text>
                          ) : (
                            <Text as="span" variant="bodySm" tone="subdued">
                              store-wide
                            </Text>
                          )}
                          <Box width="100%" />
                          <Text as="span" variant="bodySm" tone="subdued">
                            {new Date(r.created_at).toLocaleDateString()}
                            {r.author_location ? ` · ${r.author_location}` : ""}
                            {r.author_email ? ` · ${r.author_email}` : ""}
                            {` · ${String(r.source || "").replace(/_/g, " ")}`}
                          </Text>
                        </InlineStack>

                        {r.title ? (
                          <Text as="p" fontWeight="semibold">
                            {r.title}
                          </Text>
                        ) : null}
                        <Text as="p">{r.content}</Text>

                        {r.images.length ? (
                          <InlineStack gap="200">
                            {r.images.slice(0, 6).map((img, i) => (
                              <button
                                key={i}
                                type="button"
                                onClick={() => setViewing({ review: r, index: i })}
                                style={{ border: 0, background: "none", padding: 0, cursor: "zoom-in" }}
                                aria-label={`Open photo ${i + 1} from the review by ${r.author_name}`}
                              >
                                <Thumbnail source={img.thumb || img.url} alt="" size="small" />
                              </button>
                            ))}
                          </InlineStack>
                        ) : null}

                        {r.reply ? (
                          <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                            <Text as="p" variant="bodySm">
                              <b>Your reply:</b> {r.reply}
                            </Text>
                          </Box>
                        ) : null}

                        <InlineStack gap="200" wrap>
                          {r.status !== "approved" ? (
                            <Button
                              size="slim"
                              variant="primary"
                              loading={busy}
                              onClick={() => submit({ intent: "setStatus", status: "approved", ids: r.id })}
                            >
                              Approve
                            </Button>
                          ) : null}
                          {r.status !== "rejected" && r.status !== "hidden" ? (
                            <Button
                              size="slim"
                              loading={busy}
                              onClick={() => submit({ intent: "setStatus", status: "rejected", ids: r.id })}
                            >
                              Reject
                            </Button>
                          ) : null}
                          <Button
                            size="slim"
                            loading={busy}
                            onClick={() =>
                              submit({ intent: "feature", id: r.id, value: String(!r.is_featured) })
                            }
                          >
                            {r.is_featured ? "Unfeature" : "Feature"}
                          </Button>
                          <Button size="slim" onClick={() => setReplyFor(r)}>
                            {r.reply ? "Edit reply" : "Reply"}
                          </Button>
                          <Button
                            size="slim"
                            tone="critical"
                            variant="plain"
                            loading={busy}
                            onClick={() => submit({ intent: "delete", ids: r.id })}
                          >
                            Delete
                          </Button>
                        </InlineStack>
                      </BlockStack>
                    </Box>
                  ))}
                </BlockStack>
              )}

              {totalPages > 1 ? (
                <Box padding="300">
                  <InlineStack align="center">
                    <Pagination
                      hasPrevious={page > 1}
                      onPrevious={() => goToPage(page - 1)}
                      hasNext={page < totalPages}
                      onNext={() => goToPage(page + 1)}
                      label={`Page ${page} of ${totalPages} · ${total.toLocaleString()} reviews`}
                    />
                  </InlineStack>
                </Box>
              ) : null}
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>

      {/* ---- Photo viewer ---- */}
      <Modal
        open={Boolean(viewing)}
        onClose={() => setViewing(null)}
        title={viewing ? `Photo from ${viewing.review.author_name}` : ""}
        primaryAction={{ content: "Close", onAction: () => setViewing(null) }}
        secondaryActions={
          viewing && viewing.review.images.length > 1
            ? [
                {
                  content: "Previous",
                  onAction: () =>
                    setViewing((v) => ({
                      ...v,
                      index: (v.index - 1 + v.review.images.length) % v.review.images.length,
                    })),
                },
                {
                  content: "Next",
                  onAction: () =>
                    setViewing((v) => ({ ...v, index: (v.index + 1) % v.review.images.length })),
                },
              ]
            : []
        }
      >
        <Modal.Section>
          {viewing ? (
            <BlockStack gap="200" inlineAlign="center">
              <img
                src={viewing.review.images[viewing.index]?.url}
                alt={`Review photo ${viewing.index + 1}`}
                style={{ maxWidth: "100%", maxHeight: "60vh", objectFit: "contain" }}
              />
              <Text as="p" variant="bodySm" tone="subdued">
                {`${viewing.index + 1} of ${viewing.review.images.length}`}
              </Text>
            </BlockStack>
          ) : null}
        </Modal.Section>
      </Modal>

      {/* ---- Reply ---- */}
      <Modal
        open={Boolean(replyFor)}
        onClose={() => setReplyFor(null)}
        title={replyFor ? `Reply to ${replyFor.author_name}` : ""}
        primaryAction={{
          content: "Publish reply",
          loading: busy,
          onAction: () => {
            submit({ intent: "reply", id: replyFor.id, reply: replyFor.reply || "" });
            setReplyFor(null);
          },
        }}
        secondaryActions={[{ content: "Cancel", onAction: () => setReplyFor(null) }]}
      >
        <Modal.Section>
          <TextField
            label="Your reply"
            multiline={4}
            autoComplete="off"
            maxLength={2000}
            helpText="Shown publicly under the review on your storefront."
            value={replyFor?.reply || ""}
            onChange={(v) => setReplyFor((r) => ({ ...r, reply: v }))}
          />
        </Modal.Section>
      </Modal>

      {/* ---- Add review ---- */}
      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add a review"
        primaryAction={{
          content: "Add review",
          loading: busy,
          onAction: () => {
            const f = document.getElementById("evo-add-review-form");
            const fd = new FormData(f);
            fd.set("intent", "create");
            fetcher.submit(fd, { method: "post" });
            setAddOpen(false);
          },
        }}
        secondaryActions={[{ content: "Cancel", onAction: () => setAddOpen(false) }]}
      >
        <Modal.Section>
          <form id="evo-add-review-form">
            <BlockStack gap="300">
              <Text as="p" variant="bodySm" tone="subdued">
                Use this for reviews a customer sent you directly — by email, or on
                a card in the box. Enter their real words and their real name.
                Reviews added here are never marked as verified purchases.
              </Text>
              <InlineStack gap="300" wrap>
                <Box minWidth="200px">
                  <TextField label="Customer name" name="author_name" autoComplete="off" requiredIndicator />
                </Box>
                <Box minWidth="180px">
                  <TextField
                    label="Location"
                    name="author_location"
                    autoComplete="off"
                    placeholder="Mumbai, India"
                  />
                </Box>
              </InlineStack>
              <InlineStack gap="300" wrap>
                <Box minWidth="120px">
                  <Select label="Rating" name="rating" options={["5", "4", "3", "2", "1"]} />
                </Box>
                <Box minWidth="220px">
                  <TextField
                    label="Product handle"
                    name="product_handle"
                    autoComplete="off"
                    placeholder="woodfire-pillar"
                    helpText="From the product URL. Leave blank for a store-wide review."
                  />
                </Box>
                <Box minWidth="160px">
                  <TextField label="Date" name="created_at" type="date" autoComplete="off" />
                </Box>
              </InlineStack>
              <TextField label="Headline" name="title" autoComplete="off" placeholder="Loved it" />
              <TextField label="Review" name="content" multiline={4} autoComplete="off" requiredIndicator />
            </BlockStack>
          </form>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
