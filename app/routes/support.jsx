// =============================================================
// Support page — a support contact is required for submission
// File: /app/routes/support.jsx   →   /support
// =============================================================
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { config } from "../config.server";

export const meta = () => [{ title: "Support — Evo Labs Product Reviews" }];

export const loader = async () => json({ supportEmail: config.supportEmail });

export default function Support() {
  const { supportEmail } = useLoaderData();

  return (
    <main style={{
      fontFamily: "Inter, -apple-system, BlinkMacSystemFont, sans-serif",
      maxWidth: 700, margin: "0 auto", padding: "56px 24px 96px",
      lineHeight: 1.65, color: "#1f2328",
    }}>
      <h1>Support</h1>
      <p>
        Email <a href={`mailto:${supportEmail}`}>{supportEmail}</a> and we reply
        within one business day.
        Include your <code>.myshopify.com</code> domain so we can find your store.
      </p>

      <h2>Common questions</h2>

      <h3>Reviews aren&rsquo;t showing on my storefront</h3>
      <p>
        The widget needs its app embed enabled. In your Shopify admin go to{" "}
        <b>Online Store → Themes → Customize</b>, open <b>App embeds</b>, switch on{" "}
        <b>Reviews</b>, and save. Also check the review is <b>Published</b> — reviews
        from shoppers wait for your approval by default.
      </p>

      <h3>The star rating is in the wrong place</h3>
      <p>
        Most themes are detected automatically. If yours puts it somewhere odd, the
        app embed has two optional fields in the theme editor where you can enter a
        CSS selector for the element it should sit under.
      </p>

      <h3>Can I move reviews from another review app?</h3>
      <p>
        Yes. Export a CSV from your current app and use <b>Import</b> in the Reviews
        app. Original authors and dates are preserved. Imported reviews are not
        marked as verified purchases, because there is no order behind them to check.
      </p>

      <h3>What happens to my reviews if I uninstall?</h3>
      <p>
        Reviews are kept for 48 hours in case you reinstall, then permanently
        deleted along with everything else we hold for your store. Export your
        reviews before uninstalling if you want to keep them.
      </p>

      <h3>Do you charge anything?</h3>
      <p>
        No. The app is free with unlimited reviews. If paid plans are introduced
        later you will be asked to approve any charge before it applies.
      </p>

      <p style={{ marginTop: 48, fontSize: 14, color: "#656d76" }}>
        <a href="/privacy">Privacy policy</a>
      </p>
    </main>
  );
}
