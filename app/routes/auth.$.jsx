// =============================================================
// Auth catch-all
// File: /app/routes/auth.$.jsx
//
// With Shopify managed installation + token exchange there is no
// OAuth callback for us to implement — authenticate.admin() handles
// the whole exchange. This route only exists to satisfy the
// redirect_urls declared in shopify.app.toml and to serve the
// exit-iframe / re-auth paths the SDK triggers.
// =============================================================
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};
