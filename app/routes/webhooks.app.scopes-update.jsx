// =============================================================
// app/scopes_update
// File: /app/routes/webhooks.app.scopes-update.jsx
//
// Fires when a merchant grants or revokes an access scope. The stored
// session's `scope` string has to follow, or the SDK will keep
// believing it has a permission it no longer holds.
// =============================================================
import { authenticate } from "../shopify.server";
import { guardWebhook, webhookLoader, runOnce } from "../utils/webhook.server";
import { db } from "../db.server";
import { log } from "../utils/log.server";

export const action = async ({ request }) => {
  const bad = guardWebhook(request);
  if (bad) return bad;

  const { shop, session, topic, payload } = await authenticate.webhook(request);

  return runOnce(request, shop, topic, async () => {
    const current = payload?.current;
    if (!session || !Array.isArray(current)) return;

    const { error } = await db
      .from("shopify_sessions")
      .update({ scope: current.join(",") })
      .eq("id", session.id);
    if (error) throw error;

    log.info("app.scopes_updated", { shop, count: current.length });
  });
};

// GET/HEAD on a webhook endpoint -> 405, per Shopify's spec.
export const loader = webhookLoader;
