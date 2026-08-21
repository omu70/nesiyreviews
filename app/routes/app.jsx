// =============================================================
// Embedded app shell
// File: /app/routes/app.jsx
//
// authenticate.admin() here is what gates every /app/* page. It also
// performs the token exchange on first load, which is why no OAuth
// callback code is needed anywhere in this repo.
// =============================================================
import { Link, Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { log } from "../utils/log.server";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export const loader = async ({ request }) => {
  // authenticate.admin() is the only thing that decides here.
  //
  // There used to be a hand-rolled guard above this line that redirected
  // to /auth/login when the URL carried no shop, host, id_token or
  // embedded parameter. It looked reasonable and it broke the embedded
  // app: Shopify puts those parameters in the URL only on the *first*
  // load. Once App Bridge takes over, Remix's client-side data requests
  // arrive with the session token in the Authorization header and a
  // bare URL — so the guard fired on every navigation and rendered the
  // shop-domain login form inside Shopify's own iframe.
  //
  // authenticate.admin() reads both the header and the URL, performs the
  // token exchange on first load, and redirects correctly when there is
  // genuinely no session. It does not need help.
  const { session } = await authenticate.admin(request);

  // Make sure the shop + settings rows exist. afterAuth does this on
  // install, but a merchant who installed before a migration ran would
  // otherwise hit a null settings row on every page.
  //
  // Failures are logged rather than swallowed: if the tables are missing
  // entirely, this is where it shows up first, and a silent upsert makes
  // that look like an app bug instead of a setup step.
  const [shopRes, settingsRes] = await Promise.all([
    db.from("shops").upsert(
      { shop_domain: session.shop, is_active: true, install_source: "app" },
      { onConflict: "shop_domain", ignoreDuplicates: true }
    ),
    db.from("shop_settings").upsert(
      { shop_domain: session.shop },
      { onConflict: "shop_domain", ignoreDuplicates: true }
    ),
  ]);

  if (shopRes.error) log.error("app.shop_upsert_failed", { shop: session.shop, error: shopRes.error });
  if (settingsRes.error) {
    log.error("app.settings_upsert_failed", { shop: session.shop, error: settingsRes.error });
  }

  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData();

  return (
    <AppProvider isEmbeddedApp apiKey={apiKey}>
      <NavMenu>
        <Link to="/app" rel="home">Overview</Link>
        <Link to="/app/reviews">Reviews</Link>
        <Link to="/app/import">Import</Link>
        <Link to="/app/settings">Settings</Link>
      </NavMenu>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs these two exports verbatim: the error boundary keeps a
// crash inside the iframe from rendering a bare stack trace, and the
// headers function preserves the document response headers on errors.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
