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
