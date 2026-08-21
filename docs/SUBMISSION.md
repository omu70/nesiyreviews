# App Store submission

Everything Shopify checks, what's already handled in the code, and what only you
can do. Work top to bottom — the first section contains things that will get you
rejected or that you physically cannot do later.

---

## Do these before you submit anything

### 1. Request Level 2 protected customer data — today

The app stores reviewer **name** and **email**. That is Level 2 protected
customer data, and this is the trap:

> "Applying for protected customer data isn't possible while the app is under
> review."

Apply first, or you burn an entire review cycle. Partner Dashboard → your app →
**API access** → Protected customer data.

You'll need to attest to Level 1 + Level 2 requirements. What to answer, given
this stack:

| Requirement | Your answer |
|---|---|
| Encryption in transit and at rest | TLS everywhere; Supabase encrypts at rest |
| Encrypted backups | Supabase automated backups / PITR |
| **Separate test and production environments** | ⚠️ Create a **second Supabase project** for dev. A separate schema in the same project is a weak answer and gets pushed back. |
| Data minimisation | Only name, optional email, optional location, review text, photos |
| Retention policy | Documented in `/privacy`: IPs 30 days, everything else deleted on shop redaction |
| Staff access limits + access logs | Restrict Supabase project members; Supabase logs access |
| Incident response policy | Write one page. They ask. |
| Customer consent / opt-out | Reviews are voluntarily submitted; redaction webhook is wired |

### 2. The review generator must not ship

Requirement 1.1.4 names your exact feature as the canonical violation:

> "Apps that falsify data to deceive merchants or buyers, **such as fake
> reviews** or false purchase notifications, violate our Partner Program
> Agreement and our Acceptable Use Policy."

And Shopify's review policy requires each review be "authentic, and **isn't
artificially created by a bot or other automation**."

Already done in this build:

- `app/routes/app.generate.jsx`, `app/utils/ai.server.js` and `lib/generate.js`
  are not in the repo.
- `ai_sample` is not written by any code path.
- The Settings page has a **preview pane** with obviously-labelled placeholder
  text ("Sample Customer", "This is placeholder text… It is not a real review
  and is never published"). It renders in the admin only, is never persisted,
  and there is no button, route or toggle that can publish it.

Before submitting, grep the repo yourself:

```bash
grep -rn "generate\|ai_sample\|sample review" app/ extensions/ lib/
```

Then say it in your testing instructions, unprompted:

> "The Settings page includes a preview of the rating badge, rendered from the
> merchant's own colour and format choices with a fixed example value. It
> renders in the admin only, is never written to the database, and cannot be
> published to a storefront."

Two more places the app deliberately refuses to overstate:

- A review is marked **verified** only when it is tied to a real order.
  Manually entered and CSV-imported reviews are written with
  `is_verified = false` and `app_verification_status = 'not_verified'`, and
  there is no code path that sets them otherwise. A logged-in shopper is not
  treated as proof of purchase.
- The structured data the widget emits carries the same average and count the
  page displays, from approved reviews only, and is not emitted at all when a
  product has no reviews.

Getting ahead of the reviewer's suspicion here is worth a full round.

### 3. Fabricated data already removed from the widget

The original widget displayed **"N people are viewing this right now"** driven
by `Math.random()`. That is falsified data under 1.1.4 — the same rule, and
"false purchase notifications" is the named example. It is stripped from
`extensions/reviews-widget/assets/reviews.js`. Don't add it back.

### 4. Check your domain and emails for the string "shopify"

App URLs and the API contact email must not contain "Shopify" or "Example",
including misspellings and abbreviations. This is an automated check.

- ❌ `shopify-reviews.vercel.app`, `reviews4shopify.com`, `hello@shopifyapps.io`
- ✅ `reviews.evolabs.io`, `support@evolabs.io`

### 5. Fill in the placeholders

The only placeholders left in the repo are in `shopify.app.toml`, and they
need values only you have:

```bash
grep -rn "REPLACE_WITH_YOUR" . --include="*.toml"
```

`client_id`, `application_url`, the three `redirect_urls`, the app proxy `url`
and `dev_store_url`. `npm run config:link` writes `client_id` for you.

The privacy and support pages no longer contain placeholders at all — the
operator name, address and contact addresses come from `LEGAL_ENTITY_NAME`,
`LEGAL_ENTITY_ADDRESS` and `SUPPORT_EMAIL`, and **production refuses to boot
without them**. Shipping a privacy policy with brackets in it was an easy,
avoidable rejection; now it is not possible.

### 6. The name

`shopify.app.toml` uses **Evo Labs Product Reviews** (24 characters). This is
deliberate. Requirement 4.1.2, added 2026-07-15:

> "Every app must have its own unique, recognizable name that **leads with your
> distinctive brand identifier**. Your app's name must not be identical or
> confusingly similar to another app, developer, brand, or Shopify product."

A bare "Reviews" fails twice over — generic rather than brand-led, and
confusingly similar to Shopify's own retired Product Reviews app. The listing
name must also match the TOML name.

---

## Billing: don't write any

Shopify App Pricing (formerly Managed Pricing) is now the default and
recommended path, and plans are defined **in the submission form, not in code**.

> "Shopify App Pricing lets you define your app's pricing plans directly in the
> app submission form, without needing to use the Billing API."

So: declare a **Free** plan in the submission form. There is no billing code in
this repo, which is correct — half-wired Billing API integrations are a common
billing rejection. When you monetise later, add paid plans in the same dashboard
config; Shopify hosts the plan picker and handles trials, proration, upgrades
and downgrades, which satisfies requirement 1.2.3 for free.

Going free → paid on the same feature set is a **listing** update, not a full
re-review. Adding major new capability at the same time triggers a full
re-review. Practical tip: decide your eventual plan structure now and gate
features by plan from the start, so monetising is config rather than
architecture.

---

## Listing assets — exact specs

| Asset | Spec |
|---|---|
| App icon | **1200 × 1200** PNG/JPEG. No text, no screenshots, no pricing, no Shopify trademarks |
| Feature image | **1600 × 900**. If video: 2–3 min, promotional, screencast ≤25% |
| Screenshots | **1600 × 900**, **3–6 of them**, at least one of the app UI |
| App name | ≤30 chars, brand-first |
| App introduction | ≤100 chars |
| App details | ≤500 chars |
| Feature list | ≤80 chars per feature |
| Integrations | ≤6 |

Two rules added 2026-03-26 that catch people out:

- **4.4.4** Images must primarily show the actual UI. **No desktop backgrounds,
  no browser windows.** Logo-only images are not permitted.
- **4.4.5** Every image must be **unique** — different features, views or states.
  No near-duplicates.

Also banned in listing copy and images: statistics, unsubstantiated claims,
"the best" / "the first" / "the only", customer testimonials, and pricing
anywhere outside the Pricing section.

### Draft copy

**App introduction** (98 chars)

> Product reviews with photos, star ratings on product cards, and moderation before anything goes live.

**App details** (476 chars)

> Collect and display product reviews without touching your theme code. Star
> ratings appear under product titles and on every product card; a full review
> section with photos sits on the product page.
>
> Reviews from shoppers wait in a moderation queue until you approve them, and
> you can reply publicly to any of them. Already using another review app?
> Import your existing reviews from a CSV — original authors and dates are kept.
>
> Set up in one click from the theme editor.

**Feature list**

- Star ratings on product pages and product cards
- Review photos with a full-screen, swipeable viewer
- Choose how many reviews load, with a Load more button
- Approve, reject or hide every review before it publishes
- Reply publicly to any review, and import from a CSV

### Screenshot plan (6, all unique, all real UI)

1. Product page with the star badge and review section, including the star
   breakdown
2. Collection page with ratings on product cards
3. The moderation queue with pending reviews and photo thumbnails
4. Settings — the display limit, photo rules and the badge preview
5. The full-screen photo viewer on a review with several photos
6. The same product page at mobile width

---

## Theme extension branding — a rule people miss

Requirement 5.1.4, revised 2025-11-05:

> "Your app must not use theme app extensions or blocks to promote your app,
> promote related apps, or request reviews."

Branding in a theme extension is allowed only when shoppers interact with the
branded element as a key part of buying (a payment method, a loyalty program). A
reviews widget does not qualify. So:

- No "Powered by…" beyond the standard attribution pattern (**max 24 × 24 px**)
- **No** "rate us on the App Store" prompt anywhere in the widget

The current widget has no branding at all. Keep it that way.

---

## Submission form

- **Screencast — mandatory.** Onboarding plus every feature in your listing.
  English, or English subtitles. Narrate the demo-preview limitation.
- **Test credentials** if anything requires login, valid and granting full
  feature access.
- **Demo store URL** — a dev store, deep-linked to a product page with reviews
  visible, plus contextual instructions.
- **Emergency developer contact** — email *and* phone.
- **Support email** — required. Support URL optional.
- **Privacy policy URL** — `https://your-domain/privacy`.
- Allowlist `app-submissions@shopify.com` and `noreply@shopify.com` in your mail
  provider, or you'll miss the review emails and get suspended for silence.

### Unlisted launch

If you'd rather not appear in search: Distribution → Manage listing → **App
Store visibility** → *Limit visibility*. The listing still exists and is
installable by direct link; it just isn't indexed in search, categories or
search engines. Changeable any time.

Two things to be clear about: the **review is identical** either way — unlisted
is not a lighter path — and you still need the complete listing, all assets
included.

---

## Engineering checklist

Verified in this build:

- [x] Session tokens / token exchange, works with third-party cookies blocked
- [x] Managed installation — no custom OAuth callback
- [x] Sessions in Postgres, so redeploys don't log merchants out
- [x] `app/uninstalled` clears sessions so reinstall is clean
- [x] All three compliance webhooks, returning **401 on invalid *or* missing HMAC**
- [x] `405` on non-POST to a webhook endpoint
- [x] **Webhook delivery de-duplicated** by `X-Shopify-Webhook-Id`; a handler that
      throws releases its claim so Shopify's retry does the work
- [x] `products/update` repoints reviews by **numeric product id**, so a rename
      does not detach them; `products/delete` retires them without destroying them
- [x] App proxy signature verified; tampered and >90s-old requests rejected
- [x] Storefront data scoped by shop from the signed session, never from the
      request body — in **every** query, read and write
- [x] Shopper submissions forced to `pending` / `not_verified` — cannot self-publish
- [x] Off-domain image URLs stripped from submissions; only URLs minted by our
      own signed-upload endpoint are accepted
- [x] Request body size capped; per-IP submission limit in the database and a
      per-instance ceiling on signed-URL minting
- [x] Server-side validation mirrors the client's and never trusts it
- [x] No database error text, SQL fragment or stack trace reaches a shopper —
      storefront failures return one sentence, detail goes to the log
- [x] Logs redact reviewer names, emails, review text, IPs and tokens
- [x] `author_email` is absent from the storefront column allow-list
- [x] Reviews paged **in Postgres**, not fetched whole and sliced in JavaScript
- [x] Rating, count and the star breakdown come from a trigger-maintained
      aggregate — a collection page is one indexed lookup for the whole grid
- [x] Deleting a review deletes its photos from object storage; `shop/redact`
      purges the shop's entire image folder
- [x] Theme app extension only — no theme code edits by anyone
- [x] Four blocks: app embed, product rating badge, product reviews, store reviews
- [x] Storefront review data visible in the Shopify admin (req 5.1.5)
- [x] GraphQL Admin API only — no REST
- [x] Minimal scopes: `read_products`, `write_products`
- [x] No 404/500 on `/`, `/app`, `/privacy`, `/support`, unknown paths
- [x] Privacy policy and support pages live, driven by environment variables
- [x] Non-blocking CSS, deferred JS, reserved layout space, lazy photos,
      one batched request per collection page
- [x] Lightbox is keyboard-navigable, focus-trapped, returns focus, and swipes
- [x] `npm run lint`, `npm test` and `npm run test:e2e` all clean

Still yours to do:

- [ ] Level 2 protected customer data request — **submit first**
- [ ] Second Supabase project for a genuinely separate test environment
- [ ] Run `supabase/migrations/008_production.sql`, then confirm RLS on every table
- [ ] Replace the `REPLACE_WITH_YOUR_*` values in `shopify.app.toml`
- [ ] Set `SUPPORT_EMAIL`, `LEGAL_ENTITY_NAME`, `LEGAL_ENTITY_ADDRESS` in production
- [ ] Lighthouse delta test — under 10 points
- [ ] Install / uninstall / **reinstall** on a clean dev store
- [ ] Icon, feature image, 3–6 screenshots
- [ ] Screencast
- [ ] Incident response policy (one page, for the data review)

---

## Timeline, and how not to get suspended

Shopify publishes no SLA. Realistically: **~10 business days** to first reviewer
contact, then 2–3 business day cycles. **2–4 rounds is normal** for a first
submission. Budget **4–8 weeks**.

Suspension is real and documented. Partners get temporarily suspended for
failing to address reviewer issues after two or more exchanges, for resubmitting
with *more* problems than before, or for not replying to review emails. Repeated
suspensions mean longer cooldowns.

The practical implication: don't use the reviewer as QA. Run the whole checklist,
the Lighthouse test, the reinstall test and the incognito test before the first
submit.

---

## After approval: worth knowing

**Shop review syndication.** Shopify has a standard product review metaobject
and an approved-partner syndication program that puts reviews in the Shop app.
The schema in `007` already mirrors those field names, so joining is a write
rather than a migration. Two constraints to plan around: a review needs
**customer ID + order ID + product ID** all linked to display in Shop, and
**CSV-imported reviews are permanently ineligible** — worth surfacing in your UI
so merchants aren't surprised.

**Built for Shopify** needs 50+ net installs from paid shops and 5+ reviews, so
it's a later goal, not a submission concern.
