// =============================================================
// CSV import
// File: /app/routes/app.import.jsx
//
// Deliberately scoped: reviews the merchant already owns. No scraping,
// no "import from any store" — App Store req 1.1.13 rejects that
// outright, and 1.1.4 treats fabricated reviews as a policy violation.
// =============================================================
import { json } from "@remix-run/node";
import { useState } from "react";
import { useFetcher } from "@remix-run/react";
import {
  Banner, BlockStack, Box, Button, Card, DropZone, InlineStack, Layout, List,
  Page, Text,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { log, dbError } from "../utils/log.server";
import { syncRatingMetafieldsInBackground } from "../utils/metafields.server";
import { csvToReviews } from "../../lib/csv.js";

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  const form = await request.formData();
  const csvText = form.get("csv");
  if (!csvText || typeof csvText !== "string") {
    return json({ ok: false, error: "No CSV provided" }, { status: 400 });
  }
  if (csvText.length > 8_000_000) {
    return json(
      { ok: false, error: "That file is over 8 MB. Split it into smaller files and import each one." },
      { status: 413 }
    );
  }

  const { records, errors, fatal } = csvToReviews(csvText, shop);
  if (fatal) return json({ ok: false, error: fatal }, { status: 400 });
  if (!records.length) {
    return json({ ok: false, error: "No valid rows found", errors }, { status: 400 });
  }

  // Imported reviews can never be order-verified, and Shopify's Shop
  // syndication permanently excludes CSV-imported reviews. Mark them
  // honestly rather than inheriting a "verified" flag from the file.
  const clean = records.map((r) => ({
    ...r,
    is_verified: false,
    app_verification_status: "not_verified",
    submitted_at: r.created_at || new Date().toISOString(),
  }));

  let inserted = 0;
  for (let i = 0; i < clean.length; i += 400) {
    const chunk = clean.slice(i, i + 400);
    const { error } = await db.from("reviews").insert(chunk);
    if (error) {
      // Partial success is real: earlier chunks are already in. Say how
      // many landed so the merchant can trim the file rather than
      // re-importing everything and creating duplicates.
      return json(
        {
          ok: false,
          error: dbError("import.chunk_failed", error, { shop, chunk: i / 400 }),
          inserted,
          errors,
        },
        { status: 500 }
      );
    }
    inserted += chunk.length;
  }

  // Every imported product's rating changed, so the metafields the
  // theme reads have to catch up.
  syncRatingMetafieldsInBackground(
    admin,
    shop,
    clean.map((r) => r.product_handle).filter(Boolean)
  );

  log.info("import.completed", { shop, inserted, skipped: (errors || []).length });

  return json({ ok: true, inserted, errors });
};

const TEMPLATE_HEADERS =
  "product_handle,rating,author,title,content,author_location,author_country," +
  "commented_at,reply,verify_purchase,feature,publish";

export default function Import() {
  const fetcher = useFetcher();
  const [csvText, setCsvText] = useState("");
  const [fileName, setFileName] = useState("");
  const [rowCount, setRowCount] = useState(0);
  const result = fetcher.data;
  const busy = fetcher.state !== "idle";

  const handleDrop = (_all, accepted) => {
    const f = accepted[0];
    if (!f) return;
    setFileName(f.name);
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || "");
      setCsvText(text);
      setRowCount(Math.max(0, text.trim().split("\n").length - 1));
    };
    reader.readAsText(f);
  };

  const save = (name, text) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
    a.download = name;
    a.click();
  };

  const downloadTemplate = () =>
    save(
      "reviews-template.csv",
      TEMPLATE_HEADERS +
        "\n" +
        'your-product-handle,5,Priya Nair,Great quality,"Write the review here.",Mumbai India,IN,12/5/2025,,yes,no,yes\n'
    );

  const runImport = () => {
    const fd = new FormData();
    fd.set("csv", csvText);
    fetcher.submit(fd, { method: "post" });
  };

  return (
    <Page>
      <TitleBar title="Import reviews" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="500">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Import from a CSV</Text>
                <Text as="p" tone="subdued">
                  Bring across reviews you already collected — from another review
                  app's export, or your own spreadsheet. Original authors and dates
                  are preserved.
                </Text>
                <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                  <BlockStack gap="200">
                    <Text as="p" variant="bodySm" fontWeight="semibold">Required columns</Text>
                    <Text as="p" variant="bodySm">
                      <code>author</code> (or <code>author_name</code>),{" "}
                      <code>rating</code> 1–5, and either <code>title</code> or{" "}
                      <code>content</code>.
                    </Text>
                    <Text as="p" variant="bodySm" fontWeight="semibold">Optional</Text>
                    <Text as="p" variant="bodySm">
                      <code>product_handle</code> (from the product URL — leave blank
                      for a store-wide review), <code>author_location</code>,{" "}
                      <code>author_country</code>, <code>commented_at</code>,{" "}
                      <code>reply</code>, <code>feature</code>, <code>publish</code>,{" "}
                      <code>photo_url_1</code>…<code>photo_url_5</code>.
                    </Text>
                  </BlockStack>
                </Box>
                <InlineStack gap="200">
                  <Button onClick={downloadTemplate}>Download template</Button>
                </InlineStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <DropZone accept=".csv,text/csv" allowMultiple={false} onDrop={handleDrop}>
                  {fileName ? (
                    <Box padding="500">
                      <BlockStack gap="100" inlineAlign="center">
                        <Text as="p" fontWeight="semibold">{fileName}</Text>
                        <Text as="p" tone="subdued">{`${rowCount} rows ready`}</Text>
                      </BlockStack>
                    </Box>
                  ) : (
                    <DropZone.FileUpload
                      actionTitle="Upload CSV"
                      actionHint="Drop a .csv file, or click to browse"
                    />
                  )}
                </DropZone>
                <InlineStack gap="200">
                  <Button variant="primary" disabled={!csvText || busy} loading={busy}
                          onClick={runImport}>
                    {busy ? "Importing…" : `Import ${rowCount || ""} reviews`.trim()}
                  </Button>
                  {fileName ? (
                    <Button variant="plain" onClick={() => {
                      setCsvText(""); setFileName(""); setRowCount(0);
                    }}>
                      Choose a different file
                    </Button>
                  ) : null}
                </InlineStack>
              </BlockStack>
            </Card>

            {result?.ok ? (
              <Banner tone="success" title={`Imported ${result.inserted} reviews`}>
                <BlockStack gap="200">
                  <Text as="p">
                    They're published and live on your storefront now.
                  </Text>
                  {result.errors?.length ? (
                    <BlockStack gap="100">
                      <Text as="p">{`${result.errors.length} rows were skipped:`}</Text>
                      <List type="bullet">
                        {result.errors.slice(0, 10).map((e, i) => (
                          <List.Item key={i}>{e}</List.Item>
                        ))}
                      </List>
                      {result.errors.length > 10 ? (
                        <Text as="p" variant="bodySm" tone="subdued">
                          {`…and ${result.errors.length - 10} more.`}
                        </Text>
                      ) : null}
                    </BlockStack>
                  ) : null}
                  <InlineStack gap="200">
                    <Button url="/app/reviews?status=approved">View imported reviews</Button>
                  </InlineStack>
                </BlockStack>
              </Banner>
            ) : null}

            {result && result.ok === false ? (
              <Banner tone="critical" title="Import failed">
                <BlockStack gap="200">
                  <Text as="p">{result.error}</Text>
                  {result.errors?.length ? (
                    <List type="bullet">
                      {result.errors.slice(0, 10).map((e, i) => (
                        <List.Item key={i}>{e}</List.Item>
                      ))}
                    </List>
                  ) : null}
                </BlockStack>
              </Banner>
            ) : null}
          </BlockStack>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Good to know</Text>
              <List>
                <List.Item>
                  Import only reviews you own — your own store's history, or your own
                  account on another review platform.
                </List.Item>
                <List.Item>
                  Imported reviews are never marked as verified purchases, because
                  there's no order behind them to verify against.
                </List.Item>
                <List.Item>
                  Rows with a <code>publish</code> value of <code>no</code> import as
                  hidden, so you can stage a batch before it goes live.
                </List.Item>
                <List.Item>
                  Large files import in batches. If one batch fails, everything before
                  it is already saved — fix the file and re-import only the rest.
                </List.Item>
              </List>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
