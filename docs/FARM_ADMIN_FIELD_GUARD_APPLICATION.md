# Farm admin-field guard — production application instructions

Migration **19** — closes the `public.farms` admin-field self-approval privilege
escalation: with the RLS policy `"farms: farmer update own"` live but no column
guard, a farmer can set their own `compliance_status`, `risk_level`,
`export_readiness`, `partner_tier`, `status`, `reviewed_by`, and `created_by` —
i.e. approve their own farm. This migration installs a `BEFORE UPDATE` trigger
that preserves those admin-controlled columns for non-admins while leaving
descriptive/contact columns editable.

**These files are reviewed repository artifacts. They have not been executed
against any database by this change. An operator applies them manually.**

## Files

| File | Role |
|------|------|
| `19_FARM_ADMIN_FIELD_GUARD_HARDENING.sql` | Forward migration (idempotent): guard function + `BEFORE UPDATE` trigger |
| `19_FARM_ADMIN_FIELD_GUARD_VERIFY.sql` | Section A = read-only object-state proof (safe on prod); Section B = behavioural proof (non-prod only) |
| `19_FARM_ADMIN_FIELD_GUARD_ROLLBACK.sql` | Reverses **only** this migration; keeps the farmer-update policy |

## Preconditions

1. Confirm the current exposure. Run **Q1** of `16_PRODUCTION_SAFETY_VERIFY.sql`
   (read-only) against production. Expected before applying:
   `*** ESCALATION RISK — farmer UPDATE policy is LIVE and the column guard is ABSENT ***`
   (If it already reports SAFE, the guard is present — stop and reconcile.)
2. Take/confirm a recent database backup (this migration is DDL-only and changes
   no rows, but standard change control applies).
3. Apply and prove on a **non-production** project first (see Verification B).

## Apply order

Dependencies already present in the schema baseline: `public.is_ddp_admin()`
(`AUTH_RLS_SCHEMA.sql`, hardened in `3_SECURITY_HARDENING_SEARCH_PATH_AND_GRANTS.sql`)
and the `public.farms` table. No other migration is a prerequisite.

1. Open the Supabase SQL Editor on the target project (postgres role).
2. Paste and run the entire contents of `19_FARM_ADMIN_FIELD_GUARD_HARDENING.sql`.
   It runs inside its own `begin … commit` and is idempotent (safe to re-run).

## Verification

- **Object state (safe on production):** run **Section A** of
  `19_FARM_ADMIN_FIELD_GUARD_VERIFY.sql`. It raises on any drift and prints
  `VERIFY A PASSED`. Then re-run `16_PRODUCTION_SAFETY_VERIFY.sql` Q1 — it must now
  report `SAFE — farmer UPDATE policy is guarded by trg_protect_farm_admin_fields`.
- **Behaviour (non-production only):** run **Section B** of the VERIFY on a
  non-prod project as postgres/superuser. It builds an ephemeral fixture inside a
  single `BEGIN … ROLLBACK` (no `COMMIT`), proves a farmer is blocked on all seven
  admin columns but can still edit an allowed column, proves a `ddp_admin` can
  change admin columns, proves a farmer cannot touch a non-member farm, and
  asserts no residue survives the rollback. Do **not** run Section B against
  production (it exercises writes, even though they are rolled back).

## Rollback

Run `19_FARM_ADMIN_FIELD_GUARD_ROLLBACK.sql`. It drops only the trigger and
function.

> ⚠️ **Rollback re-opens the vulnerability.** It intentionally leaves
> `"farms: farmer update own"` in place, so after rollback Q1 returns
> `ESCALATION RISK` again. Only roll back deliberately, and re-apply the forward
> migration promptly.

## Scope / out of scope

- **In scope:** the `farms` column guard only (function `fn_protect_farm_admin_fields`
  + trigger `trg_protect_farm_admin_fields`).
- **Not touched:** the `"farms: farmer update own"` RLS policy, `farm_profiles`,
  `profiles`, and every other object. The separate `profiles.role` self-elevation
  concern noted in `16_PRODUCTION_SAFETY_VERIFY.sql` is a different issue and is
  **not** addressed here.

## CI assurance

`npm run security:sql` (part of `npm run ci:verify`) and
`scripts/farm-admin-field-guard.test.mjs` (`npm test`) statically lock in the
guard's correctness: canonical `is_ddp_admin()` admin check (no `role = 'admin'`
literal), the exact seven-column protected set, trigger installation, a
`COMMIT`-free behavioural VERIFY, and a non-vacuous residue check. These fail CI
if the guard is weakened.
