# Evo Labs Product Reviews

A Shopify product-reviews app: star ratings on product cards, a review
section with shopper photos, moderation in the Shopify admin, and a theme
app extension so merchants never touch theme code.

One deployment serves every merchant. One database holds every merchant's
data, isolated by shop.

---

## Architecture

```
Shopify admin (embedded)          Storefront (any OS 2.0 theme)
        │                                    │
        │ session token / token exchange     │ signed App Proxy
        ▼                                    ▼
┌──────────────────────────────────────────────────────┐
│  Remix app  ·  one deployment, all shops             │
│                                                      │
│  /app/*            Polaris admin (authenticate.admin)│
│  /apps/proxy/*     storefront API (appProxy)         │
│  /webhooks/*       lifecycle + compliance (HMAC)     │
│  /privacy /support public pages                      │
└──────────────────────────────────────────────────────┘
                       │ service role
                       ▼
              Supabase Postgres + object storage
              every row keyed by shop_domain
```

**Tenant isolation.** The shop is never taken from a request body or query
string. In the admin it comes from the Shopify session; on the storefront it
comes from the App Proxy signature Shopify computes. Every query — read and
write — is filtered by that value, so a forged id from one store matches
nothing in another. Sessions, settings, reviews, aggregates and uploaded
photos are all scoped the same way.

---

## Layout

```
app/
  config.server.js            environment validation — fails fast at boot
  db.server.js                Supabase client, column allow-lists, input scrubbing
  shopify.server.js           the Shopify app singleton
  session-storage.server.js   OAuth sessions in Postgres, not on disk
  routes/
    app.jsx                   embedded shell + nav
    app._index.jsx            overview, stats, onboarding
    app.reviews.jsx           moderation queue, filters, replies, manual entry
    app.settings.jsx          every merchant-configurable setting
    app.import.jsx            CSV import
    apps.proxy.$.jsx          the storefront's only backend
    webhooks.*.jsx            uninstall, scopes, products/update, products/delete, compliance
    privacy.jsx  support.jsx  public pages required for submission
    _index.jsx                install entry / landing
  utils/
    log.server.js             redacting structured logger
    webhook.server.js         status-code guards + delivery de-duplication
    metafields.server.js      reviews.rating / reviews.rating_count sync

extensions/reviews-widget/
  blocks/app-embed.liquid       auto-placement + product-card badges
  blocks/product-badge.liquid   ⭐ 4.7 🔵 (1.3K Reviews), server-rendered
  blocks/product-reviews.liquid the full review section
  blocks/store-reviews.liquid   store-wide reviews
  assets/reviews.js             the whole storefront widget
  assets/reviews.css

supabase/
  schema.sql + migrations/001..008    run in order, all idempotent

tests/
  unit/       node --test               pure functions, and the JS ↔ Liquid count agreement
  widget/     node tests/widget/run.js   the real widget in Chromium against a mock storefront
  db/         bash tests/db/apply.sh     every migration applied for real, then behaviour checked
```

---

## Running it

```bash
npm install
cp .env.example .env          # fill in the Supabase pair
npm run dev                   # Shopify CLI: tunnels, installs, hot reloads
```

Other commands:

| Command | What it does |
|---|---|
| `npm run build` | Production Remix build |
| `npm start` | Serve the production build |
| `npm run lint` | ESLint over app, lib, extension and tests |
| `npm test` | Unit tests |
| `npm run test:e2e` | Widget harness in Chromium (77 checks) |
| `npm run test:db` | Apply every migration to a throwaway Postgres and exercise it (27 checks) |
| `npm run deploy` | Push app config + theme extension to Shopify |

Deployment, database setup and environment variables: [`docs/DEPLOY.md`](docs/DEPLOY.md).
App Store submission: [`docs/SUBMISSION.md`](docs/SUBMISSION.md).

---

## Two things worth knowing before you change anything

**The widget has no theme-specific selectors.** It finds a product card by
walking up from a product link to the smallest ancestor that contains an
image and links to exactly one product. That is why it works on themes
nobody has tested it against. Adding a `.product-card` selector would be a
step backwards.

**The review count is formatted twice** — in JavaScript for everything the
widget paints, and in Liquid for the server-rendered badge. They must agree
exactly or shoppers see the number change on every page load.
`tests/unit/count-format.test.js` runs the real implementations against each
other across thousands of values; it has already caught one drift.
