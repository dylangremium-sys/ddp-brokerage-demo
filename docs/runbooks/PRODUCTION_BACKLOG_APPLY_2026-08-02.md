# Applying the migration backlog to production

> ## ✅ THIS BACKLOG IS APPLIED TO PRODUCTION — 2026-08-02
>
> All eleven migrations (24, 28, 35, 39–46) plus migration 24's storage half were applied to
> `iihxjrfxmycjafbtjvvq` on 2026-08-02. **Every VERIFY green, 102 sections.** Production went
> from 34 tables to **48**, policies to **112**, storage buckets 2 → **3**. Existing data
> untouched (3 farms, 4 batches, 13 profiles). Site returned HTTP 200 and both API endpoints
> stayed healthy throughout.
>
> **The marketplace guarantees are now live**: a batch cannot be oversold, and a suspended
> buyer loses read access immediately.
>
> This document is kept as (a) the record of how it was done, (b) the reference for applying
> the same set to any other environment, and (c) the corrections it took to get right — see
> "Migration 24's storage half" and "What this rehearsal changed in the repo".

**Rehearsed end-to-end on staging `szqocdabwkjrggrddocx` before being applied.** Every expected
output below was measured on that run, not predicted.

**Read the whole page before applying this anywhere else.** The order matters, and one apparent
failure mid-run is expected and is not a fault.

---

## What was missing from production (now applied)

Measured 2026-08-02 by probing for a discriminating function per migration — never by table
presence, because most of these use `CREATE TABLE IF NOT EXISTS` and a table can exist without
its migration having run.

| # | Migration | On staging | On production |
|---|---|---|---|
| 24 | `24_EVIDENCE_REQUEST_RESOLUTION` | applied | **APPLIED 2026-08-02** |
| 28 | `28_EVIDENCE_DIGEST_DEDUP` | applied | **APPLIED 2026-08-02** |
| 35 | `35_STATUS_TRANSITION_ATOMIC` | applied | **APPLIED 2026-08-02** |
| 39 | `39_COUNTERPARTY_ORGANISATIONS` | applied | **APPLIED 2026-08-02** |
| 40 | `40_LICENCES_AND_PERMITS` | applied | **APPLIED 2026-08-02** |
| 41 | `41_EFFECTIVE_DATED_RULESETS` | applied | **APPLIED 2026-08-02** |
| 42 | `42_EXPORT_ELIGIBILITY_GATE` | applied | **APPLIED 2026-08-02** |
| 43 | `43_MFA_FOR_GATE_APPROVAL` | applied | **APPLIED 2026-08-02** |
| 44 | `44_RESERVATION_LEDGER` | applied | **APPLIED 2026-08-02** |
| 45 | `45_SEAM7_ORGANISATION_EVENT_SPLIT` | applied | **APPLIED 2026-08-02** |
| 46 | `46_SEAM5_VERIFIED_BUYER_READ_PREDICATE` | applied | **APPLIED 2026-08-02** |

The probe that produced this is reproducible — it is in
`docs/runbooks/PRODUCTION_BACKLOG_APPLY_2026-08-02.md` §6 below, and it is also how you check
your own work afterwards.

**Two of these are the marketplace's load-bearing guarantees**, and both are now live in
production:

- **44** — a batch cannot be oversold. Proven under real concurrency 2026-08-02
  (`docs/RESERVATION_CONCURRENCY_TEST_2026-08-02.md`): 20 batches, 17,600 kg, 0 oversold.
- **46** — a suspended buyer immediately loses read access. Before it, suspension changed a
  column and changed nothing else.

---

## Before you start

1. **Access.** A read-only credential lives at `~/.ddp_prod.env` (role `ddp_ro`) and is enough
   for every check on this page. Applying needs a WRITE credential — the `postgres` role, from
   Supabase → Settings → Database. The 2026-08-02 apply ran from **psql**, not the dashboard;
   see "Migration 24's storage half" for why the dashboard is not the remedy it was once
   claimed to be. **Reset the database password after any apply session** if the credential was
   handled anywhere it could be recorded.
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
| 24 | **18** | clean — but only after you also run `24_..._STORAGE.sql`. Run the HARDENING file, then the STORAGE file, then VERIFY. If you run VERIFY before the STORAGE file you get 17 and a section-R failure, which is the check working, not a fault. |
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

**102 VERIFY sections in total** (24 now contributes 18). If a VERIFY produces *fewer* passes than listed, stop — something
differs between production and the rehearsal.

---

## Migration 24's storage half — CORRECTED 2026-08-02

### ~~The one step that needs your hands~~ — it does not. It runs from psql like every other step.

**This section previously said the storage half could not be applied from psql, required
membership of `supabase_storage_admin`, and had to be run in the Supabase dashboard SQL
editor. All three were wrong**, and the error they caused is worth recording because it cost
an hour and sent the owner to a dead end.

The claim came from a precondition block inside
`24_EVIDENCE_REQUEST_RESOLUTION_STORAGE.sql` which asserted that a caller without that role
membership *"would fail"* at `CREATE POLICY`. **Measured against production, 2026-08-02:**

- `postgres` is **not** a member of `supabase_storage_admin` — `pg_has_role` returns false;
- `CREATE POLICY` on `storage.objects` as `postgres` nevertheless **succeeds**, proven by a
  rolled-back probe;
- so the guard refused a step that worked, and the whole storage half never ran.

**And the advice made it worse.** It named the dashboard SQL editor as the remedy — but the
dashboard SQL editor **also runs as `postgres`**, so it fails the identical check. The owner
pasted the file there and got exactly the same error. A false guard plus a false remedy reads
as an unclearable permissions wall.

The precondition is now a **capability probe**: it attempts a throwaway policy and catches
`insufficient_privilege`. A probe cannot be wrong about the capability the way a role lookup
can. It was confirmed to discriminate — it passes as `postgres` and correctly refuses as
`authenticated`.

**So there is no owner-only step.** Run `24_EVIDENCE_REQUEST_RESOLUTION_STORAGE.sql` from psql
after `24_..._HARDENING.sql`, exactly like every other file, and migration 24's VERIFY goes
from 17 sections to **18/18** with section R passing.

**Applied to production 2026-08-02**: bucket `evidence-request-files` (private, 100 MB limit)
plus five object policies; VERIFY 18/18. Same on staging.

The general lesson, which outlives this file: **a precondition should test the capability it
cares about, not a proxy for it.** `pg_has_role(...)` was a guess about what PostgreSQL would
allow; `EXECUTE 'CREATE POLICY …'` inside an exception handler is the thing itself.

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
  Migration 45 **aborts** rather than running if any such row already exists.

  **⚠ Read this before assuming the abort cannot fire.** An earlier draft of this runbook
  justified it with "production's vocabulary is still the original 15 values, so no such row
  can exist". That is true of production *today* and **false by the time you reach step 45**:
  applying 39, 40 and 42 widens the vocabulary to 30, and migration 39's own trigger writes
  `organisation_created` on **every** organisation insert. So there is a window, between step
  39 and step 45, in which such a row can be created.

  In practice, following this runbook straight through, nothing creates one — every VERIFY is
  wrapped in `BEGIN … ROLLBACK`, so their fixture organisations never persist. The hazard is
  real only if something *else* creates an organisation in that window: an admin using the
  app, a script, or a VERIFY someone edits to commit.

  **So: do not create organisations between steps 39 and 45.** If migration 45 aborts, it is
  telling you exactly this happened, and the right response is an owner decision about those
  rows — not a workaround.

  What *is* safe regardless: migration 45's narrowing cannot fail on production's pre-existing
  audit rows. Proven, not assumed — production admits 15 values, 45 keeps 26, and all 15 are
  inside the 26.
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

**CORRECTED 2026-08-02 after a self-audit.** An earlier version of this table listed migrations
**40 and 43 among the failures. They never failed** — measured on the pre-repair sweep, both
returned 0 errors (40: 8 sections, 43: 7 sections). Their fixtures were changed defensively to
`DO UPDATE` in the same pass, which is more correct but fixed nothing. **Four** VERIFY scripts
were genuinely broken, not six.

| # | Was | Cause |
|---|---|---|
| 35 | `duplicate key … profiles_pkey` | fixture INSERT with no `ON CONFLICT` |
| 35 | `history says Submitted to DDP -> Approved` | the migration-19/20 field guard rewrote the fixture's farm status because the fixture had not yet claimed to be an admin |
| 39 | `violates foreign key constraint profiles_id_fkey` | profile inserted for a user never created in `auth.users` |
| 39 | `expected exactly 1 organisation_created audit row, found 0` | migration **45** moved that event to the commercial log; section F now detects which regime it is in |
| 42, 44 | `ddp_admin role required` / `visible to DDP only` | `ON CONFLICT DO NOTHING` silently kept role `pending` |
| 40, 43 | *(nothing — these passed)* | changed to `DO UPDATE` defensively only |

**A second correction from the same audit.** "101 assertions" elsewhere in this document means
**101 VERIFY sections**, each of which contains several checks. The count is right; the noun
was wrong.

**And the coverage gap that audit found:** the disposable-PostgreSQL harness enumerates
*fixtures*, not migrations, so migrations **45 and 46 had no fixture and were skipped in
silence** — while their green check was twice reported as evidence they had run on a real
PostgreSQL. Fixtures now exist for both, and every `--all` run prints which numbered
migrations remain uncovered (currently **14 of 27**; 11, 12, 14, 15, 19, 21, 22, 25, 26, 27,
29, 30 and 34 have none).

**Writing that fixture immediately caught a second defect, which is the point.** Migration
46's VERIFY passed on staging and **failed on the harness**: it created its fixture farm with
`farm_name` and `province`, columns that exist on Supabase and not in the harness's minimal
substrate (`farms` is `id, created_by, status, reviewed_by, updated_at`). It is now written
against the portable column set and passes on both — 7/7 on staging, 7/7 on the harness.

The general rule for any future VERIFY: **a fixture may only name columns the harness
substrate actually has**, or it will pass against staging and fail — or worse, never run — on
the harness. `scripts/disposable-pg/bootstrap/00_supabase_substrate.sql` is the authority.

The root cause behind most of them: **`auth.users` carries `on_auth_user_created` →
`handle_new_user()`, which creates every profile as `pending` before your fixture runs.** A
plain INSERT then collides; `DO NOTHING` silently keeps the wrong role and the resulting
assertion failure blames the migration rather than the fixture. Use
`ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role`.
