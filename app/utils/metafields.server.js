// =============================================================
// Product rating metafields
// File: /app/utils/metafields.server.js
//
// Writes Shopify's *standard* product review metafields:
//
//   reviews.rating        (type: rating)         → 4.7 out of 1–5
//   reviews.rating_count  (type: number_integer) → 1324
//
// Why bother, when the widget can fetch the numbers itself:
//
//   · The product-badge app block renders them in Liquid, so the
//     rating paints with the page instead of arriving a network
//     round-trip later. That is the difference between zero layout
//     shift and a visible jump.
//   · Themes, the Shop app and Shopify's own surfaces read these two
//     keys. Writing them is the whole reason the app asks for the
//     write_products scope.
//
// Everything here is best-effort. A failed metafield write must never
// fail the merchant's action — the review is already saved, and the
// aggregate row is the source of truth either way.
// =============================================================
import { db } from "../db.server";
import { log } from "./log.server";

const NAMESPACE = "reviews";

// metafieldsSet takes at most 25 metafields per call, and we write two
// per product.
const PRODUCTS_PER_CALL = 12;

const HANDLE_LOOKUP = `#graphql
  query ProductIdsByHandle($query: String!, $first: Int!) {
    products(first: $first, query: $query) {
      nodes { id handle }
    }
  }`;

const SET_METAFIELDS = `#graphql
  mutation SetRatingMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      userErrors { field message }
    }
  }`;

const DELETE_METAFIELDS = `#graphql
  mutation DeleteRatingMetafields($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) {
      userErrors { field message }
    }
  }`;

/**
 * A search term matching any of these handles.
 * Handles are already scrubbed to [a-z0-9._-/] by safeHandle().
 */
function handleQuery(handles) {
  return handles.map((h) => `handle:${h}`).join(" OR ");
}

async function resolveProductIds(admin, handles) {
  const map = new Map();
  for (let i = 0; i < handles.length; i += PRODUCTS_PER_CALL) {
    const slice = handles.slice(i, i + PRODUCTS_PER_CALL);
    try {
      const res = await admin.graphql(HANDLE_LOOKUP, {
        variables: { query: handleQuery(slice), first: slice.length },
      });
      const body = await res.json();
      for (const node of body?.data?.products?.nodes || []) {
        if (node?.handle && node?.id) map.set(node.handle, node.id);
      }
    } catch (error) {
      log.warn("metafields.resolve_failed", { error, count: slice.length });
    }
  }
  return map;
}

/**
 * Push the current aggregate for each handle up to Shopify.
 *
 * @param admin   the GraphQL client from authenticate.admin / unauthenticated.admin
 * @param shop    myshopify domain
 * @param handles product handles whose aggregates changed
 */
export async function syncRatingMetafields(admin, shop, handles) {
  const wanted = Array.from(new Set((handles || []).filter(Boolean))).slice(0, 60);
  if (!admin || !wanted.length) return { synced: 0 };

  const { data: aggregates, error } = await db
    .from("review_aggregates")
    .select("product_handle, average, rating_count")
    .eq("shop_domain", shop)
    .in("product_handle", wanted);

  if (error) {
    log.warn("metafields.aggregate_read_failed", { shop, error });
    return { synced: 0 };
  }

  const byHandle = new Map((aggregates || []).map((a) => [a.product_handle, a]));
  const ids = await resolveProductIds(admin, wanted);

  const toSet = [];
  const toDelete = [];

  for (const handle of wanted) {
    const ownerId = ids.get(handle);
    // The product was deleted, or was never a real handle (a
    // store-wide review, a stale CSV row). Nothing to write.
    if (!ownerId) continue;

    const agg = byHandle.get(handle);
    if (!agg || !agg.rating_count) {
      // Aggregate gone — every review was removed or unapproved.
      // Leaving the metafields behind would keep a rating on a product
      // that no longer has one.
      toDelete.push(
        { ownerId, namespace: NAMESPACE, key: "rating" },
        { ownerId, namespace: NAMESPACE, key: "rating_count" }
      );
      continue;
    }

    toSet.push(
      {
        ownerId,
        namespace: NAMESPACE,
        key: "rating",
        type: "rating",
        value: JSON.stringify({
          scale_min: "1.0",
          scale_max: "5.0",
          value: Number(agg.average).toFixed(1),
        }),
      },
      {
        ownerId,
        namespace: NAMESPACE,
        key: "rating_count",
        type: "number_integer",
        value: String(agg.rating_count),
      }
    );
  }

  let synced = 0;

  for (let i = 0; i < toSet.length; i += 24) {
    const batch = toSet.slice(i, i + 24);
    try {
      const res = await admin.graphql(SET_METAFIELDS, { variables: { metafields: batch } });
      const body = await res.json();
      const errors = body?.data?.metafieldsSet?.userErrors || [];
      if (errors.length) log.warn("metafields.set_user_errors", { shop, errors });
      else synced += batch.length / 2;
    } catch (err) {
      log.warn("metafields.set_failed", { shop, error: err });
    }
  }

  for (let i = 0; i < toDelete.length; i += 24) {
    const batch = toDelete.slice(i, i + 24);
    try {
      await admin.graphql(DELETE_METAFIELDS, { variables: { metafields: batch } });
    } catch (err) {
      log.warn("metafields.delete_failed", { shop, error: err });
    }
  }

  if (synced) {
    await db
      .from("review_aggregates")
      .update({ metafield_synced_at: new Date().toISOString() })
      .eq("shop_domain", shop)
      .in("product_handle", wanted);
  }

  return { synced };
}

/**
 * Fire-and-forget wrapper for request paths where the merchant should
 * not wait on Shopify's API — moderation clicks, CSV imports.
 * Errors are logged, never thrown.
 */
export function syncRatingMetafieldsInBackground(admin, shop, handles) {
  return syncRatingMetafields(admin, shop, handles).catch((error) => {
    log.warn("metafields.background_failed", { shop, error });
    return { synced: 0 };
  });
}
