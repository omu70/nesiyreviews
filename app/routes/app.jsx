// =============================================================
// Embedded app shell
// File: /app/routes/app.jsx
//
// authenticate.admin() here is what gates every /app/* page. It also
// performs the token exchange on first load, which is why no OAuth
// callback code is needed anywhere in this repo.
// =============================================================
import { redirect } from "@remix-run/node";
import { Link, Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export const loader = async ({ request }) => {
  // Shopify always loads embedded apps with ?shop= and ?host=. Someone
  // arriving without them (a bookmarked URL, a reviewer poking around)
  // would otherwise get a bare 410 "Handling response" page, which reads
  // as a broken app under App Store req 2.1.2. Send them to the login
  // form instead.
  const url = new URL(request.url);
  if (!url.searchParams.get("shop") && !url.searchParams.get("host") &&
      !url.searchParams.get("id_token") && !url.searchParams.get("embedded")) {
    throw redirect("/auth/login");
  }

  const { session } = await authenticate.admin(request);

  // Make sure the shop + settings rows exist. afterAuth does this on
  // install, but a merchant who installed before a migration ran would
  // otherwise hit a null settings row on every page.
  await db
    .from("shops")
    .upsert(
      { shop_domain: session.shop, is_active: true, install_source: "app" },
      { onConflict: "shop_domain", ignoreDuplicates: true }
    );
  await db
    .from("shop_settings")
    .upsert({ shop_domain: session.shop }, { onConflict: "shop_domain", ignoreDuplicates: true });

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
