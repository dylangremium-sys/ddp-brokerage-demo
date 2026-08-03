#!/usr/bin/env bash
# =============================================================================
# replay.sh — apply migrations to the REAL production schema, safely.
#
#   scripts/real-schema/replay.sh 52 53
#   scripts/real-schema/replay.sh --refresh 52 53      # re-take the schema dump
#
# WHAT THIS IS FOR
# scripts/disposable-pg/ proves a migration against a MINIMAL substrate: its
# public.documents is five columns where production's is eleven, and it omits
# every RLS policy the real schema carries. That is the right trade for a fast
# per-PR gate, and it means a migration can be green there and wrong in
# production. Migration 46's VERIFY was merged passing on Supabase and failing
# on the harness for the mirror-image reason; this closes the other direction.
#
# It takes a READ-ONLY schema dump of production, replays it into a disposable
# cluster, applies the named migrations with their VERIFY scripts, then rolls
# them back in reverse order and asserts the pre-state returns.
#
# WHAT IT NEVER DOES
#   • It never writes to production. The only remote command is pg_dump, and the
#     connection is asserted to belong to the read-only role before it runs.
#   • It never opens a TCP port. The local cluster is socket-only
#     (listen_addresses=''), and that is asserted after startup, not assumed.
#   • It never leaves anything behind. Teardown runs on any exit path, including
#     failure and Ctrl-C.
#
# REQUIREMENTS
#   • PostgreSQL SERVER binaries (initdb, pg_ctl, postgres) — Homebrew libpq
#     alone is client-only and cannot host a cluster. Set PG_BIN if they are not
#     on PATH, e.g. PG_BIN=/opt/homebrew/opt/postgresql@18/bin
#   • ~/.ddp_prod.env exporting PROD_RO_DATABASE_URL (the ddp_ro credential).
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
WORK="$HERE/.work"
DUMP="$WORK/prod_public.sql"
LOADABLE="$WORK/prod_public_loadable.sql"

# The role the dump is expected to be taken as. A superuser or an owner role
# would work too, which is exactly why this is checked: the guarantee worth
# having is not "it succeeded" but "it could not have written".
EXPECTED_RO_ROLE="${EXPECTED_RO_ROLE:-ddp_ro}"

REFRESH=0
MIGRATIONS=()
for arg in "$@"; do
  case "$arg" in
    --refresh) REFRESH=1 ;;
    -h|--help) sed -n '2,34p' "$0"; exit 0 ;;
    *) MIGRATIONS+=("$arg") ;;
  esac
done

if [ ${#MIGRATIONS[@]} -eq 0 ]; then
  echo "usage: $0 [--refresh] <migration-number> [<migration-number> ...]" >&2
  exit 64
fi

if [ -n "${PG_BIN:-}" ]; then export PATH="$PG_BIN:$PATH"; fi
for bin in initdb pg_ctl psql createdb postgres pg_dump; do
  command -v "$bin" >/dev/null 2>&1 || {
    echo "FAIL — '$bin' not found. Set PG_BIN to a full PostgreSQL server bin dir" >&2
    echo "       (Homebrew libpq has psql and pg_ctl but no initdb/postgres)." >&2
    exit 50
  }
done

mkdir -p "$WORK"
PGDATA="$WORK/cluster"
SOCK="$WORK/sock"

cleanup() {
  if [ -d "$PGDATA" ]; then
    pg_ctl -D "$PGDATA" -w -m immediate stop >/dev/null 2>&1 || true
    rm -rf "$PGDATA" "$SOCK"
    echo "· cluster destroyed"
  fi
}
trap cleanup EXIT INT TERM

# ── Resolve the migration file triplets before doing any work ────────────────
declare -a HARDENING VERIFY ROLLBACK LABEL
for n in "${MIGRATIONS[@]}"; do
  h=$(ls "$REPO"/"${n}"_*_HARDENING.sql 2>/dev/null | head -1 || true)
  v=$(ls "$REPO"/"${n}"_*_VERIFY.sql    2>/dev/null | head -1 || true)
  r=$(ls "$REPO"/"${n}"_*_ROLLBACK.sql  2>/dev/null | head -1 || true)
  if [ -z "$h" ] || [ -z "$v" ] || [ -z "$r" ]; then
    echo "FAIL — migration $n does not have a complete HARDENING/VERIFY/ROLLBACK triplet" >&2
    exit 64
  fi
  HARDENING+=("$h"); VERIFY+=("$v"); ROLLBACK+=("$r"); LABEL+=("$n")
done

# ── 1. The dump (the only thing that touches production) ─────────────────────
if [ ! -f "$DUMP" ] || [ "$REFRESH" -eq 1 ]; then
  [ -f "$HOME/.ddp_prod.env" ] || { echo "FAIL — ~/.ddp_prod.env not found" >&2; exit 50; }
  set -a; . "$HOME/.ddp_prod.env"; set +a
  [ -n "${PROD_RO_DATABASE_URL:-}" ] || { echo "FAIL — PROD_RO_DATABASE_URL is not set" >&2; exit 50; }

  actual_role=$(psql "$PROD_RO_DATABASE_URL" -tAc "select current_user" 2>/dev/null || true)
  if [ "$actual_role" != "$EXPECTED_RO_ROLE" ]; then
    echo "FAIL — refusing to dump: connected as '${actual_role:-<none>}', expected '$EXPECTED_RO_ROLE'." >&2
    echo "       Set EXPECTED_RO_ROLE if a different read-only role is intended." >&2
    exit 77
  fi
  echo "· dumping production schema as $actual_role (read-only)"

  # -n public ONLY: ddp_ro has no USAGE on auth or storage, so naming them makes
  # pg_dump fail on its LOCK TABLE. The shim supplies those instead.
  pg_dump "$PROD_RO_DATABASE_URL" --schema-only --no-owner -n public -f "$DUMP"
else
  echo "· reusing cached schema dump ($(wc -l < "$DUMP" | tr -d ' ') lines) — pass --refresh to re-take it"
fi

# A fresh cluster already has a public schema, so the dump's CREATE SCHEMA
# collides. Filter that ONE statement rather than dropping the schema: DROP
# SCHEMA public would discard the ALTER DEFAULT PRIVILEGES entries that make the
# REVOKE assertions in these migrations mean anything.
sed 's/^CREATE SCHEMA public;$/-- [replay.sh] CREATE SCHEMA public omitted; a fresh cluster already has one/' \
  "$DUMP" > "$LOADABLE"

# ── 2. The disposable cluster ────────────────────────────────────────────────
rm -rf "$PGDATA" "$SOCK"; mkdir -p "$PGDATA" "$SOCK"
initdb -D "$PGDATA" -U postgres --encoding=UTF8 --locale=C >/dev/null
pg_ctl -D "$PGDATA" -l "$WORK/pg.log" -o "-k $SOCK -c listen_addresses=''" -w start >/dev/null

listening=$(psql -h "$SOCK" -U postgres -d postgres -tAc "show listen_addresses")
if [ -n "$listening" ]; then
  echo "FAIL — cluster is listening on '$listening'; it must be socket-only." >&2
  exit 50
fi
echo "· disposable cluster up, socket-only ($(psql -h "$SOCK" -U postgres -d postgres -tAc 'show server_version'))"

createdb -h "$SOCK" -U postgres ddpreal
run() { psql -h "$SOCK" -U postgres -d ddpreal -v ON_ERROR_STOP=1 "$@"; }
q()   { psql -h "$SOCK" -U postgres -d ddpreal -tAc "$1"; }

# ── 3. Load the substrate, then the real schema ──────────────────────────────
run -q -f "$HERE/00_auth_storage_shim.sql" >/dev/null

# THE LOAD IS NOT PIPED AND ITS FAILURE IS NOT SWALLOWED, AND THAT IS THE POINT.
#
# A missing role aborts this part-way through under ON_ERROR_STOP=1, leaving the
# tables present but the grants and RLS policies absent — and every VERIFY in
# this repository still passes against that, because none of them depend on
# those policies. A green run over a two-thirds-loaded schema is the exact shape
# of false assurance this script exists to avoid, so the load either completes
# or the run stops here. (Observed 2026-08-03: role ddp_audit_reader was missing
# and the load stopped at line 8622 of 10020 while VERIFY reported 16/16.)
echo "· loading real production public schema"
if ! run -q -f "$LOADABLE" >/dev/null; then
  echo "FAIL — the production schema did not load COMPLETELY." >&2
  echo "       A role named by a GRANT or POLICY is probably missing from" >&2
  echo "       scripts/real-schema/00_auth_storage_shim.sql. Add it and re-run;" >&2
  echo "       do NOT proceed, because VERIFY can pass over a partial schema." >&2
  exit 10
fi

printf '· loaded: %s tables · %s RLS policies · %s functions · %s RLS-enabled tables\n' \
  "$(q "select count(*) from information_schema.tables where table_schema='public'")" \
  "$(q "select count(*) from pg_policies where schemaname='public'")" \
  "$(q "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'")" \
  "$(q "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relrowsecurity")"

# ── 4. Apply forward, VERIFY each ────────────────────────────────────────────
fingerprint() {
  q "select coalesce(string_agg(t, '|' order by t), '<none>') from (
       select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as t
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
       union all
       select 'col:' || table_name || '.' || column_name
       from information_schema.columns where table_schema = 'public'
     ) s"
}
BEFORE="$(fingerprint)"

total_pass=0
for i in "${!LABEL[@]}"; do
  echo "· apply ${LABEL[$i]} — $(basename "${HARDENING[$i]}")"
  run -q -f "${HARDENING[$i]}" >/dev/null

  out=$(run -f "${VERIFY[$i]}" 2>&1) || { echo "$out" | grep -E "VERIFY|ERROR" >&2; echo "FAIL — VERIFY ${LABEL[$i]} did not pass" >&2; exit 20; }
  passed=$(printf '%s' "$out" | grep -cE "VERIFY [A-Z]+ PASSED" || true)
  failed=$(printf '%s' "$out" | grep -cE "VERIFY [A-Z]+ FAILED" || true)
  if [ "$failed" -ne 0 ] || [ "$passed" -eq 0 ]; then
    printf '%s\n' "$out" | grep -E "VERIFY|ERROR" >&2
    echo "FAIL — VERIFY ${LABEL[$i]}: $passed passed, $failed failed" >&2
    exit 20
  fi
  printf '%s\n' "$out" | sed -n 's/.*NOTICE:  \(VERIFY [A-Z]* PASSED.*\)/    \1/p'
  echo "  ✓ VERIFY ${LABEL[$i]}: $passed sections"
  total_pass=$((total_pass + passed))
done

# ── 5. Roll back in REVERSE order and assert the pre-state returns ───────────
for (( i=${#LABEL[@]}-1; i>=0; i-- )); do
  echo "· rollback ${LABEL[$i]}"
  run -q -f "${ROLLBACK[$i]}" >/dev/null
done

AFTER="$(fingerprint)"
if [ "$BEFORE" != "$AFTER" ]; then
  echo "FAIL — rollback did not restore the pre-apply schema." >&2
  diff <(printf '%s' "$BEFORE" | tr '|' '\n') <(printf '%s' "$AFTER" | tr '|' '\n') | head -30 >&2
  exit 30
fi

echo
echo "PASS — migrations ${LABEL[*]} applied to the REAL production schema,"
echo "       $total_pass VERIFY sections passed, and rollback restored it exactly."
