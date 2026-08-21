// =============================================================
// Public landing / install entry
// File: /app/routes/_index.jsx
//
// Two jobs:
//  - ?shop=... present  → hand straight to Shopify's login/install
//  - no shop param      → a plain marketing page (a reviewer WILL
//                          load the bare app URL, and a 404 or crash
//                          here is a documented rejection reason)
// =============================================================
import { redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) {
    throw redirect(`/auth/login?${url.searchParams.toString()}`);
  }
  return { showForm: true };
};

export default function Index() {
  const { showForm } = useLoaderData();
  return (
    <div style={{
      fontFamily: "Inter, -apple-system, BlinkMacSystemFont, sans-serif",
      maxWidth: 720, margin: "0 auto", padding: "72px 24px", lineHeight: 1.6,
      color: "#1a1a1a",
    }}>
      <h1 style={{ fontSize: 34, marginBottom: 8 }}>Evo Labs Product Reviews</h1>
      <p style={{ fontSize: 18, color: "#616161", marginTop: 0 }}>
        Product reviews with photos, star badges and collection-page ratings —
        installed from the theme editor, no theme code to edit.
      </p>

      <ul style={{ marginTop: 32, paddingLeft: 20, color: "#333" }}>
        <li>Star rating under every product title and on every product card</li>
        <li>Review grid with photos, pagination and store replies</li>
        <li>Moderation queue — nothing publishes until you approve it</li>
        <li>Import your existing reviews from a CSV</li>
      </ul>

      {showForm ? (
        <form method="get" action="/auth/login" style={{ marginTop: 40 }}>
          <label htmlFor="shop" style={{ display: "block", fontWeight: 600, marginBottom: 6 }}>
            Install on your store
          </label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              id="shop" type="text" name="shop" required
              placeholder="your-store.myshopify.com"
              style={{
                flex: "1 1 280px", padding: "11px 13px", fontSize: 15,
                border: "1px solid #c9cccf", borderRadius: 8,
              }}
            />
            <button type="submit" style={{
              padding: "11px 22px", fontSize: 15, fontWeight: 600, cursor: "pointer",
              background: "#1a1a1a", color: "#fff", border: "none", borderRadius: 8,
            }}>
              Install
            </button>
          </div>
          <p style={{ fontSize: 13, color: "#8a8a8a", marginTop: 10 }}>
            Enter your <code>.myshopify.com</code> domain, not your custom domain.
          </p>
        </form>
      ) : null}

      <p style={{ marginTop: 56, fontSize: 13, color: "#8a8a8a" }}>
        <a href="/privacy" style={{ color: "#5c6ac4" }}>Privacy policy</a>
        {" · "}
        <a href="/support" style={{ color: "#5c6ac4" }}>Support</a>
      </p>
    </div>
  );
}
