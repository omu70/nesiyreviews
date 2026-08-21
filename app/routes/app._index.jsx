// =============================================================
// Overview / onboarding
// File: /app/routes/app._index.jsx
//
// Two jobs, in this order:
//
//   1. Get the widget onto the storefront. App Store req 5.1.3 wants
//      clear app-embed onboarding with a deep link, and a merchant who
//      cannot find the theme editor toggle is a merchant who uninstalls.
//   2. Once reviews exist, show what the app is doing — the numbers a
//      merchant actually checks, and the queue if anything is waiting.
// =============================================================
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  Card,
  InlineGrid,
  InlineStack,
  Layout,
  Link,
  List,
  Page,
  Text,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { log } from "../utils/log.server";
import { config } from "../config.server";

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  const [statsRes, aggRes, shopInfo] = await Promise.all([
    // One aggregate query rather than pulling every review row back to
    // count them here.
    db.rpc("shop_review_stats", { p_shop: shop }),
    db
      .from("review_aggregates")
      .select("product_handle, average, rating_count, images_count")
      .eq("shop_domain", shop)
      .order("rating_count", { ascending: false })
      .limit(5),
    admin
      .graphql(
        `#graphql
        query ShopBasics {
          shop { name myshopifyDomain primaryDomain { url } }
        }`
      )
      .then((r) => r.json())
      .catch((error) => {
        log.warn("overview.shop_query_failed", { shop, error });
        return null;
      }),
  ]);

  if (statsRes.error) log.warn("overview.stats_failed", { shop, error: statsRes.error });

  const row = (Array.isArray(statsRes.data) ? statsRes.data[0] : statsRes.data) || {};
  const stats = {
    total: Number(row.total) || 0,
    approved: Number(row.approved) || 0,
    pending: Number(row.pending) || 0,
    rejected: Number(row.rejected) || 0,
    withImages: Number(row.with_images) || 0,
    average: Number(row.average) || 0,
    last30: Number(row.last_30_days) || 0,
  };

  const storeUrl = shopInfo?.data?.shop?.primaryDomain?.url || `https://${shop}`;
  const embedUuid = config.appEmbedUuid;

  return json({
    shop,
    shopName: shopInfo?.data?.shop?.name || shop,
    storeUrl,
    stats,
    topProducts: aggRes.data || [],
    supportEmail: config.supportEmail,
    // Deep link straight to the theme editor with our app embed
    // focused. This is what turns a six-step support doc into one click.
    embedDeepLink: embedUuid
      ? `${storeUrl}/admin/themes/current/editor?context=apps&activateAppId=${embedUuid}/app-embed`
      : `${storeUrl}/admin/themes/current/editor?context=apps`,
  });
};

function Stat({ label, value, tone, suffix }) {
  return (
    <Box padding="400" background="bg-surface-secondary" borderRadius="200">
      <BlockStack gap="100">
        <Text as="p" variant="bodySm" tone="subdued">
          {label}
        </Text>
        <InlineStack gap="100" blockAlign="baseline">
          <Text as="p" variant="headingLg" tone={tone}>
            {value}
          </Text>
          {suffix ? (
            <Text as="span" variant="bodySm" tone="subdued">
              {suffix}
            </Text>
          ) : null}
        </InlineStack>
      </BlockStack>
    </Box>
  );
}

export default function Overview() {
  const { shopName, stats, topProducts, embedDeepLink, storeUrl, supportEmail } = useLoaderData();
  const isFresh = stats.total === 0;

  return (
    <Page>
      <TitleBar title="Overview" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="500">
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    {shopName}
                  </Text>
                  {stats.pending > 0 ? (
                    <Badge tone="attention">{`${stats.pending} awaiting approval`}</Badge>
                  ) : (
                    <Badge tone="success">Nothing to moderate</Badge>
                  )}
                </InlineStack>

                <InlineGrid columns={{ xs: 2, md: 4 }} gap="300">
                  <Stat
                    label="Average rating"
                    value={stats.approved ? stats.average.toFixed(1) : "—"}
                    suffix={stats.approved ? "out of 5" : undefined}
                  />
                  <Stat label="Published reviews" value={stats.approved.toLocaleString()} tone="success" />
                  <Stat
                    label="Pending"
                    value={stats.pending.toLocaleString()}
                    tone={stats.pending ? "caution" : undefined}
                  />
                  <Stat label="With photos" value={stats.withImages.toLocaleString()} />
                </InlineGrid>

                {stats.total ? (
                  <Text as="p" variant="bodySm" tone="subdued">
                    {`${stats.total.toLocaleString()} reviews in total · ${stats.last30.toLocaleString()} in the last 30 days · ${stats.rejected.toLocaleString()} hidden or rejected`}
                  </Text>
                ) : null}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Turn the widget on
                </Text>
                <Text as="p" tone="subdued">
                  Reviews display through a theme app embed. You never edit theme
                  code — enabling the embed once is the whole install.
                </Text>
                <List type="number">
                  <List.Item>
                    Open the theme editor and switch on <b>Reviews</b> under{" "}
                    <b>App embeds</b>, then <b>Save</b>. Star ratings and the
                    review section appear on product pages straight away.
                  </List.Item>
                  <List.Item>
                    Want them somewhere specific? In the same editor, add the{" "}
                    <b>Product rating badge</b> and <b>Product reviews</b> blocks
                    exactly where you want them. Blocks you place win over the
                    automatic placement.
                  </List.Item>
                  <List.Item>
                    Set how many reviews to show, photo rules and colours under{" "}
                    <b>Settings</b> in this app.
                  </List.Item>
                </List>
                <InlineStack gap="300">
                  <Button variant="primary" url={embedDeepLink} target="_blank">
                    Open theme editor
                  </Button>
                  <Button url={storeUrl} target="_blank" variant="plain">
                    View storefront
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>

            {isFresh ? (
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Bring your reviews across
                  </Text>
                  <Text as="p" tone="subdued">
                    Already collecting reviews elsewhere? Import them from a CSV —
                    the importer reads exports from most review apps as-is, keeping
                    original authors and dates.
                  </Text>
                  <InlineStack gap="300">
                    <Button url="/app/import">Import from CSV</Button>
                    <Button url="/app/reviews" variant="plain">
                      Add one manually
                    </Button>
                  </InlineStack>
                </BlockStack>
              </Card>
            ) : (
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Most reviewed products
                  </Text>
                  {topProducts.length === 0 ? (
                    <Text as="p" tone="subdued">
                      No product-specific reviews yet.
                    </Text>
                  ) : (
                    <BlockStack gap="200">
                      {topProducts.map((p) => (
                        <InlineStack key={p.product_handle} align="space-between" wrap={false}>
                          <Link url={`/app/reviews?product=${encodeURIComponent(p.product_handle)}&status=all`}>
                            {p.product_handle}
                          </Link>
                          <Text as="span" tone="subdued">
                            {`${Number(p.average).toFixed(1)} ★ · ${Number(p.rating_count).toLocaleString()} reviews` +
                              (p.images_count ? ` · ${p.images_count} with photos` : "")}
                          </Text>
                        </InlineStack>
                      ))}
                    </BlockStack>
                  )}
                </BlockStack>
              </Card>
            )}
          </BlockStack>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <BlockStack gap="500">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Your plan
                </Text>
                <InlineStack gap="200" blockAlign="center">
                  <Badge tone="success">Free</Badge>
                  <Text as="span" tone="subdued">
                    Unlimited reviews
                  </Text>
                </InlineStack>
                <Text as="p" variant="bodySm" tone="subdued">
                  No charges. If paid plans are added later you'll be asked to
                  approve them first — nothing changes without your consent.
                </Text>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  How moderation works
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Reviews left by shoppers arrive as <b>Pending</b> and are invisible
                  on your storefront until you approve them. Turn on auto-approve in
                  Settings if you'd rather publish immediately.
                </Text>
                <Button url="/app/reviews" variant="plain">
                  Open moderation queue
                </Button>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Need a hand?
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Email support and we'll reply within one business day.
                </Text>
                <Button url="/support" target="_blank" variant="plain">
                  {supportEmail ? `Contact ${supportEmail}` : "Contact support"}
                </Button>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
