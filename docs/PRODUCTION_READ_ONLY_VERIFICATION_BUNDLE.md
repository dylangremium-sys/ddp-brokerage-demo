# Production Read-Only Verification Bundle

Last updated: 2026-07-25

Purpose: establish direct, reproducible evidence of production database state
without modifying data or schema.

This document is intentionally read-only. No `INSERT`, `UPDATE`, `DELETE`,
`ALTER`, `CREATE`, `DROP`, or `TRUNCATE` statements are included.

## Security posture for this procedure

- Use a read-only SQL session.
- Do not run ad hoc writes.
- Save raw outputs and checksums for evidence retention.
- If any query fails due to permission or missing objects, record the exact
  error text and stop scope expansion.

## Required operator inputs

The following values are required but not stored in repository docs:

- `PROD_DB_URL`: production Postgres/Supabase connection string
- `STAGING_DB_URL`: staging Postgres/Supabase connection string
- optional: a secure path for evidence artifacts

If credentials are unavailable, the launch process is blocked at evidence
collection and status remains `UNKNOWN`.

## Query bundle (read-only)

Run this SQL against each environment (staging, production).

```sql
-- 1) Migration history surface (supports Supabase migration history variants)
select
  n.nspname as schema_name,
  c.relname as table_name
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where c.relkind = 'r'
  and c.relname in ('schema_migrations', 'supabase_migrations')
order by 1,2;

-- 2) Core migration file object presence by naming convention (table/function/trigger)
select
  n.nspname as schema_name,
  c.relname as object_name,
  c.relkind as object_kind
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname in ('public', 'auth')
  and (
    c.relname ilike '%buyer_pack%'
    or c.relname ilike '%procurement%'
    or c.relname ilike '%evidence_request%'
    or c.relname ilike '%watchtower%'
    or c.relname ilike '%compliance%'
    or c.relname ilike '%farm%'
  )
order by 1,2;

-- 3) Function inventory for launch-critical domains
select
  n.nspname as schema_name,
  p.proname as function_name,
  pg_get_function_identity_arguments(p.oid) as args
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname in ('public', 'auth')
  and (
    p.proname ilike '%buyer_pack%'
    or p.proname ilike '%procurement%'
    or p.proname ilike '%evidence%'
    or p.proname ilike '%watchtower%'
    or p.proname ilike '%farm%'
    or p.proname ilike '%compliance%'
  )
order by 1,2;

-- 4) Trigger inventory for append-only and guard behavior
select
  event_object_schema,
  event_object_table,
  trigger_name,
  action_timing,
  event_manipulation,
  action_statement
from information_schema.triggers
where event_object_schema = 'public'
  and (
    event_object_table ilike '%buyer_pack%'
    or event_object_table ilike '%procurement%'
    or event_object_table ilike '%evidence%'
    or event_object_table ilike '%watchtower%'
    or event_object_table ilike '%farm%'
    or event_object_table ilike '%compliance%'
  )
order by 1,2,3;

-- 5) RLS enabled state for critical tables
select
  schemaname,
  tablename,
  rowsecurity,
  forcerowsecurity
from pg_tables
where schemaname = 'public'
  and tablename in (
    'farms',
    'farm_profiles',
    'farm_memberships',
    'inventory_batches',
    'documents',
    'buyer_pack_snapshots',
    'procurement_decisions',
    'legal_updates',
    'compliance_rules',
    'compliance_alerts',
    'compliance_audit_log',
    'watchtower_ingestion_runs',
    'watchtower_source_registry'
  )
order by tablename;

-- 6) RLS policies for critical tables
select
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd,
  qual,
  with_check
from pg_policies
where schemaname = 'public'
  and tablename in (
    'farms',
    'farm_profiles',
    'farm_memberships',
    'inventory_batches',
    'documents',
    'buyer_pack_snapshots',
    'procurement_decisions',
    'legal_updates',
    'compliance_rules',
    'compliance_alerts',
    'compliance_audit_log',
    'watchtower_ingestion_runs',
    'watchtower_source_registry'
  )
order by tablename, policyname;

-- 7) Storage policies surface (Supabase storage)
select
  schemaname,
  tablename,
  policyname,
  roles,
  cmd
from pg_policies
where schemaname = 'storage'
order by tablename, policyname;
```

## Operator command bundle

Use these exact commands from a secure shell:

```bash
set -euo pipefail

mkdir -p evidence/2026-07-25

# Run against staging
psql "$STAGING_DB_URL" -v ON_ERROR_STOP=1 -X -f - > evidence/2026-07-25/staging_readonly_verification.txt <<'SQL'
-- paste the full SQL bundle from this document here
SQL

# Run against production
psql "$PROD_DB_URL" -v ON_ERROR_STOP=1 -X -f - > evidence/2026-07-25/production_readonly_verification.txt <<'SQL'
-- paste the full SQL bundle from this document here
SQL

shasum -a 256 evidence/2026-07-25/staging_readonly_verification.txt \
  evidence/2026-07-25/production_readonly_verification.txt \
  > evidence/2026-07-25/sha256.txt
```

## Expected outputs and decision rules

1. If production object surface is missing tables/functions required by
   migrations 10/17/23/24/25/26, production parity is `NO-GO`.
2. If RLS is disabled or critical policies are absent on protected tables,
   production parity is `NO-GO`.
3. If storage policies are absent for required buckets, production parity is
   `NO-GO` for document/evidence workflows.
4. Only after both environments produce complete outputs can
   `docs/MIGRATION_RUNTIME_STATUS.md` be upgraded from `UNKNOWN`.

## State-aware production migration plan template

Do not use a blanket "apply all SQL" approach. Use this sequence:

1. Inspect production with the read-only bundle and record actual state.
2. Compare against `origin/main` migration/object expectations.
3. Build a minimal delta list of only missing migrations/objects.
4. Validate backup and restore before any write operation.
5. Apply only the approved delta in ordered batches.
6. Re-run the same read-only verification bundle.
7. Archive artifacts, checksums, and operator sign-off.

## What evidence is missing right now

Missing direct-access evidence:

- production query outputs for the bundle above,
- staging query outputs for migrations beyond the historical 10/17 record,
- timestamped, checksum-verified artifacts for both environments.

Until these artifacts are collected, launch claims about production parity must
remain unverified.
