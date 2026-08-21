// =============================================================
// Mandatory privacy compliance webhooks
// File: /app/routes/webhooks.compliance.jsx
//
// Handles all three topics declared under `compliance_topics` in
// shopify.app.toml. Missing or misbehaving handlers here are an
// automatic App Store rejection, and the specific rule reviewers
// test is: an invalid HMAC must produce 401.
//
// authenticate.webhook() gives us exactly that — it throws a 401
// Response on InvalidHmac, 405 on non-POST, 400 otherwise. So the
// correct implementation is to NOT wrap it in a try/catch.
// =============================================================
import { authenticate } from "../shopify.server";
import { guardWebhook, webhookLoader, runOnce } from "../utils/webhook.server";
import { db } from "../db.server";
import { log } from "../utils/log.server";

/**
 * Remove every uploaded photo belonging to a shop.
 *
 * Objects are stored under `<shop-domain>/…`, so the shop's prefix is
 * its own folder. Listing is paged because a busy store can have
 * thousands of photos.
 */
async function purgeShopImages(shop) {
  let removed = 0;
  for (let page = 0; page < 100; page += 1) {
    const { data, error } = await db.storage
      .from("review-images")
      .list(shop, { limit: 100, offset: 0 });

    if (error) {
      log.warn("compliance.image_list_failed", { shop, error });
      return removed;
    }
    if (!data?.length) break;

    const paths = data.map((f) => `${shop}/${f.name}`);
    const { error: removeError } = await db.storage.from("review-images").remove(paths);
    if (removeError) {
      log.warn("compliance.image_remove_failed", { shop, error: removeError });
      return removed;
    }
    removed += paths.length;
    if (data.length < 100) break;
  }
  return removed;
}

export const action = async ({ request }) => {
  const bad = guardWebhook(request);
  if (bad) return bad;

  const { topic, shop, payload } = await authenticate.webhook(request);

  // An unrecognised topic on this endpoint is a routing mistake, not a
  // handler failure — answer before claiming a delivery, so it is not
  // retried as if it were a transient error.
  const KNOWN = ["CUSTOMERS_DATA_REQUEST", "CUSTOMERS_REDACT", "SHOP_REDACT"];
  if (!KNOWN.includes(topic)) {
    log.warn("compliance.unknown_topic", { topic, shop });
    return new Response("Unhandled compliance topic", { status: 404 });
  }

  return runOnce(request, shop, topic, async () => {
    log.info("compliance.received", { topic, shop });

    switch (topic) {
      // ---------------------------------------------------------
      // A customer asked what data we hold on them.
      // Must be actioned within 30 days.
      // ---------------------------------------------------------
      case "CUSTOMERS_DATA_REQUEST": {
        const email = payload?.customer?.email || null;
        const customerId = payload?.customer?.id ? String(payload.customer.id) : null;

        let query = db
          .from("reviews")
          .select(
            "id, product_handle, rating, title, content, author_name, author_email, image_urls, created_at"
          )
          .eq("shop_domain", shop);

        query = email
          ? query.eq("author_email", email)
          : query.eq("shopify_customer_id", customerId);
        const { data, error } = await query;
        if (error) throw error;

        const { error: insertError } = await db.from("compliance_requests").insert({
          shop_domain: shop,
          kind: "data_request",
          shopify_customer_id: customerId,
          customer_email: email,
          payload: { request_id: payload?.data_request?.id ?? null, found: (data || []).length },
          export_data: data || [],
        });
        if (insertError) throw insertError;
        break;
      }

      // ---------------------------------------------------------
      // Erase this customer's personal data. We keep the review body
      // (it belongs to the merchant's store) but strip everything that
      // identifies the person.
      // ---------------------------------------------------------
      case "CUSTOMERS_REDACT": {
        const email = payload?.customer?.email || null;
        const customerId = payload?.customer?.id ? String(payload.customer.id) : null;

        const anonymised = {
          author_name: "Anonymous",
          author_initials: "AN",
          author_email: null,
          author_location: null,
          author_country: null,
          shopify_customer_id: null,
          submitted_ip: null,
        };

        if (email) {
          const { error } = await db
            .from("reviews")
            .update(anonymised)
            .eq("shop_domain", shop)
            .eq("author_email", email);
          if (error) throw error;
        }
        if (customerId) {
          const { error } = await db
            .from("reviews")
            .update(anonymised)
            .eq("shop_domain", shop)
            .eq("shopify_customer_id", customerId);
          if (error) throw error;
        }

        const { error: insertError } = await db.from("compliance_requests").insert({
          shop_domain: shop,
          kind: "customer_redact",
          shopify_customer_id: customerId,
          customer_email: email,
          payload: { orders_to_redact: payload?.orders_to_redact ?? [] },
          completed_at: new Date().toISOString(),
        });
        if (insertError) throw insertError;
        break;
      }

      // ---------------------------------------------------------
      // Sent 48 hours after uninstall. Everything for this shop goes,
      // including the photos in object storage — a database row is not
      // the only copy of a customer's data.
      // ---------------------------------------------------------
      case "SHOP_REDACT": {
        const removedImages = await purgeShopImages(shop);

        const { error: logError } = await db.from("compliance_requests").insert({
          shop_domain: shop,
          kind: "shop_redact",
          payload: { shop_id: payload?.shop_id ?? null, images_removed: removedImages },
          completed_at: new Date().toISOString(),
        });
        if (logError) throw logError;

        // Order matters: children before the parent row.
        for (const step of [
          db.from("reviews").delete().eq("shop_domain", shop),
          db.from("review_aggregates").delete().eq("shop_domain", shop),
          db.from("shop_settings").delete().eq("shop_domain", shop),
          db.from("shopify_sessions").delete().eq("shop", shop),
          db.from("webhook_events").delete().eq("shop_domain", shop),
          db.from("shops").delete().eq("shop_domain", shop),
        ]) {
          const { error } = await step;
          if (error) throw error;
        }

        log.info("compliance.shop_redacted", { shop, removedImages });
        break;
      }

      default:
        break;
    }
  });
};

// GET/HEAD on a webhook endpoint -> 405, per Shopify's spec.
export const loader = webhookLoader;
