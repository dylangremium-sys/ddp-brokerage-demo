# Migration Runtime Status — by Environment

**Last verified: 2026-07-21.** This file records where each migration actually is,
per environment. A migration is never described as "applied" without naming the
environment it was applied to and the runtime evidence that proves it.

> **This document is a status register, not an execution recipe.** It records what
> was observed in a live database at a point in time. It does not tell you what to
> run, in what order, or whether it is safe to do so — for that, read the migration
> register in `README.md` ("Database setup and migration safety") and each
> migration's own header and runbook.

**No migration was applied, altered or rolled back during this audit.** The only
statements executed against a database were read-only catalog `SELECT`s and the
repository's own staging security harness (`npm run security:staging`), which
applies no DDL.

Contains no credentials, connection strings, keys or passwords.

## Audit provenance

| | |
|---|---|
| Audit date | 2026-07-21 |
| Repository baseline | `origin/main` @ `329f05d1dff8126a6f600b899026d234493dda20` |
| Staging project ref | `szqocdabwkjrggrddocx` |
| Production project ref | `iihxjrfxmycjafbtjvvq` |
| Environments inspected | **Staging only.** Production was not contacted. |
| Method | Read-only `pg_catalog` / `information_schema` queries, plus `npm run security:staging` |

Both project refs are already hardcoded in `scripts/run-staging-security-tests.mjs`
as an allowlist; recording them here is not a disclosure. The harness refuses to run
against the production ref, and refuses any ref that is not the approved staging one.

## Status vocabulary

| Value | Meaning |
|---|---|
| `APPLIED_AND_VERIFIED` | Objects observed present in the live catalog **and** behaviour confirmed at runtime. |
| `APPLIED_NOT_VERIFIED` | Objects observed present in the live catalog; behavioural enforcement not exercised. |
| `PARTIALLY_APPLIED` | Some objects present, others absent. |
| `NOT_APPLIED` | Positively observed absent, or stated absent by an operator record. |
| `BLOCKED` | Cannot proceed until a prerequisite is resolved. |
| `UNKNOWN` | No runtime evidence either way. **Not** a synonym for not-applied. |

A merged PR, a green CI run, a passing static test, a successful deployment, or the
presence of a `.sql` file in the repository is **not** evidence of application.

---

## Migrations 19–23 — status matrix

| Migration | Repository | Staging | Production | Evidence (staging) | Unresolved |
|---|---|---|---|---|---|
| **19** Farm admin-field guard | On `main` | **`APPLIED_AND_VERIFIED`** | **`UNKNOWN`** | Catalog: `fn_protect_farm_admin_fields` present; body references `is_ddp_admin`; **no `= 'admin'` role literal**; non-internal trigger present on `public.farms`. Behavioural: harness group B2 — farmer A could not set `status`, `compliance_status`, `risk_level` or `partner_tier` on its own farm (write accepted, values reverted; `status` still `Submitted to DDP`) | Production status uncorroborated — see Conflicting evidence |
| **20** Guard EXECUTE ACL fix | On `main` | **`APPLIED_AND_VERIFIED`** | **`UNKNOWN`** | Catalog: `authenticated` does **not** hold `EXECUTE` on `fn_protect_farm_admin_fields`. This ACL state is the migration's entire content, and is exactly what `19_..._VERIFY.sql` Section A asserts | No rollback script exists for this migration |
| **21** DDP-controlled farmer provisioning | On `main` | **`APPLIED_AND_VERIFIED`** | **`UNKNOWN`** | Catalog: `profiles.role` CHECK admits `pending`; column default is `pending`; `handle_new_user` body assigns `pending`. Harness preflight: **"migrations 21 and 22 present"** (PASS). Behavioural: farmers A and B each denied self-elevation to `ddp_admin` by RLS (`SQLSTATE 42501`), role unchanged afterwards | Supabase Auth "allow new users to sign up" is a dashboard setting, not expressible in SQL, and was **not** inspected |
| **22** Operational-farmer RLS overlay | On `main` | **`APPLIED_AND_VERIFIED`** | **`UNKNOWN`** | Catalog: `has_operational_farmer_access()` present; 12 RESTRICTIVE policies in `public`. Behavioural: 59 of 61 pending-matrix probes passed — a `pending` identity was denied SELECT/INSERT/UPDATE/DELETE across all 11 overlay tables, denied `market_price_benchmarks` read, and denied both storage buckets, while an operational farmer retained access on identical requests | 2 storage probes failed on cleanup, not on enforcement — see Harness result |
| **23** Buyer Pack server-authoritative issuance | On `main` | **`APPLIED_NOT_VERIFIED`** | **`UNKNOWN`** | Catalog: `issue_buyer_pack_snapshot` present and its body references `procurement_decisions_current` — i.e. the migration-23 definition is installed, not migration 10's client-trusting version. Prerequisites confirmed: `buyer_pack_snapshots` and `procurement_decisions` tables both present | `23_..._VERIFY.sql` Section B (behavioural: PK-HOLD / PK-REJECT / PK-NONE / stale-decision scenarios) was **not** executed. Applied but not behaviourally proven |

### What changed relative to the previous revision

The previous revision of this document covered **only migrations 10 and 17** and said
nothing about 19–23; `README.md` and `docs/MASTER_DEVELOPMENT_ROADMAP.md` both
consequently recorded 19–23 as "unable to verify".

**That gap is now closed for staging.** Direct catalog inspection shows migrations 19,
20, 21, 22 and 23 are all present in the staging database, and the security harness
confirms 19, 21 and 22 are enforcing at runtime. This corrects a documentation state
that had understated staging's actual position.

**It is not closed for production**, and nothing here should be read as saying so.

### Conflicting evidence — migrations 19 and 20 in production

Two repository documents assert that migration 19 was applied to **production** and
that a manual `REVOKE EXECUTE ... FROM authenticated` was applied there:

- `docs/FARM_ADMIN_FIELD_GUARD_APPLICATION.md` — "19_…VERIFY.sql Section A caught this
  on the Production apply … Production is already corrected."
- `20_FARM_ADMIN_FIELD_GUARD_ACL_FIX.sql` header — "it has already been applied to
  Production".

Against that:

- PR #19, merged the same day and earlier than PR #21, states "**No migration has been
  run against any database.**"
- `docs/SECURITY_TEST_LOG.md` — which does carry dated, project-attributed runtime
  records for other migrations — contains **no entry** for migration 19 or 20.
- The claims are undated, carry no operator name, and cite no VERIFY output or catalog
  query.

The claims are therefore recorded but **not** accepted as runtime evidence. Production
status for 19 and 20 remains **`UNKNOWN`**. Resolving it requires running
`19_..._VERIFY.sql` **Section A only** (read-only, safe anywhere) against production and
recording the output here. Section B writes and must not be run against production.

---

## Migrations 10 and 17 — carried forward

| | Migration 10 — Buyer Pack snapshots | Migration 17 — Procurement decisions |
|---|---|---|
| **Repository** | Committed on `main`. | Committed on `main`. |
| **Staging** | **`APPLIED_AND_VERIFIED`** (2026-07-14); table presence re-confirmed by catalog 2026-07-21 | **`APPLIED_AND_VERIFIED`** (2026-07-14); table presence re-confirmed by catalog 2026-07-21 |
| **Production** | **`NOT_APPLIED`** per the 2026-07-14 operator record. **Not re-verified in this audit.** | **`NOT_APPLIED`** per the 2026-07-14 operator record. **Not re-verified in this audit.** |
| **Runtime verification — production** | **None. Never executed.** | **None. Never executed.** |
| **Rollback** | `10_..._ROLLBACK.sql` present. | `17_..._ROLLBACK.sql` present — **destructive**: dropping the table destroys the decision audit trail. Export first. |

**Ordering — not optional.** Migration 10 MUST be applied before migration 17;
migration 17 holds a hard FK to `public.buyer_pack_snapshots(snapshot_id)`. Migration
23 depends on both.

---

## Staging security harness — result

| | |
|---|---|
| Command | `npm run security:staging` |
| Target | staging ref `szqocdabwkjrggrddocx` (production ref blocked by the harness) |
| Started / finished | 2026-07-21T18:39:01Z → 18:39:28Z |
| Run id | `1784659142065-868ac4ea` |
| Result | **107 PASS · 5 FAIL · 0 SKIP · 0 BLOCK** |
| Exit code | **1** (non-zero because failures occurred). Derived from the script's documented `computeExitCode` contract — the value was not captured directly, owing to a shell-pipeline error by the operator running it |
| Pending matrix | 61 total · 59 pass · 2 fail · 0 skip · 0 blocked — merge gate **NOT SATISFIED** |
| DDL applied | **None.** The harness applies no schema change; its only file execution is a hardcoded allowlist of four SELECT-only VERIFY scripts |

### The 5 failures

**Three catalog VERIFY failures — migrations 12, 14, 15 (not 19–23):**

| Script | Failing checks observed |
|---|---|
| `12_PUBLIC_FUNCTION_EXECUTE_VERIFY.sql` | `FAIL\|11` |
| `14_PUBLIC_TABLE_DEFAULT_PRIVILEGE_VERIFY.sql` | `existing table public.farms unchanged for anon`; `object counts`; `mig11 active & farm-resave absent` |
| `15_EXISTING_TABLE_AND_AUDIT_LOG_VERIFY.sql` | `V2 crud_intact_non_audit`; `V6 counts_and_rls`; `V7 prior_migrations_and_absences`; `V8 functions_unchanged` |

**Hypothesis, not a conclusion:** these VERIFY scripts predate migrations 19–23, and at
least one failing check — `mig11 active & farm-resave absent` — asserts the **absence**
of a farm trigger/function that migration 19 legitimately installs under the same name
(`fn_protect_farm_admin_fields`). Several others assert fixed object counts and
unchanged function sets, which later migrations would necessarily move. So these may be
**stale expectations rather than live drift**. That has **not** been confirmed, and the
alternative — genuine privilege drift on staging — is not excluded. **Status: `UNKNOWN`,
investigation required.** Do not treat these failures as either benign or as a
confirmed defect until each failing check is read individually.

**Two storage failures — cleanup, not enforcement:**

- `pending cannot list another user private objects` — the *control* object could not be removed
- `cleanup verified for storage list-control object` — same root cause

Both are cleanup failures. Neither indicates that a `pending` identity gained access:
every enforcement probe in that group passed, including "pending cannot write beneath
another user prefix" (403) on both buckets.

---

## Cleanup verification

Baseline was captured immediately before the run and compared immediately after.

| Measure | Before | After | Assessment |
|---|---|---|---|
| Synthetic farms (`farm_name ILIKE 'security-test-%'`) | 0 | **0** | Clean — farm cleanup worked |
| Total farms | 0 | 0 | Unchanged |
| Total profiles | 4 | 4 | Unchanged — no user or membership record damaged |
| `compliance_audit_log` rows | 13 | **14** | +1, **intentional**: `STAGING_ALLOW_AUDIT_INSERT=true`; the append-only row is retained by design because its immutability is the property under test |
| Storage objects | — | **36** | **Residue — see below** |
| Migration catalog facts (19/21/22/23) | as recorded | **identical** | No schema change; no migration applied or altered |

### Storage residue — a pre-existing, accumulating defect

**Four objects from this run remain**, all tagged with the run id:

```
farmer-documents  <userB>/security-test-1784659142065-868ac4ea-listctl.txt
farmer-documents  <userA>/security-test-1784659142065-868ac4ea-attrib.pdf
farmer-documents  <userA>/security-test-1784659142065-868ac4ea.txt
farmer-photos     <userA>/security-test-1784659142065-868ac4ea-attrib.jpg
```

Only the first was reported as a cleanup failure by the harness; the other three were
**not** reported, yet also remain — so the storage residue check is itself incomplete.

**This is not new.** Of 36 storage objects on staging, essentially all are synthetic
test artefacts accumulated from earlier runs — dated 2026-07-12, 07-13, 07-19 (three
separate runs), and 07-20. Storage cleanup has been silently failing across many runs.

This mirrors a defect the harness already documents and fixed once for farms: an
earlier version filtered on a non-existent column, so the delete matched nothing and
the residue check then reported zero — "a false 'clean' that let 24 orphaned rows
accumulate". The same class of bug now appears to exist on the storage path.

**No ad hoc deletion was performed.** The harness has no documented, staging-scoped
storage cleanup command, so removing these is a code fix plus a deliberate cleanup
operation, not an improvisation. Recorded here for a decision.

---

## Remaining unknowns

1. **Production status of migrations 19, 20, 21, 22, 23** — `UNKNOWN`. Production was
   not contacted in this audit. Resolve by running read-only Section A verifications
   and `16_PRODUCTION_SAFETY_VERIFY.sql` against production and recording the output.
2. **Production status of migrations 10 and 17** — recorded `NOT_APPLIED` on the
   2026-07-14 operator record; **not re-verified** on 2026-07-21.
3. **Migration 23 behavioural enforcement on staging** — installed, but the decision-gate
   scenarios in `23_..._VERIFY.sql` Section B were not exercised.
4. **Catalog VERIFY failures for migrations 12, 14, 15 on staging** — cause not
   established; stale-expectation vs genuine drift is unresolved.
5. **Storage cleanup defect** — root cause not diagnosed; 36 residual objects on staging.
6. **Supabase Auth signup setting** — migration 21's companion dashboard control
   ("allow new users to sign up") is not expressible in SQL and was not inspected in
   either environment.
7. **Migration 20 has no rollback script.**

## Out of scope

**Migration 24** (Evidence Request & Resolution) is **not on `main`** — it exists only
on draft PR #37 and has not been applied to any environment. It is deliberately absent
from every table above and is not a prerequisite for anything here.
