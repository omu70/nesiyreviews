-- =============================================================
-- Migration 003 — Add author location to reviews
-- Run in Supabase SQL Editor (safe to re-run).
-- =============================================================

alter table public.reviews
  add column if not exists author_location text;

create index if not exists idx_reviews_author_location on public.reviews (author_location);
