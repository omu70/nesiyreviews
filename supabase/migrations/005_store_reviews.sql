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
