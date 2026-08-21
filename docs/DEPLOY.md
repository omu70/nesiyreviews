# Going live

Three things to stand up: the database, the host, and the Shopify app itself.
About 40 minutes end to end, then one command to test on your dev store.

---

## 1. Database

Run these in the Supabase SQL editor, **in order**. Everything is idempotent,
so re-running is safe.

```
supabase/schema.sql
supabase/migrations/002_add_features.sql
supabase/migrations/003_add_location.sql
supabase/migrations/004_trustoo_compat.sql
supabase/migrations/005_store_reviews.sql
supabase/migrations/006_store_keys.sql
supabase/migrations/007_shopify_app.sql
supabase/migrations/008_production.sql      ← new
```

`007` added session storage, per-shop settings and the aggregate cache.
`008` is what makes the app production-ready:

| What | Why |
|---|---|
| `count_1` … `count_5`, `images_count` on `review_aggregates` | The 5→1 star breakdown and the photo count are one indexed lookup instead of a scan of every review on every product page. |
| `image_meta` on `reviews` | Each photo carries a thumbnail URL and its intrinsic size, so a review card shows five thumbnails without downloading five full-resolution photos. |
| `has_images` (generated) | "With photos" filters become an indexed equality rather than an array comparison. |
| `shopify_product_id` | Handles change when a merchant renames a product; numeric ids do not. This is what lets `products/update` find the reviews and repoint them. |
| `product_deleted_at` | A deleted product retires its reviews instead of destroying them. |
| `webhook_events` | Shopify retries. Every handler claims its delivery id first, so a repeat delivery is a no-op. |
| `'rejected'` review status | Distinct from `hidden`, so a merchant's "this is spam" is not the same record as "not showing this right now". |
| `shop_review_stats()` | The admin overview in one aggregate query. |
| New `shop_settings` columns | Display limit, pagination style, photo rules, badge appearance, structured data. |
| **`store_key` dropped** | It authenticated the retired public snippet API. A live credential column for an endpoint that no longer exists is a question you do not want at security review. |
| **RLS tightened** | `002` left a policy letting `anon` read every approved review in the database, across every shop, and a storage policy letting anyone with the anon key write into the image bucket. Both are gone. |

Afterwards, confirm in Supabase → Authentication → Policies that
`shopify_sessions`, `shop_settings`, `review_aggregates`, `webhook_events`,
`compliance_requests`, `reviews` and `shops` all show **RLS enabled with zero
policies**. They are reachable only by the service role. If any of them is
readable by `anon`, stop and fix it — one of those tables holds access tokens.

### A separate project for testing

Shopify's protected-customer-data review asks for genuinely separate test and
production environments. Create a **second Supabase project** for development.
A separate schema in the same project is a weak answer and gets pushed back.

---

## 2. Host

The app is a normal long-running Node server. It builds with `npm run build`
and starts with `npm start`.

**Recommended: Railway, Fly.io or Render (~$5/month).** This is what Shopify's
own template assumes, and it avoids every serverless failure mode — no cold
starts eating your 5-second webhook budget, no connection-pool exhaustion, no
frozen framework adapter.

```bash
# Railway
railway init && railway up

# Fly.io  (a Dockerfile is included)
fly launch --dockerfile Dockerfile
```

**On Vercel**, `vite.config.js` detects `VERCEL=1` and loads the Vercel preset
automatically, so the same repo deploys unchanged. Two caveats:

- Vercel's **Hobby tier is personal, non-commercial use only** per their terms.
  A Shopify App Store listing is commercial, so this needs Pro.
- Turn **off** Project Settings → Deployment Protection. Vercel Authentication
  returns 401 to iframe requests, which is every request to an embedded app.
  This breaks more Shopify apps than any other single setting.

Whichever host: use a stable production domain, and make sure it does not
contain the string `shopify`. A domain like `shopify-reviews.example.com`
fails an automated pre-submission check outright.

### Environment variables

The app validates these at boot and refuses to start with a list of what is
missing, rather than failing later on a page nobody visits often.

**Required everywhere**

| Variable | Value |
|---|---|
| `SHOPIFY_API_KEY` | Client ID — Partner Dashboard → your app → Client credentials |
| `SHOPIFY_API_SECRET` | Client secret, same page |
| `SHOPIFY_APP_URL` | `https://your-production-domain.com` — no trailing slash |
| `SUPABASE_URL` | `https://xxxx.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | service role key — server only, never sent to a browser |

**Required in production** (these appear on public pages; production will not
boot without them, which is deliberate — a privacy policy that ships with
`[YOUR LEGAL ENTITY NAME]` in it is a documented rejection)

| Variable | Value |
|---|---|
| `SUPPORT_EMAIL` | A monitored support address, shown on `/support` |
| `LEGAL_ENTITY_NAME` | The company or individual operating the app |
| `LEGAL_ENTITY_ADDRESS` | That operator's registered address |

**Recommended**

| Variable | Value |
|---|---|
| `SHOPIFY_APP_EMBED_UUID` | App embed UUID — enables the one-click theme editor deep link |
| `PRIVACY_EMAIL` | Falls back to `SUPPORT_EMAIL` |
| `HOSTING_PROVIDER` | Named as a sub-processor in the privacy policy |
| `LOG_LEVEL` | `error` \| `warn` \| `info` \| `debug` (default `info`) |
| `NODE_ENV` | `production` |

---

## 3. The Shopify app

```bash
npm install
npm run config:link          # links this repo to your Partner app and
                             # writes client_id into shopify.app.toml
```

Then open `shopify.app.toml` and replace every `REPLACE_WITH_YOUR_DOMAIN` with
your production host, and `REPLACE_WITH_YOUR_DEV_STORE` with your dev store.

```bash
npm run deploy               # pushes config + the theme app extension
```

After the first deploy, grab the app embed UUID for the deep link: Partner
Dashboard → your app → **Extensions** → Reviews Widget → it is in the URL. Put
it in `SHOPIFY_APP_EMBED_UUID` and redeploy the server.

### Scopes

`read_products` and `write_products`, and nothing else.

- `read_products` resolves product titles and handles in the admin, and is what
  `products/update` and `products/delete` need.
- `write_products` writes the standard `reviews.rating` and
  `reviews.rating_count` product metafields, so themes, the Shop app and the
  server-rendered badge block can read a product's rating without JavaScript.

The app asks for no customer, order or storefront scopes.

---

## 4. Test on your dev store

```bash
npm run dev
```

The CLI prints an install link. Work through this list — every item is a
documented App Store rejection cause, so finding them now costs you nothing
and finding them during review costs you a round.

1. **Install.** Click through. You should land on the Overview page with no
   error and no blank iframe.
2. **Enable the embed.** Overview → *Open theme editor* → switch on **Reviews**
   → Save.
3. **Add a review** in the admin, then load the product page. Star badge under
   the title, review section below the description.
4. **Place the blocks.** In the theme editor add **Product rating badge** and
   **Product reviews** where you want them, and confirm the automatic
   placement steps aside rather than rendering a second copy.
5. **Submit a review from the storefront**, with photos. It should land in the
   moderation queue as Pending, and be invisible on the storefront until you
   approve it.
6. **Approve it**, then reload the product page and a collection page. The
   rating, the review count and the product-card badge should all move
   together.
7. **Change the display limit** in Settings to 5, reload, and confirm five
   reviews render with a working Load more.
8. **Rename the product** in the Shopify admin. Reviews should follow the new
   handle, and the old handle's badge should disappear.
9. **Uninstall, then reinstall.** No errors, and your reviews are still there.

### Automated checks before you push

```bash
npm run lint
npm test              # unit tests
npm run test:e2e      # the widget in Chromium, desktop + mobile
npm run test:db       # every migration applied for real, then exercised
```

`npm run test:db` needs a Postgres to talk to. Point it at one with
`PGURL=postgres://…`, or start a throwaway locally:

```bash
initdb -D /tmp/pgdata -A trust && pg_ctl -D /tmp/pgdata -o '-k /tmp -p 5433' start
createdb -h /tmp -p 5433 reviews_test
PGPORT=5433 npm run test:db
```

It applies `schema.sql` and every migration **twice**, which is what proves
they are safe to re-run, then checks the behaviour that only exists in the
database: that the aggregate counts approved reviews and nothing else, that a
rename moves the rating and leaves no stale badge behind, that a deleted
product stops counting without losing its reviews, that a repeated webhook
delivery is rejected, and that one shop's rows are invisible to another.

The widget harness boots a mock storefront with class names the widget has
never seen, and drives the real `reviews.js` through badges, paging, the
lightbox, image failure, form validation and the mobile layout. It is not a
substitute for the dev-store pass above — it cannot test Shopify's signature
verification or your theme — but it catches the browser-side regressions.
