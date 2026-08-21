// =============================================================
// Environment configuration
// File: /app/config.server.js
//
// Every value the app needs from the environment, validated once at
// boot. Two reasons this exists rather than reading process.env at the
// point of use:
//
//   1. A missing variable becomes a startup failure with a sentence
//      that says what to set, instead of a 500 three days later on a
//      page nobody visits often.
//
//   2. The legal and support details are the ones that get shipped
//      with a placeholder still in them. "[YOUR LEGAL ENTITY NAME]" on
//      a live privacy policy is a documented App Store rejection, and
//      it is invisible in a code review because it looks deliberate.
//      Making production refuse to start without them means that
//      mistake cannot reach a reviewer.
// =============================================================

const isProduction = process.env.NODE_ENV === "production";

// Without these the app cannot function at all, in any environment.
const ALWAYS_REQUIRED = [
  ["SHOPIFY_API_KEY", "Partner Dashboard → your app → Client credentials"],
  ["SHOPIFY_API_SECRET", "Partner Dashboard → your app → Client credentials"],
  ["SHOPIFY_APP_URL", "your public https host, no trailing slash"],
  ["SUPABASE_URL", "https://<project>.supabase.co"],
  ["SUPABASE_SERVICE_ROLE_KEY", "Supabase → Project settings → API → service_role"],
];

// Without these the app runs, but its public pages would show
// placeholders — so they are required in production only, keeping
// local development and CI unblocked.
const REQUIRED_IN_PRODUCTION = [
  ["SUPPORT_EMAIL", "a monitored support address shown on /support"],
  ["LEGAL_ENTITY_NAME", "the company or individual operating the app"],
  ["LEGAL_ENTITY_ADDRESS", "the operator's registered address"],
];

const missing = [];

for (const [name, hint] of ALWAYS_REQUIRED) {
  if (!process.env[name]) missing.push(`${name} — ${hint}`);
}

if (isProduction) {
  for (const [name, hint] of REQUIRED_IN_PRODUCTION) {
    if (!process.env[name]) missing.push(`${name} — ${hint}`);
  }
}

if (missing.length) {
  throw new Error(
    "Missing required environment variables:\n  " +
      missing.join("\n  ") +
      "\n\nSee .env.example. Set these in your host's dashboard before starting the app."
  );
}

function appHost() {
  try {
    return new URL(process.env.SHOPIFY_APP_URL).host;
  } catch {
    return "";
  }
}

export const config = {
  isProduction,

  // The app's public name, shown on the landing page and in the title
  // of every public page. Overridable so the same codebase can be
  // deployed under a different brand without a find-and-replace.
  appName: process.env.APP_NAME || "DiziGroww Customer Review App",

  appUrl: String(process.env.SHOPIFY_APP_URL || "").replace(/\/$/, ""),
  appHost: appHost(),
  appEmbedUuid: process.env.SHOPIFY_APP_EMBED_UUID || "",

  // Fallbacks are development-only: production already refused to boot
  // without the real values.
  supportEmail: process.env.SUPPORT_EMAIL || "support@example.invalid",
  privacyEmail: process.env.PRIVACY_EMAIL || process.env.SUPPORT_EMAIL || "support@example.invalid",
  legalName: process.env.LEGAL_ENTITY_NAME || "(development build — LEGAL_ENTITY_NAME not set)",
  legalAddress: process.env.LEGAL_ENTITY_ADDRESS || "(development build — LEGAL_ENTITY_ADDRESS not set)",
  hostingProvider: process.env.HOSTING_PROVIDER || "our application host",
};
