# Go live on one store

The plan, in the order it has to happen. Roughly 45 minutes, most of it
waiting for a deploy.

| Step | Who | Why |
|---|---|---|
| 1. Database | **me** | I have `psql` and network; I run all eight migrations and verify RLS |
| 2. Server | **me** | Deploy, set environment variables, confirm the public pages answer |
| 3. Shopify config | **me** | Fill in `shopify.app.toml` from your app's real values |
| 4. Push the extension | **you** | `shopify app deploy` opens a browser to authenticate — it cannot run in the sandbox on your Mac, which has no network |
| 5. Install on the store | **you** | One click from the Partner Dashboard |
| 6. Turn the widget on safely | **you** | On a *duplicated* theme first — see below |
| 7. Verify | both | The checklist at the end |

---

## What I need from you

Paste these into the chat. Six values.

### Supabase — project → Settings

| Value | Where |
|---|---|
| **Project URL** | Settings → API → Project URL (`https://xxxx.supabase.co`) |
| **Service role key** | Settings → API → Project API keys → `service_role` |
| **Connection string** | Settings → Database → Connection string → **Session pooler** (port 5432). This is what I run the migrations through — the transaction pooler on 6543 cannot create functions or triggers. |

### Shopify — Partner Dashboard → Apps → your app → Overview → Client credentials

| Value | Where |
|---|---|
| **Client ID** | Client credentials |
| **Client secret** | Client credentials → Reveal |

### The store

| Value | Notes |
|---|---|
| **Store domain** | The `.myshopify.com` one, not your custom domain |

### Hosting

Tell me which, and give me a deploy token:

- **Vercel** — Account Settings → Tokens → Create. Fastest: I can create the project and deploy in one command. Note their Hobby tier is non-commercial, so this needs upgrading before you sell the app; it is fine for going live on your own store today.
- **Railway** or **Fly.io** — better long-term for a Shopify app (no cold starts eating the five-second webhook budget). Give me a token and an existing project name.

If you would rather not hand over a hosting token, say so and I will give you the four commands to run instead.

---

## A note on installing to a live store

You picked a real storefront rather than a dev store. That is fine, but the
app embed changes the **published** theme the moment it is saved, and a
misplaced review section is visible to real shoppers while we work out where
it should go.

So step 6 goes through a duplicate:

1. Online Store → Themes → your live theme → **⋯ → Duplicate**
2. On the *copy*, **Customize** → App embeds → switch on **Reviews** → Save
3. Still on the copy: **Preview**. Walk a product page, a collection page and
   the search results.
4. Only when it looks right: **Actions → Publish** on the copy.

If anything is wrong, the live theme was never touched — you close the preview
and nothing happened. Publishing the copy is the single moment anything
becomes visible, and it is instantly reversible by republishing the original.

The reviews themselves are safe either way: everything a shopper submits lands
as **Pending** and is invisible until you approve it.

---

## Step 4 — what you will run

In your own Terminal (not the sandbox — this needs network and a browser):

```bash
cd /Volumes/Windows-SSD/reviews
npm install
npx shopify app deploy
```

The first run opens a browser to log in to your Partner account, then asks you
to confirm the app it is deploying to. It pushes two things: the app
configuration from `shopify.app.toml` (which I will have filled in), and the
theme app extension — the widget, the styles and the four blocks.

When it finishes it prints the extension's URL. Send me the **app embed UUID**
from it and I will set `SHOPIFY_APP_EMBED_UUID` so the Overview page's
"Open theme editor" button lands on the right embed.

---

## Step 5 — installing

Partner Dashboard → Apps → your app → **Test your app** → select your store →
Install. You will see the permission screen asking for products access, then
land on the app's Overview page.

If the store is not listed there, open this instead, with your domain in it:

```
https://<your-app-url>/?shop=<your-store>.myshopify.com
```

That is the same managed-installation flow; the Partner Dashboard link is just
a shortcut to it.

---

## Step 7 — verification checklist

Work down this list on the duplicated theme's preview before publishing.

**Admin**

- [ ] Overview loads with no error and no blank iframe
- [ ] Settings saves and the banner confirms it
- [ ] Add a review by hand (Reviews → Add review) against a real product handle

**Storefront (preview)**

- [ ] The rating appears under the product title
- [ ] The review section appears below the description
- [ ] Product cards on a collection page show `⭐ x.x 🔵 (n Reviews)`
- [ ] Load more works; the count matches the badge
- [ ] Submit a review with two photos from the storefront

**Back in the admin**

- [ ] The submission is waiting as **Pending**, with its photos
- [ ] Approving it makes it appear on the storefront within a minute
- [ ] The average and the count both move

**Then**

- [ ] Publish the duplicated theme
- [ ] Uninstall and reinstall once, and confirm your reviews survive

Anything that fails, tell me what you saw — the app writes one JSON line per
event, so `LOG_LEVEL=debug` on your host plus the failing action is usually
enough to find it.
