// =============================================================
// app/uninstalled
// File: /app/routes/webhooks.app.uninstalled.jsx
//
// Never read the body before authenticate.webhook() — HMAC is computed
// over the RAW body, and consuming the stream first breaks validation.
// =============================================================
import { authenticate } from "../shopify.server";
import { guardWebhook, webhookLoader, runOnce } from "../utils/webhook.server";
import { db } from "../db.server";
import { log } from "../utils/log.server";

export const action = async ({ request }) => {
  const bad = guardWebhook(request);
  if (bad) return bad;

  // Throws 401 on bad HMAC, 405 on non-POST. Do not catch these:
  // returning 401 on an invalid HMAC is an App Store requirement.
  const { shop, topic } = await authenticate.webhook(request);

  return runOnce(request, shop, topic, async () => {
    log.info("app.uninstalled", { shop });

    // Sessions must go, or a reinstall collides with a stale token —
    // the classic "app doesn't reinstall properly" rejection. Deleting
    // by shop rather than by session id also clears any online-access
    // sessions belonging to staff accounts.
    const { error: sessionError } = await db
      .from("shopify_sessions")
      .delete()
      .eq("shop", shop);
    if (sessionError) throw sessionError;

    // Keep review data. The merchant may reinstall, and shop/redact
    // (48h later) is the signal to actually delete.
    const { error: shopError } = await db
      .from("shops")
      .update({ is_active: false, uninstalled_at: new Date().toISOString() })
      .eq("shop_domain", shop);
    if (shopError) throw shopError;
  });
};

// GET/HEAD on a webhook endpoint -> 405, per Shopify's spec.
export const loader = webhookLoader;
