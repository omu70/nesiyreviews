-- =============================================================
-- Evo Labs Product Reviews — complete database setup
-- File: /supabase/full-setup.sql
--
-- Every migration, in order, in one file. Paste the whole thing into
-- the Supabase SQL editor and run it once.
--
-- Safe to re-run: every statement is idempotent, and running this
-- against a database that already has some of the migrations applied
-- brings it up to date rather than failing.
--
-- Generated from the individual files in supabase/ — those remain the
-- source of truth. Regenerate with:  npm run db:bundle
--
-- Contents:
--   001 — base tables
--   002 — images, source tracking, storage bucket
--   003 — reviewer location
--   004 — title, email, reply, featured
--   005 — store-wide reviews
--   006 — (historical) snippet distribution
--   007 — sessions, settings, aggregates, compliance
--   008 — production readiness
-- =============================================================


-- #############################################################
-- # 001 — base tables
-- # source: supabase/schema.sql
-- #############################################################

-- =============================================================
-- Shopify Reviews App — Supabase Schema
-- File location:  /supabase/schema.sql
-- Run this once in Supabase → SQL Editor.
-- =============================================================

-- Required for gen_random_uuid()
create extension if not exists "pgcrypto";

-- -------------------------------------------------------------
-- 1) shops  — tracks installations & gates the free tier
-- -------------------------------------------------------------
create table if not exists public.shops (
  shop_domain   text        primary key,
  installed_at  timestamptz not null default now(),
  plan_type     text        not null default 'standard'
                              check (plan_type in ('early_adopter_free','standard'))
);

comment on table  public.shops is 'One row per installed Shopify store.';
comment on column public.shops.plan_type is
  'early_adopter_free for the first 50 stores, standard afterwards.';

-- -------------------------------------------------------------
-- 2) reviews
-- -------------------------------------------------------------
create table if not exists public.reviews (
  id              uuid        primary key default gen_random_uuid(),
  shop_domain     text        not null references public.shops(shop_domain) on delete cascade,
  product_id      text        not null,
  author_name     text        not null,
  author_initials text        not null,
  is_verified     boolean     not null default true,
  rating          integer     not null check (rating between 1 and 5),
  content         text        not null,
  status          text        not null default 'approved'
                                check (status in ('approved','pending','hidden')),
  created_at      timestamptz not null default now()
);

-- Hot-path indexes
create index if not exists idx_reviews_shop_domain on public.reviews (shop_domain);
create index if not exists idx_reviews_product_id  on public.reviews (product_id);
create index if not exists idx_reviews_shop_product_status
  on public.reviews (shop_domain, product_id, status);
create index if not exists idx_reviews_created_at  on public.reviews (created_at desc);

-- -------------------------------------------------------------
-- 3) Row Level Security  (recommended; service-role bypasses)
-- -------------------------------------------------------------
alter table public.shops   enable row level security;
alter table public.reviews enable row level security;

-- Public storefront read: only approved reviews
drop policy if exists "Public read approved reviews" on public.reviews;
create policy "Public read approved reviews"
  on public.reviews for select
  using (status = 'approved');

-- The Remix app uses the service-role key on the server,
-- which automatically bypasses RLS for inserts/updates/deletes.

-- #############################################################
-- # 002 — images, source tracking, storage bucket
-- # source: supabase/migrations/002_add_features.sql
-- #############################################################

-- =============================================================
-- Migration 002 — Images + Source tracking + Storage bucket
-- Run this in Supabase SQL Editor (safe to re-run).
-- =============================================================

-- Add image_urls (array) and source columns to reviews
alter table public.reviews
  add column if not exists image_urls text[] not null default '{}',
  add column if not exists source text not null default 'storefront'
    check (source in ('storefront', 'csv_import', 'manual'));

-- Index for filtering by source (e.g. hide AI samples from storefront)
create index if not exists idx_reviews_source on public.reviews (source);

-- Update RLS: only show approved reviews on the storefront
drop policy if exists "Public read approved reviews" on public.reviews;
create policy "Public read approved reviews"
  on public.reviews for select
  using (status = 'approved');

-- =============================================================
-- Storage bucket for review images
-- =============================================================
-- Create a public bucket (idempotent)
insert into storage.buckets (id, name, public)
values ('review-images', 'review-images', true)
on conflict (id) do nothing;

-- Allow public read of review images
drop policy if exists "Public read review images" on storage.objects;
create policy "Public read review images"
  on storage.objects for select
  using (bucket_id = 'review-images');

-- Allow service-role uploads (the Remix server uploads via the SDK)
drop policy if exists "Service role uploads" on storage.objects;
create policy "Service role uploads"
  on storage.objects for insert
  with check (bucket_id = 'review-images');

-- #############################################################
-- # 003 — reviewer location
-- # source: supabase/migrations/003_add_location.sql
-- #############################################################

-- =============================================================
-- Migration 003 — Add author location to reviews
-- Run in Supabase SQL Editor (safe to re-run).
-- =============================================================

alter table public.reviews
  add column if not exists author_location text;

create index if not exists idx_reviews_author_location on public.reviews (author_location);

-- #############################################################
-- # 004 — title, email, reply, featured
-- # source: supabase/migrations/004_trustoo_compat.sql
-- #############################################################

-- =============================================================
-- Migration 004 — Trustoo-compatible review fields
-- Run in Supabase SQL Editor (safe to re-run).
-- =============================================================

alter table public.reviews
  add column if not exists product_handle text,
  add column if not exists title          text,
  add column if not exists author_email   text,
  add column if not exists author_country text,
  add column if not exists reply          text,
  add column if not exists reply_at       timestamptz,
  add column if not exists is_featured    boolean not null default false,
  add column if not exists item_type      text,
  add column if not exists video_url      text;

-- Indexes for filtering / sorting
create index if not exists idx_reviews_product_handle on public.reviews (product_handle);
create index if not exists idx_reviews_is_featured    on public.reviews (is_featured);

-- Allow CSV imports to pre-set commented_at by overriding created_at —
-- nothing structural to do; just permit historical timestamps via update path.

-- #############################################################
-- # 005 — store-wide reviews
-- # source: supabase/migrations/005_store_reviews.sql
-- #############################################################

-- =============================================================
-- Migration 005 — Allow store-wide reviews (no product attached)
-- Run in Supabase SQL Editor (safe to re-run).
-- =============================================================

-- product_id may now be NULL for store-wide reviews
alter table public.reviews
  alter column product_id drop not null;

-- Make sure product_handle is also nullable
alter table public.reviews
  alter column product_handle drop not null;

-- Index for filtering store-wide reviews
create index if not exists idx_reviews_store_wide
  on public.reviews (shop_domain, status)
  where product_id is null and product_handle is null;

-- #############################################################
-- # 006 — (historical) snippet distribution
-- # source: supabase/migrations/006_store_keys.sql
-- #############################################################

-- =============================================================
-- Migration 006 — Store keys for snippet distribution
--
-- Lets you host ONE app and hand each customer a snippet that
-- carries a store key. The API resolves the shop from the key,
-- so a store can never read or write another store's reviews.
--
-- Run in Supabase SQL Editor (safe to re-run).
-- =============================================================

create extension if not exists "pgcrypto";

-- -------------------------------------------------------------
-- shops: identity + key + activation
-- -------------------------------------------------------------
alter table public.shops
  add column if not exists store_key   text,
  add column if not exists name        text,
  add column if not exists is_active   boolean not null default true,
  add column if not exists contact     text,
  add column if not exists notes       text,
  add column if not exists created_at  timestamptz not null default now();

-- Backfill keys for any store that predates this migration
update public.shops
   set store_key = encode(gen_random_bytes(16), 'hex')
 where store_key is null;

-- Every new store gets a key automatically
alter table public.shops
  alter column store_key set default encode(gen_random_bytes(16), 'hex');

alter table public.shops
  alter column store_key set not null;

create unique index if not exists idx_shops_store_key on public.shops (store_key);
create index if not exists idx_shops_active on public.shops (is_active);

-- -------------------------------------------------------------
-- plan_type: allow a 'snippet' tier alongside the old values
-- -------------------------------------------------------------
alter table public.shops drop constraint if exists shops_plan_type_check;
alter table public.shops
  add constraint shops_plan_type_check
  check (plan_type in ('early_adopter_free', 'standard', 'snippet', 'trial', 'paused'));

-- -------------------------------------------------------------
-- reviews.source: the generator writes 'ai_sample', which the
-- original CHECK constraint rejected. Widen it.
-- -------------------------------------------------------------
alter table public.reviews drop constraint if exists reviews_source_check;
alter table public.reviews
  add constraint reviews_source_check
  check (source in ('storefront', 'csv_import', 'manual', 'ai_sample'));

-- -------------------------------------------------------------
-- Simple per-store abuse guard for public submissions
-- -------------------------------------------------------------
alter table public.reviews
  add column if not exists submitted_ip text;

create index if not exists idx_reviews_submitted
  on public.reviews (shop_domain, created_at desc)
  where source = 'storefront';

-- -------------------------------------------------------------
-- Storage bucket (idempotent — 002 may have created it already)
-- -------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('review-images', 'review-images', true)
on conflict (id) do nothing;

-- #############################################################
-- # 007 — sessions, settings, aggregates, compliance
-- # source: supabase/migrations/007_shopify_app.sql
-- #############################################################

-- =============================================================
-- Migration 007 — Real Shopify app support
--
-- Adds: session storage, per-shop widget settings, install lifecycle,
-- and columns that map 1:1 onto Shopify's standard product review
-- metaobject (so joining the Shop syndication program later is a
-- write, not a schema migration).
--
-- Run in Supabase SQL Editor. Safe to re-run.
-- =============================================================

create extension if not exists "pgcrypto";

-- -------------------------------------------------------------
-- 1) Shopify OAuth sessions
--    Holds access tokens. RLS on, zero policies: only the
--    service role can ever read this.
-- -------------------------------------------------------------
create table if not exists public.shopify_sessions (
  id                    text primary key,
  shop                  text not null,
  state                 text,
  is_online             boolean not null default false,
  scope                 text,
  expires               timestamptz,
  access_token          text,
  refresh_token         text,
  refresh_token_expires timestamptz,
  online_access_info    jsonb,
  updated_at            timestamptz not null default now()
);

create index if not exists idx_shopify_sessions_shop on public.shopify_sessions (shop);

alter table public.shopify_sessions enable row level security;
revoke all on public.shopify_sessions from anon, authenticated;

comment on table public.shopify_sessions is
  'Shopify OAuth sessions. Contains access tokens — service role only, never expose.';

-- -------------------------------------------------------------
-- 2) Install lifecycle on shops
-- -------------------------------------------------------------
alter table public.shops
  add column if not exists uninstalled_at   timestamptz,
  add column if not exists install_source   text not null default 'app',
  add column if not exists shopify_shop_id  text,
  add column if not exists deletion_due_at  timestamptz;

alter table public.shops drop constraint if exists shops_install_source_check;
alter table public.shops
  add constraint shops_install_source_check
  check (install_source in ('app', 'snippet'));

comment on column public.shops.deletion_due_at is
  'Set by the shop/redact webhook. A scheduled purge deletes rows past this date.';

-- -------------------------------------------------------------
-- 3) Per-shop widget settings
--    One row per shop; the theme extension reads these through the
--    app proxy so merchants configure the widget in the app, not by
--    editing theme code.
-- -------------------------------------------------------------
create table if not exists public.shop_settings (
  shop_domain        text primary key references public.shops(shop_domain) on delete cascade,
  auto_approve       boolean not null default false,
  show_badge         boolean not null default true,
  show_grid          boolean not null default true,
  show_card_badges   boolean not null default true,
  allow_photos       boolean not null default true,
  accent_color       text    not null default '#111111',
  star_color         text    not null default '#FFC107',
  layout             text    not null default 'grid'
                       check (layout in ('grid', 'list', 'carousel')),
  reviews_per_page   integer not null default 12
                       check (reviews_per_page between 3 and 50),
  heading_text       text    not null default 'Customer Reviews',
  empty_text         text    not null default 'No reviews yet. Be the first to write one.',
  updated_at         timestamptz not null default now()
);

alter table public.shop_settings enable row level security;
revoke all on public.shop_settings from anon, authenticated;

-- Backfill a settings row for every existing shop
insert into public.shop_settings (shop_domain)
select shop_domain from public.shops
on conflict (shop_domain) do nothing;

-- -------------------------------------------------------------
-- 4) Standard-review-metaobject-compatible columns
--    Field names mirror Shopify's restricted standard product review
--    metaobject definition so syndication is a straight mapping.
-- -------------------------------------------------------------
alter table public.reviews
  add column if not exists shopify_product_gid text,
  add column if not exists shopify_customer_id text,
  add column if not exists shopify_order_id    text,
  add column if not exists submitted_at        timestamptz,
  add column if not exists language_code       text not null default 'en',
  add column if not exists metaobject_id       text,
  add column if not exists app_verification_status text not null default 'not_verified'
    check (app_verification_status in ('verified', 'not_verified'));

-- Shop syndication requires customer + order + product all linked.
-- CSV-imported reviews can never qualify; this makes that queryable
-- instead of a surprise later.
create index if not exists idx_reviews_syndicatable
  on public.reviews (shop_domain)
  where shopify_customer_id is not null
    and shopify_order_id is not null
    and shopify_product_gid is not null;

comment on column public.reviews.app_verification_status is
  'verified only when the review is tied to a real Shopify order. Never set this for imported or manually entered reviews.';

-- Widen source now that the app writes through more paths.
-- NOTE: ai_sample is intentionally NOT included. Demo content is
-- rendered from static fixtures in the admin and never persisted.
alter table public.reviews drop constraint if exists reviews_source_check;
alter table public.reviews
  add constraint reviews_source_check
  check (source in ('storefront', 'csv_import', 'manual', 'app_proxy', 'ai_sample'));

-- -------------------------------------------------------------
-- 5) Aggregate cache — keeps the storefront badge cheap and lets us
--    push reviews.rating / reviews.rating_count metafields to Shopify.
-- -------------------------------------------------------------
create table if not exists public.review_aggregates (
  shop_domain     text not null,
  product_handle  text not null,
  rating_sum      integer not null default 0,
  rating_count    integer not null default 0,
  average         numeric(3,2) not null default 0,
  synced_at       timestamptz,
  updated_at      timestamptz not null default now(),
  primary key (shop_domain, product_handle)
);

alter table public.review_aggregates enable row level security;
revoke all on public.review_aggregates from anon, authenticated;

-- Recompute one product's aggregate from approved reviews.
create or replace function public.recompute_aggregate(p_shop text, p_handle text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sum   integer;
  v_count integer;
begin
  select coalesce(sum(rating), 0), count(*)
    into v_sum, v_count
    from public.reviews
   where shop_domain = p_shop
     and status = 'approved'
     and (product_handle = p_handle or product_id = p_handle);

  insert into public.review_aggregates
    (shop_domain, product_handle, rating_sum, rating_count, average, updated_at)
  values
    (p_shop, p_handle, v_sum, v_count,
     case when v_count = 0 then 0 else round(v_sum::numeric / v_count, 2) end,
     now())
  on conflict (shop_domain, product_handle) do update
    set rating_sum   = excluded.rating_sum,
        rating_count = excluded.rating_count,
        average      = excluded.average,
        updated_at   = now();
end;
$$;

-- Keep the cache warm automatically on any review change.
create or replace function public.reviews_touch_aggregate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_handle text;
begin
  v_handle := coalesce(new.product_handle, new.product_id,
                       old.product_handle, old.product_id);
  if v_handle is not null then
    perform public.recompute_aggregate(
      coalesce(new.shop_domain, old.shop_domain), v_handle);
  end if;
  return null;
end;
$$;

drop trigger if exists trg_reviews_aggregate on public.reviews;
create trigger trg_reviews_aggregate
  after insert or update of status, rating, product_handle, product_id
     or delete
  on public.reviews
  for each row execute function public.reviews_touch_aggregate();

-- Seed the cache from whatever is already in the table.
insert into public.review_aggregates
  (shop_domain, product_handle, rating_sum, rating_count, average)
select shop_domain,
       coalesce(product_handle, product_id) as handle,
       sum(rating),
       count(*),
       round(sum(rating)::numeric / count(*), 2)
  from public.reviews
 where status = 'approved'
   and coalesce(product_handle, product_id) is not null
 group by shop_domain, coalesce(product_handle, product_id)
on conflict (shop_domain, product_handle) do nothing;

-- -------------------------------------------------------------
-- 6) Compliance request log
--    Evidence that the mandatory privacy webhooks actually did
--    something. Reviewers ask; auditors ask louder.
-- -------------------------------------------------------------
create table if not exists public.compliance_requests (
  id                  uuid primary key default gen_random_uuid(),
  shop_domain         text not null,
  kind                text not null
                        check (kind in ('data_request', 'customer_redact', 'shop_redact')),
  shopify_customer_id text,
  customer_email      text,
  payload             jsonb,
  export_data         jsonb,
  received_at         timestamptz not null default now(),
  completed_at        timestamptz
);

create index if not exists idx_compliance_shop on public.compliance_requests (shop_domain, received_at desc);
create index if not exists idx_compliance_open on public.compliance_requests (received_at)
  where completed_at is null;

alter table public.compliance_requests enable row level security;
revoke all on public.compliance_requests from anon, authenticated;

comment on table public.compliance_requests is
  'Audit trail for customers/data_request, customers/redact and shop/redact. Must be actioned within 30 days.';

-- NOTE: compliance_requests intentionally has NO foreign key to shops.
-- shop/redact deletes the shops row, and the log entry must survive it.

-- #############################################################
-- # 008 — production readiness
-- # source: supabase/migrations/008_production.sql
-- #############################################################

-- =============================================================
-- Migration 008 — Production readiness
--
-- Adds the pieces the storefront and admin need to stop doing work
-- in JavaScript that the database should be doing:
--
--   · rating distribution, so the 5/4/3/2/1 bars are one lookup
--   · image metadata, so a thumbnail strip doesn't download five
--     full-resolution photos
--   · a real Shopify product id, so a product rename or delete can
--     find its reviews (handles change, ids don't)
--   · webhook de-duplication, because Shopify retries
--   · a 'rejected' review status distinct from 'hidden'
--   · the settings a merchant configures in the admin
--
-- Run in the Supabase SQL Editor, after 007. Safe to re-run.
-- =============================================================

create extension if not exists "pgcrypto";

-- -------------------------------------------------------------
-- 1) Reviews: image metadata, product identity, lifecycle
-- -------------------------------------------------------------

-- image_urls stays as-is (existing rows and the public API depend on
-- it). image_meta carries the richer per-photo record written by the
-- current uploader: a compressed full-size URL, a small thumbnail URL,
-- and intrinsic dimensions so the layout can reserve space.
--   [{ "url": "...", "thumb": "...", "w": 1600, "h": 1200 }]
alter table public.reviews
  add column if not exists image_meta jsonb not null default '[]'::jsonb;

-- The numeric Shopify product id. product_handle is what the storefront
-- matches on, but handles change when a merchant renames a product —
-- this is the stable key the products/update webhook repoints from.
alter table public.reviews
  add column if not exists shopify_product_id text;

-- Set when products/delete arrives. The review is kept (the merchant
-- may restore or re-create the product) but it stops counting towards
-- a live product's rating.
alter table public.reviews
  add column if not exists product_deleted_at timestamptz;

comment on column public.reviews.shopify_product_id is
  'Numeric Shopify product id. Stable across renames — product_handle is not.';
comment on column public.reviews.image_meta is
  'Array of {url, thumb, w, h}. image_urls remains the flat list of full-size URLs.';

-- 'rejected' is a merchant decision ("this is spam / abusive").
-- 'hidden' predates it and is kept so existing rows stay valid.
-- Neither is ever public.
alter table public.reviews drop constraint if exists reviews_status_check;
alter table public.reviews
  add constraint reviews_status_check
  check (status in ('approved', 'pending', 'hidden', 'rejected'));

-- -------------------------------------------------------------
-- 2) Indexes for the queries the app actually runs
-- -------------------------------------------------------------

-- The storefront's paged product query: shop + handle + status,
-- ordered by featured then newest.
create index if not exists idx_reviews_product_page
  on public.reviews (shop_domain, product_handle, status, is_featured desc, created_at desc);

-- The admin's rating filter and the moderation queue.
create index if not exists idx_reviews_shop_status_rating
  on public.reviews (shop_domain, status, rating);

create index if not exists idx_reviews_shop_created
  on public.reviews (shop_domain, created_at desc);

-- "Reviews with photos" on the dashboard, and the shopper-facing
-- photos-only filter. A generated column keeps that filter a plain
-- indexed equality instead of an array comparison threaded through
-- the query string.
alter table public.reviews
  add column if not exists has_images boolean
  generated always as (image_urls <> '{}') stored;

create index if not exists idx_reviews_with_images
  on public.reviews (shop_domain, status, has_images);

-- Repointing reviews after a product rename.
create index if not exists idx_reviews_shopify_product_id
  on public.reviews (shop_domain, shopify_product_id)
  where shopify_product_id is not null;

-- Spam guard lookup: submissions from one IP in the last hour.
create index if not exists idx_reviews_ip_recent
  on public.reviews (shop_domain, submitted_ip, created_at desc)
  where submitted_ip is not null;

-- -------------------------------------------------------------
-- 3) Aggregates: rating distribution + photo count
--
-- The storefront asks for "4.7, 1,324 reviews, and the 5/4/3/2/1
-- breakdown" on every product page. Without these columns that is a
-- full scan of the product's reviews on every request.
-- -------------------------------------------------------------
alter table public.review_aggregates
  add column if not exists count_1      integer not null default 0,
  add column if not exists count_2      integer not null default 0,
  add column if not exists count_3      integer not null default 0,
  add column if not exists count_4      integer not null default 0,
  add column if not exists count_5      integer not null default 0,
  add column if not exists images_count integer not null default 0,
  add column if not exists metafield_synced_at timestamptz;

-- Recompute one product's aggregate from its approved reviews.
-- Replaces the 007 version: same signature, now also fills the
-- distribution and the photo count.
create or replace function public.recompute_aggregate(p_shop text, p_handle text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sum    integer;
  v_count  integer;
  v_c1     integer;
  v_c2     integer;
  v_c3     integer;
  v_c4     integer;
  v_c5     integer;
  v_images integer;
begin
  select coalesce(sum(rating), 0),
         count(*),
         count(*) filter (where rating = 1),
         count(*) filter (where rating = 2),
         count(*) filter (where rating = 3),
         count(*) filter (where rating = 4),
         count(*) filter (where rating = 5),
         count(*) filter (where image_urls <> '{}')
    into v_sum, v_count, v_c1, v_c2, v_c3, v_c4, v_c5, v_images
    from public.reviews
   where shop_domain = p_shop
     and status = 'approved'
     and product_deleted_at is null
     and (product_handle = p_handle or product_id = p_handle);

  if v_count = 0 then
    -- Nothing approved left under this handle. Drop the row so a
    -- renamed or emptied product stops showing a stale badge.
    delete from public.review_aggregates
     where shop_domain = p_shop and product_handle = p_handle;
    return;
  end if;

  insert into public.review_aggregates
    (shop_domain, product_handle, rating_sum, rating_count, average,
     count_1, count_2, count_3, count_4, count_5, images_count, updated_at)
  values
    (p_shop, p_handle, v_sum, v_count, round(v_sum::numeric / v_count, 2),
     v_c1, v_c2, v_c3, v_c4, v_c5, v_images, now())
  on conflict (shop_domain, product_handle) do update
    set rating_sum   = excluded.rating_sum,
        rating_count = excluded.rating_count,
        average      = excluded.average,
        count_1      = excluded.count_1,
        count_2      = excluded.count_2,
        count_3      = excluded.count_3,
        count_4      = excluded.count_4,
        count_5      = excluded.count_5,
        images_count = excluded.images_count,
        -- A changed aggregate means the Shopify metafield is now stale.
        metafield_synced_at = null,
        updated_at   = now();
end;
$$;

-- The 007 trigger only recomputed the NEW handle. When a merchant
-- renames a product, the reviews move to a new handle and the OLD
-- aggregate row is left behind — a product card that keeps showing a
-- rating for a product that no longer has those reviews. Recompute
-- both sides.
create or replace function public.reviews_touch_aggregate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shop     text;
  v_new      text;
  v_old      text;
begin
  v_shop := coalesce(new.shop_domain, old.shop_domain);
  v_new  := coalesce(new.product_handle, new.product_id);
  v_old  := coalesce(old.product_handle, old.product_id);

  if v_new is not null then
    perform public.recompute_aggregate(v_shop, v_new);
  end if;
  if v_old is not null and v_old is distinct from v_new then
    perform public.recompute_aggregate(v_shop, v_old);
  end if;

  return null;
end;
$$;

drop trigger if exists trg_reviews_aggregate on public.reviews;
create trigger trg_reviews_aggregate
  after insert or delete
     or update of status, rating, product_handle, product_id,
                  image_urls, product_deleted_at
  on public.reviews
  for each row execute function public.reviews_touch_aggregate();

-- Rebuild every aggregate once, so the new columns are populated for
-- reviews that already exist.
do $$
declare
  r record;
begin
  for r in
    select distinct shop_domain, coalesce(product_handle, product_id) as handle
      from public.reviews
     where coalesce(product_handle, product_id) is not null
  loop
    perform public.recompute_aggregate(r.shop_domain, r.handle);
  end loop;
end;
$$;

-- -------------------------------------------------------------
-- 4) Webhook de-duplication
--
-- Shopify retries a webhook until it gets a 2xx, and can deliver the
-- same event more than once even after one. Every handler records its
-- delivery id here first; a duplicate insert means "already done".
-- -------------------------------------------------------------
create table if not exists public.webhook_events (
  webhook_id  text primary key,
  shop_domain text not null,
  topic       text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  error       text
);

create index if not exists idx_webhook_events_received
  on public.webhook_events (received_at);
create index if not exists idx_webhook_events_shop
  on public.webhook_events (shop_domain, topic, received_at desc);

alter table public.webhook_events enable row level security;
revoke all on public.webhook_events from anon, authenticated;

comment on table public.webhook_events is
  'De-duplication log keyed by the X-Shopify-Webhook-Id header. Rows older than 30 days can be purged.';

-- -------------------------------------------------------------
-- 5) Merchant settings the admin now exposes
-- -------------------------------------------------------------

-- 007 capped this at 3..50. The admin offers 5 / 10 / 20 / 50 and a
-- custom value, so widen the range and keep the guard.
alter table public.shop_settings drop constraint if exists shop_settings_reviews_per_page_check;
alter table public.shop_settings
  add constraint shop_settings_reviews_per_page_check
  check (reviews_per_page between 1 and 100);

alter table public.shop_settings
  -- How the shopper gets to review 11 onwards.
  add column if not exists pagination_style text not null default 'load_more',
  -- The 5/4/3/2/1 breakdown above the review list.
  add column if not exists show_rating_distribution boolean not null default true,
  -- Show shopper photos on the storefront at all.
  add column if not exists show_review_images boolean not null default true,
  -- Let shoppers submit from the storefront (off = display only).
  add column if not exists allow_submissions boolean not null default true,
  add column if not exists require_title boolean not null default false,
  add column if not exists require_email boolean not null default false,
  add column if not exists max_photos integer not null default 5,
  -- Where the rating sits on the product page when the app places it
  -- automatically. A merchant who adds the Product rating badge block
  -- from the theme editor controls placement directly and this is
  -- ignored for them.
  add column if not exists badge_placement text not null default 'price',
  -- Product-card badge appearance.
  add column if not exists badge_show_verified_icon boolean not null default true,
  add column if not exists badge_count_format text not null default 'compact',
  add column if not exists badge_align text not null default 'center',
  -- Where the badge sits inside a product card.
  add column if not exists card_badge_position text not null default 'above_price',
  -- Product / AggregateRating structured data. Off if the theme
  -- already emits its own rating markup.
  add column if not exists enable_rich_snippets boolean not null default true,
  -- Historical behaviour: store-wide reviews were mixed into every
  -- product page, which made the product page count disagree with the
  -- product card badge. Off by default; a merchant who wants the old
  -- behaviour can switch it back on.
  add column if not exists include_store_reviews_on_product boolean not null default false;

alter table public.shop_settings drop constraint if exists shop_settings_pagination_style_check;
alter table public.shop_settings
  add constraint shop_settings_pagination_style_check
  check (pagination_style in ('load_more', 'pagination'));

alter table public.shop_settings drop constraint if exists shop_settings_badge_count_format_check;
alter table public.shop_settings
  add constraint shop_settings_badge_count_format_check
  check (badge_count_format in ('compact', 'full'));

alter table public.shop_settings drop constraint if exists shop_settings_badge_placement_check;
alter table public.shop_settings
  add constraint shop_settings_badge_placement_check
  check (badge_placement in ('title', 'price'));

alter table public.shop_settings drop constraint if exists shop_settings_badge_align_check;
alter table public.shop_settings
  add constraint shop_settings_badge_align_check
  check (badge_align in ('inherit', 'start', 'center'));

alter table public.shop_settings drop constraint if exists shop_settings_card_badge_position_check;
alter table public.shop_settings
  add constraint shop_settings_card_badge_position_check
  check (card_badge_position in ('above_price', 'beside_price', 'below_title'));

alter table public.shop_settings drop constraint if exists shop_settings_max_photos_check;
alter table public.shop_settings
  add constraint shop_settings_max_photos_check
  check (max_photos between 1 and 10);

-- -------------------------------------------------------------
-- 6) Retire the store-key snippet distribution
--
-- The app is now distributed through the Shopify App Store only. The
-- store_key column authenticated a public, cross-origin API that no
-- longer exists; leaving a live credential column behind is the kind
-- of thing a security reviewer asks about.
-- -------------------------------------------------------------
alter table public.shops drop constraint if exists shops_install_source_check;
alter table public.shops
  add constraint shops_install_source_check
  check (install_source in ('app', 'snippet'));

drop index if exists public.idx_shops_store_key;
alter table public.shops drop column if exists store_key;

-- -------------------------------------------------------------
-- 7) The reviews table's own RLS policy
--
-- 002 left a policy allowing anon to select every approved review in
-- the database — across every shop. Nothing uses it (the app reads
-- with the service role), and it is a cross-tenant read waiting to
-- happen the first time someone hands out the anon key.
-- -------------------------------------------------------------
drop policy if exists "Public read approved reviews" on public.reviews;
revoke all on public.reviews from anon, authenticated;
revoke all on public.shops  from anon, authenticated;

-- -------------------------------------------------------------
-- 8) Storage: keep review images readable, uploads service-role only
--
-- 002 created an INSERT policy with `with check (bucket_id = ...)` and
-- no role restriction, which let anyone holding the anon key write
-- into the bucket. Uploads now go through short-lived signed URLs
-- minted by the server, so no client-side insert policy is needed.
-- -------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('review-images', 'review-images', true, 8388608,
        array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic'])
on conflict (id) do update
  set public             = true,
      file_size_limit    = 8388608,
      allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic'];

drop policy if exists "Service role uploads" on storage.objects;

drop policy if exists "Public read review images" on storage.objects;
create policy "Public read review images"
  on storage.objects for select
  using (bucket_id = 'review-images');

-- -------------------------------------------------------------
-- 9) Dashboard statistics in one round trip
--
-- The admin overview wants total / approved / pending / rejected /
-- with-photos and the store-wide average. Fetching rows and counting
-- them in JavaScript is fine at fifty reviews and a memory problem at
-- fifty thousand, so it is one aggregate query instead.
-- -------------------------------------------------------------
create or replace function public.shop_review_stats(p_shop text)
returns table (
  total        bigint,
  approved     bigint,
  pending      bigint,
  rejected     bigint,
  with_images  bigint,
  average      numeric,
  last_30_days bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    count(*)                                                          as total,
    count(*) filter (where status = 'approved')                       as approved,
    count(*) filter (where status = 'pending')                        as pending,
    count(*) filter (where status in ('rejected', 'hidden'))          as rejected,
    count(*) filter (where has_images)                                as with_images,
    coalesce(round(avg(rating) filter (where status = 'approved'), 2), 0) as average,
    count(*) filter (where created_at > now() - interval '30 days')   as last_30_days
  from public.reviews
  where shop_domain = p_shop;
$$;

-- The function takes the shop as an argument, so it must never be
-- callable by anything that could pass a different one.
revoke all on function public.shop_review_stats(text) from public;
revoke all on function public.shop_review_stats(text) from anon, authenticated;

-- #############################################################
-- # Post-install verification
-- #
-- # Every one of these tables holds merchant or shopper data and
-- # must be reachable only by the service role. Anything other than
-- # "locked" below is a cross-tenant read waiting to happen.
-- #############################################################

select
  c.relname                                        as table_name,
  case when c.relrowsecurity then 'on' else 'OFF' end as rls,
  count(p.polname)                                 as policies,
  case
    when c.relrowsecurity and count(p.polname) = 0 then 'locked'
    else 'CHECK THIS'
  end                                              as verdict
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
left join pg_policy p on p.polrelid = c.oid
where n.nspname = 'public'
  and c.relname in ('reviews', 'shops', 'shop_settings', 'shopify_sessions',
                    'review_aggregates', 'compliance_requests', 'webhook_events')
group by c.relname, c.relrowsecurity
order by c.relname;
