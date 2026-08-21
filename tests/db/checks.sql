-- =============================================================
-- Behavioural checks against a freshly migrated database
-- File: /tests/db/checks.sql
--
-- Run by tests/db/apply.sh. Every check raises an exception on
-- failure, so psql's ON_ERROR_STOP turns a wrong answer into a
-- non-zero exit rather than a line of output nobody reads.
-- =============================================================

\set ON_ERROR_STOP on
-- Results are all empty; the pass/fail signal is the NOTICEs on stderr
-- and a non-zero exit on the first failure.
\o /dev/null

create or replace function assert_eq(actual anyelement, expected anyelement, what text)
returns void language plpgsql as $$
begin
  if actual is distinct from expected then
    raise exception '% — expected %, got %', what, expected, actual;
  end if;
  raise notice '   ok  %', what;
end;
$$;

do $$
begin
  -- Two shops, so every check below is also a tenant-isolation check.
  delete from public.reviews      where shop_domain like 'check-%';
  delete from public.shop_settings where shop_domain like 'check-%';
  delete from public.shops        where shop_domain like 'check-%';

  insert into public.shops (shop_domain) values ('check-a.myshopify.com'), ('check-b.myshopify.com');
  insert into public.shop_settings (shop_domain)
       values ('check-a.myshopify.com'), ('check-b.myshopify.com')
  on conflict do nothing;
end
$$;

-- -------------------------------------------------------------
-- Aggregates: only approved reviews count
-- -------------------------------------------------------------
insert into public.reviews
  (shop_domain, product_id, product_handle, shopify_product_id, author_name, author_initials,
   rating, content, status, source, image_urls)
values
  ('check-a.myshopify.com', 'widget', 'widget', '111', 'A', 'A', 5, 'good',   'approved', 'manual', '{}'),
  ('check-a.myshopify.com', 'widget', 'widget', '111', 'B', 'B', 5, 'good',   'approved', 'manual', '{"https://x/1.jpg"}'),
  ('check-a.myshopify.com', 'widget', 'widget', '111', 'C', 'C', 3, 'okay',   'approved', 'manual', '{}'),
  ('check-a.myshopify.com', 'widget', 'widget', '111', 'D', 'D', 1, 'bad',    'pending',  'manual', '{}'),
  ('check-a.myshopify.com', 'widget', 'widget', '111', 'E', 'E', 1, 'spam',   'rejected', 'manual', '{}'),
  -- Same handle, different shop. Must never mix.
  ('check-b.myshopify.com', 'widget', 'widget', '222', 'Z', 'Z', 1, 'awful',  'approved', 'manual', '{}');

select assert_eq(
  (select rating_count from public.review_aggregates
    where shop_domain = 'check-a.myshopify.com' and product_handle = 'widget'),
  3::integer,
  'aggregate counts only approved reviews');

select assert_eq(
  (select average from public.review_aggregates
    where shop_domain = 'check-a.myshopify.com' and product_handle = 'widget'),
  4.33::numeric(3,2),
  'aggregate average is (5+5+3)/3');

select assert_eq(
  (select count_5 from public.review_aggregates
    where shop_domain = 'check-a.myshopify.com' and product_handle = 'widget'),
  2::integer,
  'rating distribution is maintained');

select assert_eq(
  (select images_count from public.review_aggregates
    where shop_domain = 'check-a.myshopify.com' and product_handle = 'widget'),
  1::integer,
  'photo count is maintained');

select assert_eq(
  (select rating_count from public.review_aggregates
    where shop_domain = 'check-b.myshopify.com' and product_handle = 'widget'),
  1::integer,
  'the same handle in another shop keeps its own aggregate');

-- has_images is generated, not written
select assert_eq(
  (select count(*)::int from public.reviews
    where shop_domain = 'check-a.myshopify.com' and has_images),
  1,
  'has_images tracks image_urls automatically');

-- -------------------------------------------------------------
-- Approving a pending review moves the numbers
-- -------------------------------------------------------------
update public.reviews set status = 'approved'
 where shop_domain = 'check-a.myshopify.com' and author_name = 'D';

select assert_eq(
  (select rating_count from public.review_aggregates
    where shop_domain = 'check-a.myshopify.com' and product_handle = 'widget'),
  4::integer,
  'approving a review updates the count');

select assert_eq(
  (select count_1 from public.review_aggregates
    where shop_domain = 'check-a.myshopify.com' and product_handle = 'widget'),
  1::integer,
  'approving a review updates the distribution');

-- -------------------------------------------------------------
-- A rename moves the aggregate and leaves nothing behind
-- -------------------------------------------------------------
update public.reviews
   set product_handle = 'widget-pro', product_id = 'widget-pro'
 where shop_domain = 'check-a.myshopify.com' and shopify_product_id = '111';

select assert_eq(
  (select count(*)::int from public.review_aggregates
    where shop_domain = 'check-a.myshopify.com' and product_handle = 'widget'),
  0,
  'the old handle stops showing a rating after a rename');

select assert_eq(
  (select rating_count from public.review_aggregates
    where shop_domain = 'check-a.myshopify.com' and product_handle = 'widget-pro'),
  4::integer,
  'the new handle carries the rating after a rename');

-- -------------------------------------------------------------
-- A deleted product retires its reviews without destroying them
-- -------------------------------------------------------------
update public.reviews set product_deleted_at = now()
 where shop_domain = 'check-a.myshopify.com' and shopify_product_id = '111';

select assert_eq(
  (select count(*)::int from public.review_aggregates
    where shop_domain = 'check-a.myshopify.com' and product_handle = 'widget-pro'),
  0,
  'a deleted product stops counting towards a rating');

select assert_eq(
  (select count(*)::int from public.reviews
    where shop_domain = 'check-a.myshopify.com' and shopify_product_id = '111'),
  5,
  'but the reviews themselves survive');

-- Re-creating the product brings them back.
update public.reviews set product_deleted_at = null
 where shop_domain = 'check-a.myshopify.com' and shopify_product_id = '111';

select assert_eq(
  (select rating_count from public.review_aggregates
    where shop_domain = 'check-a.myshopify.com' and product_handle = 'widget-pro'),
  4::integer,
  'restoring the product restores the rating');

-- -------------------------------------------------------------
-- The dashboard statistics function
-- -------------------------------------------------------------
select assert_eq(
  (select total::int from public.shop_review_stats('check-a.myshopify.com')),
  5,
  'shop_review_stats counts every review');

select assert_eq(
  (select approved::int from public.shop_review_stats('check-a.myshopify.com')),
  4,
  'shop_review_stats counts approved reviews');

select assert_eq(
  (select rejected::int from public.shop_review_stats('check-a.myshopify.com')),
  1,
  'shop_review_stats counts rejected and hidden together');

select assert_eq(
  (select with_images::int from public.shop_review_stats('check-a.myshopify.com')),
  1,
  'shop_review_stats counts reviews with photos');

select assert_eq(
  (select round(average, 2) from public.shop_review_stats('check-a.myshopify.com')),
  3.50::numeric,
  'shop_review_stats averages approved reviews only');

select assert_eq(
  (select total::int from public.shop_review_stats('check-b.myshopify.com')),
  1,
  'shop_review_stats is scoped to one shop');

-- -------------------------------------------------------------
-- Constraints hold
-- -------------------------------------------------------------
do $$
begin
  begin
    insert into public.reviews
      (shop_domain, author_name, author_initials, rating, content, status, source)
    values ('check-a.myshopify.com', 'X', 'X', 9, 'nope', 'approved', 'manual');
    raise exception 'a rating of 9 was accepted';
  exception when check_violation then
    raise notice '   ok  rating is constrained to 1-5';
  end;

  begin
    insert into public.reviews
      (shop_domain, author_name, author_initials, rating, content, status, source)
    values ('check-a.myshopify.com', 'X', 'X', 5, 'nope', 'invented', 'manual');
    raise exception 'an invented status was accepted';
  exception when check_violation then
    raise notice '   ok  status is constrained';
  end;

  begin
    update public.shop_settings set reviews_per_page = 0
     where shop_domain = 'check-a.myshopify.com';
    raise exception 'a display limit of 0 was accepted';
  exception when check_violation then
    raise notice '   ok  the display limit is constrained';
  end;

  begin
    update public.shop_settings set pagination_style = 'infinite'
     where shop_domain = 'check-a.myshopify.com';
    raise exception 'an unknown pagination style was accepted';
  exception when check_violation then
    raise notice '   ok  pagination style is constrained';
  end;
end
$$;

-- -------------------------------------------------------------
-- Webhook de-duplication
-- -------------------------------------------------------------
do $$
begin
  delete from public.webhook_events where webhook_id = 'check-delivery-1';
  insert into public.webhook_events (webhook_id, shop_domain, topic)
       values ('check-delivery-1', 'check-a.myshopify.com', 'PRODUCTS_UPDATE');
  begin
    insert into public.webhook_events (webhook_id, shop_domain, topic)
         values ('check-delivery-1', 'check-a.myshopify.com', 'PRODUCTS_UPDATE');
    raise exception 'a duplicate delivery id was accepted';
  exception when unique_violation then
    raise notice '   ok  a repeated webhook delivery is rejected';
  end;
end
$$;

-- -------------------------------------------------------------
-- The retired snippet credential is gone
-- -------------------------------------------------------------
select assert_eq(
  (select count(*)::int from information_schema.columns
    where table_schema = 'public' and table_name = 'shops' and column_name = 'store_key'),
  0,
  'the retired store_key column has been dropped');

select assert_eq(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename = 'reviews'),
  0,
  'reviews has no RLS policy — service role only');

-- -------------------------------------------------------------
-- Cascade: removing a shop removes its data
-- -------------------------------------------------------------
delete from public.shops where shop_domain = 'check-b.myshopify.com';

select assert_eq(
  (select count(*)::int from public.reviews where shop_domain = 'check-b.myshopify.com'),
  0,
  'deleting a shop cascades to its reviews');

-- Tidy up so a re-run starts clean.
delete from public.reviews       where shop_domain like 'check-%';
delete from public.shop_settings where shop_domain like 'check-%';
delete from public.review_aggregates where shop_domain like 'check-%';
delete from public.webhook_events where shop_domain like 'check-%';
delete from public.shops         where shop_domain like 'check-%';
drop function if exists assert_eq(anyelement, anyelement, text);
