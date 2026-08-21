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
