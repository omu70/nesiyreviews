// =============================================================
// Vite config — Shopify embedded app (Remix 2)
// File: /vite.config.js
//
// Host-agnostic. On Railway / Fly / Render / Docker this builds a
// standard Remix server that `remix-serve` runs. On Vercel, the
// @vercel/remix preset is loaded automatically (VERCEL=1 is set
// during their build) so the same repo deploys either way.
// =============================================================
import { vitePlugin as remix } from "@remix-run/dev";
import { installGlobals } from "@remix-run/node";
import { defineConfig } from "vite";

installGlobals({ nativeFetch: true });

// The Shopify CLI passes HOST, which breaks the Remix dev server.
// Remap it to SHOPIFY_APP_URL before anything reads it.
// https://github.com/remix-run/remix/issues/2835
if (
  process.env.HOST &&
  (!process.env.SHOPIFY_APP_URL || process.env.SHOPIFY_APP_URL === process.env.HOST)
) {
  process.env.SHOPIFY_APP_URL = process.env.HOST;
  delete process.env.HOST;
}

const host = new URL(process.env.SHOPIFY_APP_URL || "http://localhost").hostname;

const hmrConfig =
  host === "localhost"
    ? { protocol: "ws", host: "localhost", port: 64999, clientPort: 64999 }
    : {
        protocol: "wss",
        host,
        port: parseInt(process.env.FRONTEND_PORT || "8002", 10),
        clientPort: 443,
      };

export default defineConfig(async () => {
  // Only pull in the Vercel preset when actually building on Vercel.
  // Keeps Railway/Fly/Docker builds free of the dependency.
  const presets = [];
  if (process.env.VERCEL) {
    try {
      const { vercelPreset } = await import("@vercel/remix/vite");
      presets.push(vercelPreset());
    } catch {
      console.warn("[vite] VERCEL is set but @vercel/remix is not installed");
    }
  }

  return {
    server: {
      allowedHosts: [host],
      cors: { preflightContinue: true },
      port: Number(process.env.PORT || 3000),
      hmr: hmrConfig,
      fs: { allow: ["app", "node_modules"] },
    },
    plugins: [
      remix({
        presets,
        ignoredRouteFiles: ["**/.*"],
        future: {
          v3_fetcherPersist: true,
          v3_relativeSplatPath: true,
          v3_throwAbortReason: true,
          v3_lazyRouteDiscovery: true,
          v3_singleFetch: false,
        },
      }),
    ],
    // Shopify's CDN + CSP dislike inlined assets.
    build: { assetsInlineLimit: 0 },
    optimizeDeps: { include: ["@shopify/app-bridge-react", "@shopify/polaris"] },
  };
});
