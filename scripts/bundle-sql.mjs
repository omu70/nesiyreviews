// =============================================================
// Regenerate supabase/full-setup.sql
// File: /scripts/bundle-sql.mjs
//
//   npm run db:bundle
//
// The individual migration files stay the source of truth. This
// concatenates them, in order, into one file that can be pasted into
// the Supabase SQL editor in a single go — which is how a merchant's
// database actually gets set up, and a much smaller target for
// "ran them in the wrong order" than eight separate pastes.
// =============================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const FILES = [
  ["supabase/schema.sql", "001 — base tables"],
  ["supabase/migrations/002_add_features.sql", "002 — images, source tracking, storage bucket"],
  ["supabase/migrations/003_add_location.sql", "003 — reviewer location"],
  ["supabase/migrations/004_trustoo_compat.sql", "004 — title, email, reply, featured"],
  ["supabase/migrations/005_store_reviews.sql", "005 — store-wide reviews"],
  ["supabase/migrations/006_store_keys.sql", "006 — (historical) snippet distribution"],
  ["supabase/migrations/007_shopify_app.sql", "007 — sessions, settings, aggregates, compliance"],
  ["supabase/migrations/008_production.sql", "008 — production readiness"],
];

const VERIFY = `

-- #############################################################
-- # Post-install verification
-- #
-- # Every one of these tables holds merchant or shopper data and
-- # must be reachable only by the service role. Anything other than
-- # "locked" below is a cross-tenant read waiting to happen.
-- #############################################################

select
  c.relname                                        as table_name,
  case when c.relrowsecurity then 'on' else 'OFF' end as rls,
  count(p.polname)                                 as policies,
  case
    when c.relrowsecurity and count(p.polname) = 0 then 'locked'
    else 'CHECK THIS'
  end                                              as verdict
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
left join pg_policy p on p.polrelid = c.oid
where n.nspname = 'public'
  and c.relname in ('reviews', 'shops', 'shop_settings', 'shopify_sessions',
                    'review_aggregates', 'compliance_requests', 'webhook_events')
group by c.relname, c.relrowsecurity
order by c.relname;
`;

let out = `-- =============================================================
-- Evo Labs Product Reviews — complete database setup
-- File: /supabase/full-setup.sql
--
-- Every migration, in order, in one file. Paste the whole thing into
-- the Supabase SQL editor and run it once.
--
-- Safe to re-run: every statement is idempotent, and running this
-- against a database that already has some of the migrations applied
-- brings it up to date rather than failing.
--
-- Generated from the individual files in supabase/ — those remain the
-- source of truth. Regenerate with:  npm run db:bundle
--
-- Contents:
${FILES.map(([, label]) => `--   ${label}`).join("\n")}
-- =============================================================
`;

for (const [file, label] of FILES) {
  const body = fs.readFileSync(path.join(ROOT, file), "utf8").replace(/\s+$/, "");
  out +=
    `\n\n-- #############################################################\n` +
    `-- # ${label}\n` +
    `-- # source: ${file}\n` +
    `-- #############################################################\n\n` +
    body;
}

out += VERIFY;

const target = path.join(ROOT, "supabase/full-setup.sql");
fs.writeFileSync(target, out.replace(/\n+$/, "\n"));
console.log(`wrote ${path.relative(ROOT, target)} — ${out.split("\n").length} lines`);
