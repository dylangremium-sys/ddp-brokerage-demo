# Break-Glass Authorisation Request — Migration 22 Storage Overlay (Production)

**Status:** REQUEST — PENDING AUTHORISATION. **Nothing in this document has been executed.**
**Freeze instrument:** `docs/PRODUCTION_CHANGE_FREEZE_2026-07-25.md` (ACTIVE) — this request invokes its **§3 Break-glass** procedure.
**Target:** Supabase production project `iihxjrfxmycjafbtjvvq`, table `storage.objects`.
**Finding:** F4 (HIGH) in the 2026-07-26 audit remediation programme — "Production is missing the
migration-22 storage overlay." The repository evidence record for this finding is
`docs/MIGRATION_RUNTIME_STATUS.md`, §*Finding — migration 22 storage overlay is absent on Production*
(verified 2026-07-26). No repository document assigns the identifier "F4" itself; the identifier comes
from the remediation tasking, the substance from the register cited above.

> **This is a request, not an execution record.** No SQL has been run, no database has been contacted,
> and no migration tooling has been invoked in the preparation of this document. Under freeze §3, the
> statements in §2 below may be executed only after the written authorisation block in §6 is completed
> by the release owner, and the event must then be appended to §5 of
> `docs/PRODUCTION_CHANGE_FREEZE_2026-07-25.md`.

---

## 1. What is being requested, and why

**Requested:** authorisation to execute, against Production, the two statements in §2 — the
`storage.objects` restrictive policy `farmer buckets: operational farmer or admin` from
`22_OPERATIONAL_FARMER_ACCESS_RLS_HARDENING.sql` (lines 156–172). Nothing else: no other part of
migration 22, no other migration, no replay of the SQL corpus.

**Why:** the 2026-07-26 read-only Production verification found migration 22 **`PARTIALLY_APPLIED`**
on Production — the 11-table restrictive overlay and its helper are present and correct (VERIFY A/B/C
passed), but the storage policy is **absent** (VERIFY D failed: storage policy missing). The three
storage policies that do exist gate on the uid path-prefix only, with no role check. The RESTRICTIVE
overlay is what ANDs `has_operational_farmer_access()` on top of them.

**Impact, stated no more strongly than the evidence supports:** an authenticated identity whose
profile role is `pending` — denied every UI route by migration 21's routing, but holding a valid JWT —
can call the Supabase Storage API directly and **read and upload objects under its own uid prefix** in
`farmer-documents`. Cross-tenant read **remains blocked** by the existing prefix predicate
(`auth.uid()::text = (string_to_array(name,'/'))[1]`). The accurate impact is therefore unauthorized
storage consumption and content staging by non-operational identities — **not** cross-tenant data
leakage. `farmer-photos` carries no policy at all on Production.

**Live exploitability is unmeasured.** Whether any `pending` identity currently exists on Production
could not be read (`ddp_ro` has no EXECUTE on `is_ddp_admin()`, which gates `public.profiles`). The
gap is structural and confirmed; reachability is unmeasured — not "no risk".

**Why break-glass is required:** installing this policy is DDL against Production. Freeze §1.3
prohibits schema and RLS-policy changes and §1.4 prohibits changes to storage; §3 is the only
sanctioned exception path. This request supplies §3's required elements: (a) exact statements (§2),
(b) pre-state evidence (§3), (c) rollback (§4), (d) operator (§6 — to be named at authorisation).

## 2. Exact statements to execute — (§3 requirement a)

Copied verbatim from `22_OPERATIONAL_FARMER_ACCESS_RLS_HARDENING.sql`, lines 156–172 (line 156 is the
idempotent `DROP POLICY IF EXISTS`; the `CREATE POLICY` statement spans lines 157–172). These two
statements, and nothing else, are what this request seeks authorisation to run:

```sql
DROP POLICY IF EXISTS "farmer buckets: operational farmer or admin" ON storage.objects;
CREATE POLICY "farmer buckets: operational farmer or admin"
  ON storage.objects
  AS RESTRICTIVE
  FOR ALL
  USING (
    (bucket_id IS DISTINCT FROM 'farmer-documents'
     AND bucket_id IS DISTINCT FROM 'farmer-photos')
    OR public.has_operational_farmer_access()
    OR public.is_ddp_admin()
  )
  WITH CHECK (
    (bucket_id IS DISTINCT FROM 'farmer-documents'
     AND bucket_id IS DISTINCT FROM 'farmer-photos')
    OR public.has_operational_farmer_access()
    OR public.is_ddp_admin()
  );
```

**Scope notes:**

- The policy constrains only the `farmer-documents` and `farmer-photos` buckets; every other bucket
  short-circuits to true and is unaffected (`22_..._HARDENING.sql`, section 4 header, lines 147–155).
- Both functions the policy references are already present and correct on Production:
  `public.has_operational_farmer_access()` per VERIFY A/B/C (2026-07-26), and `public.is_ddp_admin()`
  (migration 3), which the three existing storage policies already call.
- **Execution precondition** (`22_..._HARDENING.sql`, section 3, lines 106–145): `CREATE`/`DROP POLICY`
  on `storage.objects` requires the executing role to hold membership in that table's owner (in a
  Supabase project, `supabase_storage_admin`, not the role that normally applies migrations). The
  read-only `ddp_ro` role cannot execute these statements. The connection and role to be used are for
  the operator to record in §6 at execution time; they are not prescribed here.
- Do **not** run `22_OPERATIONAL_FARMER_ACCESS_RLS_HARDENING.sql` wholesale: the rest of the file is
  already applied on Production, and freeze §1.2 prohibits replaying the corpus. Only the two
  statements above are requested.

## 3. Pre-state evidence already recorded — (§3 requirement b)

Source: `docs/MIGRATION_RUNTIME_STATUS.md`, §*Finding — migration 22 storage overlay is absent on
Production* (Production verification of 2026-07-26; connection: role `ddp_ro`, `NOSUPERUSER`,
`NOBYPASSRLS`, SELECT-only, under `PGOPTIONS="-c default_transaction_read_only=on -c
statement_timeout=30000"`). Quoted:

> `22_..._HARDENING.sql:157-163` installs a policy named
> `farmer buckets: operational farmer or admin`, `AS RESTRICTIVE FOR ALL` on
> `storage.objects`, scoped to the `farmer-documents` and `farmer-photos` buckets and
> gating on `has_operational_farmer_access()`. **That policy does not exist on
> Production.** The three storage policies that do exist are:
>
> | Policy | Permissive | Cmd | Predicate |
> |---|---|---|---|
> | `farmer-documents: admin all` | PERMISSIVE | ALL | `bucket_id = 'farmer-documents' AND is_ddp_admin()` |
> | `farmer-documents: farmer read own` | PERMISSIVE | SELECT | `bucket_id = 'farmer-documents' AND (is_ddp_admin() OR auth.uid()::text = (string_to_array(name,'/'))[1])` |
> | `farmer-documents: farmer upload own` | PERMISSIVE | INSERT | `bucket_id = 'farmer-documents' AND auth.uid()::text = (string_to_array(name,'/'))[1]` |
>
> **Not a visibility artefact.** `ddp_ro` can read `pg_policies` for schema `storage` —
> the query returned the three rows above. The absence is real. (`ddp_ro` separately
> lacks USAGE on the `storage` schema itself, so `storage.buckets` could not be listed.)

The same register records migration 22's overall Production status as **`PARTIALLY_APPLIED`** —
"VERIFY A/B/C **passed** … VERIFY **D FAILED: storage policy missing**" — and states the escalation
posture this request now discharges: "**Not remediated here.** Installing the missing storage policy
is DDL against Production, which the change freeze §1.3–§1.4 prohibits. It requires the §3
break-glass procedure … **Escalated, not fixed.**"

No fresh pre-state read was taken for this request; under the freeze, the 2026-07-26 record above is
the pre-state evidence. If the release owner requires a same-day re-read before execution, the §6
query is the appropriate instrument (expected pre-state result: **zero rows**).

## 4. Rollback — (§3 requirement c)

Taken verbatim from `22_OPERATIONAL_FARMER_ACCESS_RLS_ROLLBACK.sql`, line 38 (its section 2, "Drop
the storage restrictive policy"):

```sql
DROP POLICY IF EXISTS "farmer buckets: operational farmer or admin" ON storage.objects;
```

This single statement fully reverses §2 and restores the recorded pre-state. Do **not** run the
rollback file wholesale: its sections 1 and 3 also drop the 11 table policies and the helper function,
which **are** applied and enforcing on Production and are not part of this request. Note the rollback
file's own warning applies proportionally: dropping this policy re-opens the storage portion of the
gap this request exists to close.

## 5. Post-execution verification — read-only

Derived from `22_OPERATIONAL_FARMER_ACCESS_RLS_VERIFY.sql`, section D (lines 105–133), which checks
policy presence and shape via `pg_policies`. The operator should run this SELECT-only catalog query
after execution:

```sql
SELECT policyname, permissive, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'storage' AND tablename = 'objects'
  AND policyname = 'farmer buckets: operational farmer or admin';
```

**Expected result — exactly one row, satisfying every VERIFY D assertion:**

| Column | Expected |
|---|---|
| `permissive` | `RESTRICTIVE` |
| `cmd` | `ALL` |
| `qual` | references `farmer-documents`, `farmer-photos`, and `has_operational_farmer_access` |
| `with_check` | same three references — matching `qual`, so uploads are guarded, not just reads |

Zero rows, a `PERMISSIVE` row, or a `with_check` that does not match `qual` means the policy did not
land as specified — execute §4 and record the outcome.

**Do not run `22_OPERATIONAL_FARMER_ACCESS_RLS_VERIFY.sql` wholesale against Production.** Its
sections F/G insert into `auth.users` and perform DML (first write at line 177 at the current
revision). Per the standing rule in `docs/MIGRATION_RUNTIME_STATUS.md` (*Remaining unknowns*, item 1),
only an explicitly extracted read-only prefix may be used, and line boundaries must be re-derived at
the revision in hand. The single query above is sufficient for this request.

Behavioural verification (that a live `pending` session is actually denied) is **out of scope** for
this request: it requires a `pending` identity on Production, whose existence is unmeasured, and
creating one would itself be a frozen write.

## 6. Authorisation and execution record — (§3 requirement d) — TO BE COMPLETED BY HUMANS

All fields below are intentionally blank. They are to be completed by the named humans — the
authoriser **before** execution (freeze §3: "written authorisation from the release owner, recorded
before execution"), the operator **at** execution. An unsigned copy of this document authorises
nothing.

| Field | Value |
|---|---|
| **Authorised by** (release owner — name / title) | _______________________________ |
| **Authorisation date/time** (ISO 8601, UTC) | _______________________________ |
| **Authorisation record** (where the written approval lives) | _______________________________ |
| **Operator** (person executing — name) | _______________________________ |
| **Execution date/time started** (ISO 8601, UTC) | _______________________________ |
| **Execution date/time finished** (ISO 8601, UTC) | _______________________________ |
| **Connection / role used** | _______________________________ |
| **§5 verification query result** (row returned as expected: yes / no) | _______________________________ |
| **Rollback executed?** (no / yes — reason) | _______________________________ |
| **Appended to freeze log?** (§5 of `docs/PRODUCTION_CHANGE_FREEZE_2026-07-25.md`) | _______________________________ |

## 7. Declaration

- **Nothing has been executed.** This document is a request pending authorisation. In preparing it, no
  SQL was run, no database (Production, staging, or otherwise) was connected to, and no migration or
  deploy tooling was invoked. Every fact above is quoted or derived from repository files at the
  revision on branch `remediation/audit-2026-07-26`.
- This request conforms to `docs/PRODUCTION_CHANGE_FREEZE_2026-07-25.md` §3 by stating (a) the exact
  statements (§2), (b) pre-state evidence (§3), (c) the rollback (§4), and (d) the operator field
  (§6, blank until execution). Per §3, the executed event must be appended to §5 of the freeze
  document; this file's §6 record must be completed at the same time.
