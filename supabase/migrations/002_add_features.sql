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
