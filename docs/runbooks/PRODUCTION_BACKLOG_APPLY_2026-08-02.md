# Applying the migration backlog to production

**Rehearsed end-to-end on staging `szqocdabwkjrggrddocx` on 2026-08-02.** Every expected
output below was measured on that run, not predicted. Eleven migrations, ten of which now
verify green; the eleventh fails for a reason you will have to resolve by hand, and it is
called out where it happens.

**Read the whole page before opening the SQL editor.** The order matters, two steps need a
decision from you, and one failure in the middle is expected and is not a fault.

---

## What is missing from production

Measured 2026-08-02 by probing for a discriminating function per migration — never by table
presence, because most of these use `CREATE TABLE IF NOT EXISTS` and a table can exist without
its migration having run.

| # | Migration | On staging | On production |
|---|---|---|---|
| 24 | `24_EVIDENCE_REQUEST_RESOLUTION` | applied | **absent** |
| 28 | `28_EVIDENCE_DIGEST_DEDUP` | applied | **absent** |
| 35 | `35_STATUS_TRANSITION_ATOMIC` | applied | **absent** |
| 39 | `39_COUNTERPARTY_ORGANISATIONS` | applied | **absent** |
| 40 | `40_LICENCES_AND_PERMITS` | applied | **absent** |
| 41 | `41_EFFECTIVE_DATED_RULESETS` | applied | **absent** |
| 42 | `42_EXPORT_ELIGIBILITY_GATE` | applied | **absent** |
| 43 | `43_MFA_FOR_GATE_APPROVAL` | applied | **absent** |
| 44 | `44_RESERVATION_LEDGER` | applied | **absent** |
| 45 | `45_SEAM7_ORGANISATION_EVENT_SPLIT` | applied | **absent** |
| 46 | `46_SEAM5_VERIFIED_BUYER_READ_PREDICATE` | applied | **absent** |

The probe that produced this is reproducible — it is in
`docs/runbooks/PRODUCTION_BACKLOG_APPLY_2026-08-02.md` §6 below, and it is also how you check
your own work afterwards.

**Two of these are the marketplace's load-bearing guarantees**, and neither is protecting
production today because the migration is not there:

- **44** — a batch cannot be oversold. Proven under real concurrency 2026-08-02
  (`docs/RESERVATION_CONCURRENCY_TEST_2026-08-02.md`): 20 batches, 17,600 kg, 0 oversold.
- **46** — a suspended buyer immediately loses read access. Before it, suspension changed a
  column and changed nothing else.

---

## Before you start

1. **Access.** This machine has **read-only** production access (`~/.ddp_prod.env`,
   role `ddp_ro`). There is no write credential here and one was searched for. Every apply
   step below happens in the **Supabase dashboard SQL editor**, signed in as the owner.
2. **The dashboard hides `RAISE NOTICE`.** Every VERIFY reports success as notices. In the SQL
   editor a passing VERIFY therefore looks like a blank result, and is indistinguishable from a
   script that silently did nothing. **Judge each step by the checks in §6, not by the editor
   looking calm.**
3. **Take a backup / note the PITR point first.** These migrations create tables, narrow a
   CHECK constraint (45) and replace RLS policies (46). Rollbacks exist for all of them, but a
   known-good restore point is cheaper than using them.
4. **Do it in one sitting if you can.** Steps 39→46 are dependency-ordered. Stopping halfway
   leaves the database in a valid but partial state — safe, but confusing to whoever looks next.

---

## Order

**Numeric order is correct.** Every stated dependency is satisfied by it — checked by reading
each migration's own precondition block, not assumed from the filenames:

```
24 → 28 → 35 → 39 → 40 → 41 → 42 → 43 → 44 → 45 → 46
```

- 40, 42, 44, 45, 46 all require **39** (`public.organisations`).
- 43 requires **42**. 45 additionally requires **44** (`commercial_audit_log`).
- 24, 28, 35, 41 are independent of the rest (41 depends on migration 9, long applied).

Each migration is a single transaction and its own precondition block will refuse to run if a
dependency is missing, so a mistake in ordering fails loudly rather than half-applying.

---

## The steps

For each migration in the order above:

1. Open `NN_<STEM>_HARDENING.sql` from the repo root at `main`.
2. Paste the **whole file** into the SQL editor and run it.
3. Then run `NN_<STEM>_VERIFY.sql` the same way.
4. Confirm against the expected result in the table below.

### Expected results — measured on staging, 2026-08-02

| # | VERIFY sections passing | Expected outcome |
|---|---|---|
| 24 | 17 | **FAILS at section R** — see below. Everything before R passes. |
| 28 | 13 | clean |
| 35 | 10 | clean |
| 39 | 7 | clean |
| 40 | 8 | clean |
| 41 | 7 | clean |
| 42 | 9 | clean |
| 43 | 7 | clean |
| 44 | 10 | clean |
| 45 | 6 | clean |
| 46 | 7 | clean |

**101 assertions in total.** If a VERIFY produces *fewer* passes than listed, stop — something
differs between production and the rehearsal.

---

## The one step that needs your hands, and the one expected failure

### Migration 24 will fail its VERIFY at section R. This is correct.

```
VERIFY R FAILED: expected exactly 1 evidence-request-files bucket, found 0
```

`24_EVIDENCE_REQUEST_RESOLUTION_HARDENING.sql` is only half the migration. The other half,
`24_EVIDENCE_REQUEST_RESOLUTION_STORAGE.sql`, creates the storage bucket and its policies, and
it requires membership of `supabase_storage_admin`.

**It cannot be applied from psql, and that is true for production too.**
`GRANT supabase_storage_admin TO postgres` is refused outright:

> role memberships are reserved, only superusers can grant them

So: run `24_EVIDENCE_REQUEST_RESOLUTION_STORAGE.sql` **in the dashboard SQL editor as the
owner**, then re-run `24_..._VERIFY.sql`, and section R will pass. Any apply plan that assumes
psql throughout is wrong about this file. Do not try to route around it — someone already
looked.

Sections A–Q of migration 24 passing means the relational half is correct; only the bucket is
outstanding.

---

## §6 — How to check your own work afterwards

Do not trust the SQL editor's silence. Run this against production as `ddp_ro`
(`~/.ddp_prod.env` → `PROD_RO_DATABASE_URL`); it needs no write access and is the same probe
that produced the table at the top of this page.

```sql
WITH d(mig, obj) AS (VALUES
  ('24','create_evidence_request'), ('28','find_document_digest_matches'),
  ('35','record_status_transition'), ('39','has_organisation_membership'),
  ('40','licence_is_valid'), ('41','destination_ruleset_in_force'),
  ('42','evaluate_export_eligibility'), ('43','has_mfa_assurance'),
  ('44','batch_reserved_kg_unchecked'), ('46','has_verified_organisation_membership'))
SELECT d.mig, d.obj,
       CASE WHEN EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                         WHERE n.nspname='public' AND p.proname=d.obj)
            THEN 'APPLIED' ELSE 'absent' END AS state
FROM d ORDER BY d.mig::int;

-- 45 REPLACES a function rather than adding one, so presence proves nothing.
-- Its discriminator is the NARROWED vocabulary: 26 compliance values, not 30.
SELECT '45' AS mig,
       CASE WHEN (SELECT count(*) FROM regexp_matches(
                    pg_get_constraintdef(c.oid), '''([a-z_]+)''::text', 'g')) = 26
            THEN 'APPLIED' ELSE 'absent' END AS state
FROM pg_constraint c WHERE c.conname = 'compliance_audit_log_action_check';
```

All twelve rows must read `APPLIED`. Expected end state alongside it: **48 tables, 112
policies** in `public`.

---

## What changes for users the moment this lands

Worth knowing before you do it, because two of these are visible behaviour:

- **46** — any buyer organisation whose `verification_state` is not exactly `verified` loses
  read access to its reservations **immediately**. Default state is `unverified`, so if buyer
  organisations already exist in any state other than verified, their members stop seeing
  reservation data. They keep seeing their own organisation record, and can still cancel holds.
- **45** — `compliance_audit_log` stops accepting four administrative organisation actions.
  Migration 45 **aborts** rather than running if any such row already exists; measured
  2026-08-02, production's vocabulary is still the original 15 values so no such row *can*
  exist, and this is a tripwire rather than an obstacle.
- **44** — reservations become possible at all, and overselling becomes impossible.
- 24, 28, 35, 39–43 add tables and functions nothing in the UI calls yet.

---

## Rollback

Every migration has `NN_<STEM>_ROLLBACK.sql`. Two carry deliberate refusals rather than
destroying evidence, and both were exercised on staging:

- **45** refuses if `commercial_audit_log` holds any of the four moved actions — removing them
  would mean mutating an append-only log.
- **46** re-opens the Seam 5 gap by design; that is what rolling it back means.

**Do not replay migration 10.** It reverts migration 23. That is recorded in
`docs/PRODUCTION_MIGRATION_PLAN.md` and is unrelated to this backlog, but it is the sort of
thing that gets discovered at the worst moment.

---

## What this rehearsal changed in the repo

Five VERIFY scripts could not pass on a **real Supabase database** and were repaired in the
same change as this runbook. All five passed on the disposable PostgreSQL harness, which is
exactly the class of false PASS that harness produces — it has no Supabase auth trigger.

| # | Was | Cause |
|---|---|---|
| 35 | `duplicate key … profiles_pkey` | fixture INSERT with no `ON CONFLICT` |
| 35 | `history says Submitted to DDP -> Approved` | the migration-19/20 field guard rewrote the fixture's farm status because the fixture had not yet claimed to be an admin |
| 39 | `violates foreign key constraint profiles_id_fkey` | profile inserted for a user never created in `auth.users` |
| 39 | `expected exactly 1 organisation_created audit row, found 0` | migration **45** moved that event to the commercial log; section F now detects which regime it is in |
| 40, 42, 43, 44 | `ddp_admin role required` / `visible to DDP only` | `ON CONFLICT DO NOTHING` silently kept role `pending` |

The root cause behind most of them: **`auth.users` carries `on_auth_user_created` →
`handle_new_user()`, which creates every profile as `pending` before your fixture runs.** A
plain INSERT then collides; `DO NOTHING` silently keeps the wrong role and the resulting
assertion failure blames the migration rather than the fixture. Use
`ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role`.
