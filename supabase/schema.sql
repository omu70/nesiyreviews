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
