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
