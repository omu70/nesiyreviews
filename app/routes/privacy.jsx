// =============================================================
// Privacy policy — a public URL is REQUIRED for submission
// File: /app/routes/privacy.jsx   →   /privacy
//
// The operator's identity and contact addresses come from the
// environment, not from placeholders in this file. Production refuses
// to boot without them (see config.server.js), so this page cannot go
// live with "[YOUR LEGAL ENTITY NAME]" still in it.
// =============================================================
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { config } from "../config.server";

const UPDATED = "21 August 2026";

export const meta = ({ data }) => [
  { title: `Privacy Policy — ${data?.appName || "Product Reviews"}` },
];

export const loader = async () =>
  json({
    appName: config.appName,
    legalName: config.legalName,
    legalAddress: config.legalAddress,
    supportEmail: config.supportEmail,
    privacyEmail: config.privacyEmail,
    hostingProvider: config.hostingProvider,
  });

export default function Privacy() {
  const { appName, legalName, legalAddress, supportEmail, privacyEmail, hostingProvider } =
    useLoaderData();

  return (
    <main style={{
      fontFamily: "Inter, -apple-system, BlinkMacSystemFont, sans-serif",
      maxWidth: 760, margin: "0 auto", padding: "56px 24px 96px",
      lineHeight: 1.65, color: "#1f2328",
    }}>
      <h1>Privacy Policy</h1>
      <p style={{ color: "#656d76" }}>Last updated {UPDATED}</p>

      <p>
        This policy explains what {appName} (&ldquo;the app&rdquo;) collects when a
        merchant installs it on a Shopify store, why, and how long it is kept.
        The app is operated by <b>{legalName}</b>, {legalAddress}.
      </p>

      <h2>What we collect</h2>
      <h3>From the merchant&rsquo;s store</h3>
      <ul>
        <li>Store domain and an OAuth access token, so the app can operate</li>
        <li>Product IDs, handles and titles, to attach reviews to the right product</li>
        <li>Widget preferences the merchant sets in the app</li>
      </ul>

      <h3>From shoppers who write a review</h3>
      <ul>
        <li>The name and, where given, the location they choose to display</li>
        <li>Their email address, only when they provide one</li>
        <li>The rating, review text and any photos they attach</li>
        <li>Their IP address, retained for 30 days purely to limit spam submissions</li>
        <li>Their Shopify customer ID, when they are signed in to the store</li>
      </ul>
      <p>
        We do not collect payment details, browsing history, or any data beyond what
        is needed to display and moderate reviews.
      </p>

      <h2>How it is used</h2>
      <p>
        Review content is displayed on the merchant&rsquo;s storefront and in the
        merchant&rsquo;s Shopify admin. We do not sell personal data, share it with
        advertisers, or use it to train models. We do not use it for automated
        decision-making or profiling.
      </p>

      <h2>Where it is stored</h2>
      <p>
        Data is stored in a Supabase-hosted PostgreSQL database and object store,
        encrypted in transit (TLS) and at rest, with encrypted backups. Access
        tokens are held in a table reachable only by the application service role.
        Access is limited to named staff who require it, and access is logged.
      </p>

      <h2>How long we keep it</h2>
      <ul>
        <li><b>Reviews</b> — for as long as the merchant keeps the app installed</li>
        <li><b>Shopper IP addresses</b> — 30 days</li>
        <li><b>Access tokens</b> — deleted immediately on uninstall</li>
        <li>
          <b>Everything else</b> — deleted when Shopify sends the shop redaction
          request, 48 hours after uninstall
        </li>
      </ul>

      <h2>Your rights</h2>
      <p>
        Shoppers can ask the store they reviewed to correct or erase their review.
        We honour Shopify&rsquo;s mandatory data request and redaction webhooks
        automatically: a data request is answered with everything we hold, and a
        redaction request strips the name, email, location and IP from the review
        while leaving the review text with the store it was written for.
      </p>
      <p>
        Requests can also be sent directly to{" "}
        <a href={`mailto:${privacyEmail}`}>{privacyEmail}</a>
        . We respond within 30 days.
      </p>

      <h2>Sub-processors</h2>
      <ul>
        <li><b>Supabase</b> — database and image storage</li>
        <li><b>{hostingProvider}</b> — application hosting</li>
        <li><b>Shopify</b> — the platform the app runs on</li>
      </ul>

      <h2>Changes</h2>
      <p>
        Material changes will be notified to installed merchants by email before
        taking effect.
      </p>

      <h2>Contact</h2>
      <p>
        <a href={`mailto:${supportEmail}`}>{supportEmail}</a>
      </p>
    </main>
  );
}
