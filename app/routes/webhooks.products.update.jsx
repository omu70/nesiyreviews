// =============================================================
// products/update — keep review→product matching alive across renames
// File: /app/routes/webhooks.products.update.jsx
//
// Reviews are displayed by product handle, because that is what the
// storefront knows on a product page. Handles change when a merchant
// renames a product, and when that happens the reviews silently
// detach — the product page goes to zero reviews and the merchant
// files a support ticket.
//
// The fix is to also store the numeric Shopify product id, which never
// changes, and repoint the handle from it here.
//
// The previous version matched on `product_id`, which in this schema
// holds a *handle*, not an id — so it never matched anything. That is
// why this handler now uses shopify_product_id.
// =============================================================
import { authenticate } from "../shopify.server";
import { guardWebhook, webhookLoader, runOnce } from "../utils/webhook.server";
import { db, idFromGid, safeHandle } from "../db.server";
import { log } from "../utils/log.server";

export const action = async ({ request }) => {
  const bad = guardWebhook(request);
  if (bad) return bad;

  const { shop, topic, payload } = await authenticate.webhook(request);

  return runOnce(request, shop, topic, async () => {
    const handle = safeHandle(payload?.handle);
    const numericId = payload?.id
      ? String(payload.id)
      : idFromGid(payload?.admin_graphql_api_id);

    if (!handle || !numericId) return;

    // A product that was deleted and re-created keeps its reviews
    // usable: clearing product_deleted_at brings them back into the
    // aggregate.
    const { data, error } = await db
      .from("reviews")
      .update({
        product_handle: handle,
        product_id: handle,
        product_deleted_at: null,
      })
      .eq("shop_domain", shop)
      .eq("shopify_product_id", numericId)
      .or(`product_handle.neq.${handle},product_deleted_at.not.is.null`)
      .select("id");

    if (error) throw error;

    if (data?.length) {
      // The aggregate trigger recomputes both the old and the new
      // handle, so the stale badge disappears on its own.
      log.info("product.renamed", { shop, moved: data.length });
    }
  });
};

// GET/HEAD on a webhook endpoint -> 405, per Shopify's spec.
export const loader = webhookLoader;
