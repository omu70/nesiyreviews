// =============================================================
// Shop-domain entry form
// File: /app/routes/auth.login/route.jsx
//
// Shown when someone reaches the app without a shop context, or
// types a bad domain. login() returns field errors instead of
// throwing, so this never shows a stack trace to a merchant.
// =============================================================
import { useState } from "react";
import { Form, useActionData, useLoaderData } from "@remix-run/react";
import {
  AppProvider as PolarisAppProvider, Button, Card, FormLayout, Page, Text, TextField,
} from "@shopify/polaris";
import polarisTranslations from "@shopify/polaris/locales/en.json";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import { login } from "../../shopify.server";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export const loader = async ({ request }) => {
  const errors = loginErrorMessage(await login(request));
  return { errors, polarisTranslations };
};

export const action = async ({ request }) => {
  const errors = loginErrorMessage(await login(request));
  return { errors };
};

function loginErrorMessage(loginErrors) {
  if (loginErrors?.shop === "MISSING_SHOP") {
    return { shop: "Enter your shop domain to continue" };
  }
  if (loginErrors?.shop === "INVALID_SHOP") {
    return { shop: "Enter a valid shop domain, e.g. my-store.myshopify.com" };
  }
  return {};
}

export default function Auth() {
  const { errors, polarisTranslations: translations } = useLoaderData();
  const actionData = useActionData();
  const [shop, setShop] = useState("");
  const { shop: shopError } = actionData?.errors || errors;

  return (
    <PolarisAppProvider i18n={translations}>
      <Page>
        <Card>
          <Form method="post">
            <FormLayout>
              <Text variant="headingMd" as="h2">Log in</Text>
              <TextField
                type="text" name="shop" label="Shop domain"
                helpText="example.myshopify.com"
                value={shop} onChange={setShop}
                autoComplete="on" error={shopError}
              />
              <Button submit variant="primary">Log in</Button>
            </FormLayout>
          </Form>
        </Card>
      </Page>
    </PolarisAppProvider>
  );
}
