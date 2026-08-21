# Production readiness — 21 August 2026

Full report, formatted:
<https://claude.ai/code/artifact/1f53bbff-2025-4378-947c-e4f592f0ac2e>

**Verdict:** code-complete and verified. Six items remain, none of them
engineering — they need the Partner Dashboard, your Supabase project, or a
legal document.

## Verification

| Suite | Command | Checks | Result |
|---|---|---:|---|
| Unit — input scrubbing, image normalisation, count formatting | `npm test` | 11 | pass |
| Widget — real `reviews.js` in Chromium, desktop + mobile | `npm run test:e2e` | 77 | pass |
| Database — every migration applied twice, then exercised | `npm run test:db` | 27 | pass |
| Lint | `npm run lint` | — | 0 errors |
| Production build | `npm run build` | — | clean |

## Defects fixed

1. RLS policy let any holder of the anon key read every approved review in the
   database, across every shop; a second let them write into the image bucket.
2. `shops.store_key` — a live credential for the retired snippet API — plus the
   whole snippet distribution path.
3. `products/update` matched on a column holding a handle, not an id, so a
   rename silently detached a product's reviews.
4. The aggregate trigger left a stale rating on the old handle after a rename.
5. Store-wide reviews were mixed into every product page, so the product-card
   count and the product-page count disagreed.
6. The Liquid and JavaScript review-count formatters disagreed — visible flicker
   on every page load.
7. The widget scrolled the merchant's page sideways on mobile, from two separate
   causes.
8. Product cards whose title link follows an image link never got a badge.
9. Deleting a review left its photos in object storage forever.
10. `/privacy` and `/support` could ship with placeholder text.
11. `vercel.json` still carried the static-site config and would have broken the
    deploy.
12. `npm run lint` pointed at an ESLint that was not installed and a config that
    did not exist.

## Not verified here

Migration 008 against real data; install / uninstall / reinstall on a dev store;
the metafield sync against a live Admin API; real themes; the Lighthouse delta.
Everything in that list needs Shopify or your database.

## Remaining, in order

1. Apply for Level 2 protected customer data — **before** submitting.
2. Second Supabase project for development.
3. Run migration 008; confirm RLS on every table.
4. Fill in `shopify.app.toml`; set the environment variables.
5. Deploy, `npm run deploy`, collect the app embed UUID, redeploy.
6. Work the dev-store checklist in `DEPLOY.md`.
7. Test on Dawn and your merchants' themes; run the Lighthouse delta.
8. Second dev store — confirm tenant isolation by hand.
9. Listing assets and the screencast.
10. Incident response policy, then submit.
