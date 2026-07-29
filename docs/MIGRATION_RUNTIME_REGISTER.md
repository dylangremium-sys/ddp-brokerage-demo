# DDP Migration / Runtime Register — AUTHORITATIVE

Last updated: **2026-07-25**
Repository: `dylangremium-sys/ddp-brokerage-demo`
`main` at time of audit: **`3c51627b58fc0b3890e06b33d74a43a86b3be091`**

This register records **hosted database state**, established by direct runtime
evidence. It is not derived from source files. Where evidence could not be
obtained, the row says `unknown` and the missing evidence is named in
[§5](#5-what-evidence-is-missing).

## Environments

| Env | Project ref | Access held during this audit | Evidence class |
|---|---|---|---|
| Staging | `szqocdab…` | `STAGING_DATABASE_URL`, superuser (`postgres`) | **Full catalog introspection + VERIFY execution** |
| Production | `iihxjrfx…` | Anon key + an authenticated admin JWT only | **PostgREST object probes only** (read-only GET) |

Production has **no** service-role key and **no** direct Postgres URL available
to this audit. Everything below marked `unknown` for production is unknown for
exactly that reason — it is invisible through PostgREST, not absent.

---

## 1. Per-migration state

Legend: `applied + verified` · `applied, verification incomplete` · `not applied` · `unknown`

| # | Migration | Staging | Production |
|---|---|---|---|
| 10 | Buyer Pack snapshots MVP | **applied + verified** — `10_..._VERIFY.sql` exit 0 | **applied, verification incomplete** — table + all columns present |
| 17 | Procurement decisions MVP | **applied + verified** — `17_..._VERIFY.sql` exit 0 | **applied, verification incomplete** — table + `procurement_decisions_current` present |
| 19 | Farm admin-field guard | **applied + verified** — `19_..._VERIFY.sql` exit 0; `trg_protect_farm_admin_fields` on `public.farms` | **unknown** — trigger not visible via PostgREST |
| 20 | Farm guard ACL fix | **applied + verified** — `fn_protect_farm_admin_fields` ACL is `postgres=X, service_role=X`; no `public`/`anon`/`authenticated` EXECUTE | **unknown** — function ACLs not visible via PostgREST |
| 21 | Controlled farmer provisioning | **applied + verified** — `21_..._VERIFY.sql` exit 0; `profiles.role` default `'pending'`; `handle_new_user` mints `pending`; policy `profiles: update own no role change` present | **unknown** — defaults/policies not visible via PostgREST |
| 22 | Operational farmer access RLS | **applied + verified** — `22_..._VERIFY.sql` exit 0; `has_operational_farmer_access()` present and referenced by **12** policies | **unknown** — policies not visible via PostgREST |
| 23 | Buyer Pack server-authoritative issuance | **applied + verified** — Section A **and** Section B **B1–B17** all PASSED (see §2) | **unknown** — function body not visible via PostgREST |
| 24 | Evidence request resolution | **not applied** — no `evidence_requests` table, `0` `evidence*` functions, no evidence storage bucket | **not applied** — `evidence_requests` returns `PGRST205` (not in schema cache) |
| 25 | Watchtower ingestion provenance | **not applied** — no `watchtower_ingestion_runs` / `_items`, no `legal_updates.ingestion_run_id` | **applied, verification incomplete** — both tables present; `legal_updates.ingestion_run_id` + `canonical_url` present |
| 26 | Watchtower source governance | **not applied** — no `regulatory_source_tier()`, no `regulatory_sources.tier` | **applied, verification incomplete** — `regulatory_sources.tier` + `category` present |
| 27 | Compliance audit-log actor authoritative | **not applied** — only migration-9 triggers on `compliance_audit_log` (`_no_truncate`, `_no_update_delete`) | **unknown** — trigger not visible via PostgREST. Not merged to `main` (PR #44 open), so expected absent. |

### 1.1 The finding that matters most

**Staging and production have diverged in opposite directions.**

- Production is **ahead** on Watchtower: 25 and 26 are applied in production and
  **not** applied in staging.
- Staging is the only environment where 19–23 are provably correct.

The common assumption "staging is ahead of production" is **false** for this
project. Any migration plan that assumes staging is a superset of production is
unsafe. This directly corrects starting finding 4's framing.

### 1.2 Staging baseline posture (direct evidence)

- **24/24** public tables have RLS enabled.
- **63** RLS policies on `public`.
- Storage buckets `farmer-documents` and `farmer-photos` both `public = false`,
  with 7 storage policies including the migration-22 overlay
  `farmer buckets: operational farmer or admin`.
- `16_PRODUCTION_SAFETY_VERIFY.sql` → exit 0.

---

## 2. Migration 23 — VERIFY defect found and fixed

`23_BUYER_PACK_SERVER_AUTHORITATIVE_ISSUANCE_VERIFY.sql` on `main` scanned the
installed function body with the **case-sensitive** operator `~`:

```sql
if v_code !~ 'v_decided_by\s+is\s+null' then
  raise exception 'VERIFY A FAILED: function does not re-assert a non-null decision actor';
```

The body that `23_BUYER_PACK_SERVER_AUTHORITATIVE_ISSUANCE.sql` **itself
installs** writes `IF v_decided_by IS NULL THEN`. Measured against staging:

| scan | result |
|---|---|
| `body ~  'v_decided_by\s+IS\s+NULL'` | `true` |
| `body ~  'v_decided_by\s+is\s+null'` | **`false`** ← the check as written |
| `body ~* 'v_decided_by\s+is\s+null'` | `true` |

**The VERIFY could never pass against the function its own migration installs.**
The Buyer Pack issuance gate therefore had no working verification in any
environment.

Fixed in **PR #57** (`fix/migration-23-verify-case-sensitivity`). After the fix,
against staging:

- **Section A** PASSED.
- **Section B** PASSED **B1–B17**, including the launch-critical negatives:

| Case | Assertion | Result |
|---|---|---|
| B2 | no decision blocks issuance | PASS |
| B3 / B4 | current `hold` / `reject` blocks | PASS |
| B5 / B6 | stale `progress` + newer `hold` / `reject` blocks | PASS |
| B7 | a decision for another batch does not authorise this pack | PASS |
| B8 / B9 | trail rejects blank reason and null actor | PASS |
| B10 | client `progress` + server `hold` blocks (client value ignored) | PASS |
| B13 | snapshot versioning increments | PASS |
| B14 / B15 | snapshot UPDATE and DELETE remain blocked | PASS |
| B16 | audit row written on valid issuance | PASS |
| B17 | no residue after `ROLLBACK` (5 counters all `0`) | PASS |

---

## 3. Migration-number governance

`main` carried a genuine collision: PR #48 landed
`25_WATCHTOWER_INGESTION_PROVENANCE_*` while PR #44 carried
`25_COMPLIANCE_AUDIT_LOG_ACTOR_AUTHORITATIVE_*`. Both branches were individually
green; nothing in CI noticed.

- PR #44's migration is **renumbered 25 → 27** (26 is Watchtower source governance).
- A **collision guard** is added in PR #43 and runs on **every** PR
  (`npm run verify:migration-numbers`, in Security CI ahead of the SQL checks),
  plus as a harness preflight.

Current numbering on `main` + PR #44: `3, 4, 8, 9, 10, 11, 12, 13, 14, 15, 16,
17, 18, 19, 20, 21, 22, 23, 24, 25, 26` (+ 27 on the PR branch) — no number
claimed by two migrations.

---

## 4. Production migration delta

Given §1, the production delta to reach parity with `main` is:

| Migration | Needed in production? | Notes |
|---|---|---|
| 10, 17 | No | already present |
| 19, 20, 21, 22, 23 | **UNKNOWN — must be inspected first** | Section A of each VERIFY is read-only and production-safe |
| 24 | **Yes** | confirmed absent (`PGRST205`) |
| 25, 26 | No | already present |
| 27 | Only after PR #44 merges | not on `main` yet |

**Do not run "all SQL".** Migrations 25 and 26 are already applied in
production; re-running them is unnecessary, and 24 is the only confirmed gap.

---

## 5. What Evidence Is Missing

To close every `unknown` above, the following is required. Nothing here can be
inferred from the repository.

### 5.1 Access missing

| Item | Why | Where it goes |
|---|---|---|
| Production Postgres connection string (`PROD_DATABASE_URL`) | catalog introspection: triggers, function bodies, ACLs, RLS policies, storage policies | operator shell only — must **not** be committed |
| — or — production service-role key | permits a `postgres`-equivalent PostgREST path | operator shell only |

### 5.2 Exact commands to run (read-only, production-safe)

Section A of each VERIFY is read-only and RAISEs on drift. Run in a read-only
session and capture raw output.

```bash
export PROD_DATABASE_URL='...'   # not stored in the repo

# 1. Object-state VERIFY for the unknown migrations (Section A only is required;
#    these four files are pure read-only with no BEGIN/INSERT):
psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 -f 10_BUYER_PACK_SNAPSHOTS_VERIFY.sql
psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 -f 16_PRODUCTION_SAFETY_VERIFY.sql
psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 -f 17_PROCUREMENT_DECISIONS_VERIFY.sql

# 2. For 19 / 21 / 22 / 23 the VERIFY files contain a behavioural Section B
#    (BEGIN ... ROLLBACK, no COMMIT). Do NOT run Section B against production.
#    Extract and run Section A only, or run the targeted probe in 5.3.
```

### 5.3 Targeted read-only probe (safe to paste into a prod SQL console)

```sql
-- M19/M20 farm admin-field guard
select tgname from pg_trigger
 where tgrelid = 'public.farms'::regclass and not tgisinternal;
select coalesce(array_to_string(proacl, ','), 'NULL(default)') as acl
  from pg_proc where proname = 'fn_protect_farm_admin_fields';

-- M21 controlled provisioning
select column_default from information_schema.columns
 where table_schema='public' and table_name='profiles' and column_name='role';
select position('pending' in prosrc) > 0 as mints_pending
  from pg_proc where proname = 'handle_new_user';
select policyname from pg_policies
 where schemaname='public' and tablename='profiles' order by policyname;

-- M22 operational farmer access
select count(*) from pg_proc where proname = 'has_operational_farmer_access';
select count(*) as policies_referencing from pg_policies
 where schemaname='public'
   and (coalesce(qual,'') || coalesce(with_check,'')) like '%has_operational_farmer_access%';

-- M23 server-authoritative issuance
select position('procurement_decisions_current' in prosrc) > 0 as reads_trail,
       prosrc ~* 'v_decided_by\s+is\s+null'                  as reasserts_actor,
       position('p_procurement_decision' in regexp_replace(prosrc,'--[^\n]*','','g')) = 0
                                                             as ignores_client_value
  from pg_proc where proname = 'issue_buyer_pack_snapshot';

-- M27 audit-log actor (expected ABSENT until PR #44 merges)
select tgname from pg_trigger
 where tgrelid = 'public.compliance_audit_log'::regclass and not tgisinternal;

-- Baseline posture
select count(*) filter (where c.relrowsecurity) || '/' || count(*) as rls_enabled
  from pg_class c join pg_tables t
    on t.tablename = c.relname and c.relnamespace = 'public'::regnamespace
 where t.schemaname = 'public';
select count(*) from pg_policies where schemaname = 'public';
select id, public from storage.buckets order by id;
```

### 5.4 Expected outputs required to mark a row `applied + verified`

| Migration | Expected |
|---|---|
| 19 | `trg_protect_farm_admin_fields` present on `public.farms` |
| 20 | ACL contains `postgres=X` and `service_role=X`, and **no** `anon`/`authenticated`/`public` EXECUTE |
| 21 | default `'pending'::text`; `mints_pending = t`; the three `profiles:` policies present |
| 22 | function count `1`; `policies_referencing` = 12 (staging value — a lower number means partial application) |
| 23 | `reads_trail = t`, `reasserts_actor = t`, `ignores_client_value = t` |
| 27 | expected: only `compliance_audit_log_no_truncate` and `compliance_audit_log_no_update_delete` |

### 5.5 Also missing

- **Backup / restore readiness for production.** Not verifiable from here. A
  restore drill result is required before any production apply (§ migration plan).
- **DeepSource dashboard access.** Issue detail was recoverable from PR review
  comments; threshold configuration was not.
