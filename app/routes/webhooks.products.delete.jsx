// =============================================================
// products/delete — retire reviews for a product that no longer exists
// File: /app/routes/webhooks.products.delete.jsx
//
// Deleting the reviews outright would be the wrong call. Merchants
// delete and re-create products by accident, and by mistake, and as
// part of migrations; throwing away a year of customer reviews the
// moment a product disappears is not recoverable.
//
// So the reviews are marked instead. A marked review:
//
//   · stops counting towards any product's rating (the aggregate
//     function filters on product_deleted_at)
//   · stops appearing on the storefront
//   · is still visible in the admin, flagged, so the merchant can see
//     what happened
//   · comes back automatically if products/update later reports the
//     same numeric product id
//
// The aggregate trigger fires on product_deleted_at, so the product
// card badge and rating metafields clean themselves up.
// =============================================================
import { authenticate } from "../shopify.server";
import { guardWebhook, webhookLoader, runOnce } from "../utils/webhook.server";
import { db, idFromGid } from "../db.server";
import { log } from "../utils/log.server";

export const action = async ({ request }) => {
  const bad = guardWebhook(request);
  if (bad) return bad;

  const { shop, topic, payload } = await authenticate.webhook(request);

  return runOnce(request, shop, topic, async () => {
    const numericId = payload?.id
      ? String(payload.id)
      : idFromGid(payload?.admin_graphql_api_id);

    if (!numericId) return;

    const { data, error } = await db
      .from("reviews")
      .update({ product_deleted_at: new Date().toISOString() })
      .eq("shop_domain", shop)
      .eq("shopify_product_id", numericId)
      .is("product_deleted_at", null)
      .select("id");

    if (error) throw error;

    if (data?.length) {
      log.info("product.deleted", { shop, reviews_retired: data.length });
    }
  });
};

// GET/HEAD on a webhook endpoint -> 405, per Shopify's spec.
export const loader = webhookLoader;
