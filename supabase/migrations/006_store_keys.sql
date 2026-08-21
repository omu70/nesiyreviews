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
