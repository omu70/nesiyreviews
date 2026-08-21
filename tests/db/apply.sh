#!/usr/bin/env bash
# =============================================================
# Apply every migration to a throwaway Postgres, then exercise it.
# File: /tests/db/apply.sh
#
#   tests/db/apply.sh            uses a local Postgres on /tmp:5433
#   PGURL=... tests/db/apply.sh  or point it at any empty database
#
# Why this exists: the migrations are the one artefact that cannot be
# checked by a build or a linter, and a syntax error in 008 is only
# discovered when a merchant's database is half-migrated. Running them
# for real — in order, twice, to prove idempotence — costs a minute.
#
# Supabase supplies a `storage` schema that plain Postgres does not, so
# the harness stubs the two objects the migrations touch.
# =============================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

PSQL=(psql -v ON_ERROR_STOP=1 --quiet)
if [[ -n "${PGURL:-}" ]]; then
  PSQL+=("$PGURL")
else
  PSQL+=(-h /tmp -p "${PGPORT:-5433}" -U postgres -d "${PGDATABASE:-reviews_test}")
fi

echo "→ stubbing the Supabase-only schema"
"${PSQL[@]}" <<'SQL'
create schema if not exists storage;

create table if not exists storage.buckets (
  id                 text primary key,
  name               text,
  public             boolean,
  file_size_limit    bigint,
  allowed_mime_types text[]
);

create table if not exists storage.objects (
  id        uuid primary key default gen_random_uuid(),
  bucket_id text,
  name      text
);

alter table storage.objects enable row level security;

-- Supabase ships these roles; plain Postgres does not.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end
$$;
SQL

MIGRATIONS=(
  "$ROOT/supabase/schema.sql"
  "$ROOT/supabase/migrations/002_add_features.sql"
  "$ROOT/supabase/migrations/003_add_location.sql"
  "$ROOT/supabase/migrations/004_trustoo_compat.sql"
  "$ROOT/supabase/migrations/005_store_reviews.sql"
  "$ROOT/supabase/migrations/006_store_keys.sql"
  "$ROOT/supabase/migrations/007_shopify_app.sql"
  "$ROOT/supabase/migrations/008_production.sql"
)

for pass in 1 2; do
  echo "→ pass $pass"
  for file in "${MIGRATIONS[@]}"; do
    printf '   %-44s' "$(basename "$file")"
    "${PSQL[@]}" -f "$file" > /dev/null
    echo "ok"
  done
done

echo "→ behaviour"
"${PSQL[@]}" -f "$HERE/checks.sql"
