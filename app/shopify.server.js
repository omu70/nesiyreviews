// =============================================================
// Shopify app singleton
// File: /app/shopify.server.js
// =============================================================

// The Vercel adapter captures a stable `fetch` reference before
// installGlobals() reassigns the global one. On any other host the
// node adapter is correct. Picking the wrong one produces confusing
// "fetch failed" errors deep inside the Shopify SDK.
import "@shopify/shopify-app-remix/adapters/node";

import { ApiVersion, AppDistribution, shopifyApp } from "@shopify/shopify-app-remix/server";
import { SupabaseSessionStorage } from "./session-storage.server";
import { db } from "./db.server";
import { log } from "./utils/log.server";

// Importing config validates every required environment variable and
// throws a listing of what is missing. Doing it here means the failure
// happens at boot, not on a merchant's first request.
import "./config.server";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  appUrl: process.env.SHOPIFY_APP_URL,

  // Keep this in sync with [webhooks] api_version in shopify.app.toml.
  apiVersion: ApiVersion.July26,

  // Scopes come from shopify.app.toml (managed installation). Leaving
  // `scopes` unset here is deliberate — declaring them in both places
  // is how they drift.
  isEmbeddedApp: true,
  distribution: AppDistribution.AppStore,

  sessionStorage: new SupabaseSessionStorage(),

  future: {
    // Required on @shopify/shopify-app-remix v4 to get Shopify managed
    // installation + token exchange. Without it the app falls back to
    // the legacy OAuth redirect dance, which breaks embedded auth when
    // third-party cookies are blocked — an App Store requirement (1.1.1).
    unstable_newEmbeddedAuthStrategy: true,
  },

  hooks: {
    // Runs once per successful install/auth. Idempotent on purpose:
    // reinstalls must not error, and "app doesn't reinstall properly"
    // is one of the most common App Store rejections.
    afterAuth: async ({ session }) => {
      const { error } = await db.from("shops").upsert(
        {
          shop_domain: session.shop,
          is_active: true,
          uninstalled_at: null,
          installed_at: new Date().toISOString(),
        },
        { onConflict: "shop_domain" }
      );
      if (error) log.error("auth.shop_upsert_failed", { shop: session.shop, error });

      // Idempotent: re-registering an existing subscription is a no-op,
      // and a reinstall needs them registered again.
      await shopify.registerWebhooks({ session });
      log.info("auth.installed", { shop: session.shop });
    },
  },
});

export default shopify;
export const apiVersion = ApiVersion.July26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
