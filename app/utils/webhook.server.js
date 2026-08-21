// =============================================================
// Webhook request guards + delivery de-duplication
// File: /app/utils/webhook.server.js
//
// Three things every handler in this app needs:
//
//   1. The right status codes. App Store review explicitly tests that
//      a mandatory compliance webhook returns 401 for an invalid HMAC.
//      authenticate.webhook() covers a WRONG hmac, but a MISSING
//      header falls through as 400 — which fails that test. Shopify
//      also specifies 405 for non-POST.
//
//   2. Idempotency. Shopify retries until it gets a 2xx and can
//      deliver the same event more than once even after one. Every
//      handler claims its delivery id before doing work; a duplicate
//      claim means another delivery already handled it.
//
//   3. Retry-safety. If the handler throws after claiming, the claim
//      is released so Shopify's next attempt can do the work rather
//      than being told it was already done.
// =============================================================
import { db } from "../db.server";
import { log } from "./log.server";

/**
 * Returns a Response to send immediately, or null to continue.
 * Call this before authenticate.webhook() — never after reading the
 * body, since HMAC is computed over the raw bytes.
 */
export function guardWebhook(request) {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  if (!request.headers.get("x-shopify-hmac-sha256")) {
    return new Response("Unauthorized", { status: 401 });
  }
  return null;
}

/** GET/HEAD on a webhook endpoint. */
export const webhookLoader = () => new Response("Method not allowed", { status: 405 });

/**
 * Claim a delivery.
 *
 * @returns true if this process should do the work, false if another
 *          delivery of the same event already has.
 *
 * A database failure here returns true — processing a webhook twice is
 * recoverable (every handler below is written to be), dropping one is
 * not.
 */
export async function claimDelivery(request, shop, topic) {
  const webhookId = request.headers.get("x-shopify-webhook-id");
  if (!webhookId) return { claimed: true, webhookId: null };

  const { error } = await db.from("webhook_events").insert({
    webhook_id: webhookId,
    shop_domain: shop,
    topic,
  });

  if (!error) return { claimed: true, webhookId };

  // 23505 = unique_violation: we have seen this delivery before.
  if (error.code === "23505") {
    log.debug("webhook.duplicate", { shop, topic, webhookId });
    return { claimed: false, webhookId };
  }

  log.warn("webhook.claim_failed", { shop, topic, error });
  return { claimed: true, webhookId: null };
}

/** Mark a claimed delivery as finished. */
export async function completeDelivery(webhookId) {
  if (!webhookId) return;
  await db
    .from("webhook_events")
    .update({ processed_at: new Date().toISOString() })
    .eq("webhook_id", webhookId);
}

/**
 * Release a claim so Shopify's retry can pick the work up again.
 * Called when the handler throws after claiming.
 */
export async function releaseDelivery(webhookId, error) {
  if (!webhookId) return;
  await db.from("webhook_events").delete().eq("webhook_id", webhookId);
  log.error("webhook.handler_failed", { webhookId, error });
}

/**
 * Wrap a handler in claim → run → complete, releasing on failure.
 *
 * Returns 200 in every non-throwing case, including duplicates:
 * telling Shopify "done" for an event we already handled is correct,
 * and a non-2xx would only earn another retry.
 */
export async function runOnce(request, shop, topic, handler) {
  const { claimed, webhookId } = await claimDelivery(request, shop, topic);
  if (!claimed) return new Response(null, { status: 200 });

  try {
    await handler();
    await completeDelivery(webhookId);
    return new Response(null, { status: 200 });
  } catch (error) {
    await releaseDelivery(webhookId, error);
    // 500 asks Shopify to retry. The claim is gone, so the retry runs
    // the handler rather than short-circuiting as a duplicate.
    return new Response("Handler error", { status: 500 });
  }
}
