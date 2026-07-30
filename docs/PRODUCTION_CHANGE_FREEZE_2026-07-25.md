# DDP Production Change Freeze — 2026-07-25

**Status:** ACTIVE
**Scope:** Supabase production project `iihxjrfxmycjafbtjvvq` (DDP brokerage production)
**Window:** From adoption until the Procurement MVP pilot is formally closed, or until lifted in
writing by the same authority.
**Baseline at adoption:** repo `main` = `bce42f8c2aecaa3d4710c306eeb1289a10008497`; production
runtime = same SHA on www.ddpbrokerage.com, ddpbrokerage.com, ddp-brokerage-demo.vercel.app.

## 1. Frozen — no execution during the window

1. **No migration may be applied to production**, in whole or in part.
   **Migration 24 is explicitly DEFERRED** (`24_EVIDENCE_REQUEST_RESOLUTION_HARDENING.sql`,
   `24_EVIDENCE_REQUEST_RESOLUTION_STORAGE.sql`). It has zero references in the deployed bundle
   and in `src/`, so deferral has no runtime effect.
2. **No replay of the SQL corpus** — no "apply-all", no re-run, no partial re-execution.
   `10_BUYER_PACK_SNAPSHOTS_MVP.sql` must **never** execute against production: historically it
   re-created `public.issue_buyer_pack_snapshot` and would silently revert migration 23's
   server-authoritative issuance to the client-trusting definition. There is no numeric-ordering
   runner and `ls *.sql | sort` orders `10` before `3,4,8,9`, so any glob-and-run triggers this.
3. **No production DB schema, privilege, or DML changes** — no `CREATE`, `ALTER`, `DROP`, `GRANT`,
   `REVOKE`, `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE` against `public`, including RLS policies,
   triggers, functions, and role privileges.
4. **No changes to storage buckets or the `auth` schema** (schema or privileges).

## 2. Permitted

- Read-only catalog and data reads via role `ddp_ro` (`NOSUPERUSER`, `NOBYPASSRLS`, `SELECT` only).
- Application deploys from `main` through the existing gated CI path, provided they carry no migration.

## 3. Break-glass

Any exception requires **written authorisation from the release owner, recorded before execution**,
stating: (a) the exact statements to run, (b) pre-state evidence, (c) the rollback, (d) the operator.
Vercel dashboard promotion or Instant Rollback falls under this clause — it moves production off the
verified SHA. All break-glass events must be appended to section 5 of this file.

## 4. Close-of-freeze verification (all must pass)

| Check | Expected |
|---|---|
| Issuance function identity | `md5(prosrc)` of `public.issue_buyer_pack_snapshot` = `c4a255b81f220d2e6f67b4d59a97f961`, `length = 3934`, `prosecdef = t`, `search_path = public, auth, pg_temp` |
| Issuance semantics | Section A of `23_BUYER_PACK_SERVER_AUTHORITATIVE_ISSUANCE_VERIFY.sql` (line 1 to the line before the `-- SECTION B —` divider; re-derive, do not hard-code) returns `VERIFY A PASSED`. **Never run the full file against production** — it inserts into `auth.users`. |
| Release chain | `/version.json` `commitSha` identical on all three production surfaces and equal to the deployed SHA |

### G2 control sweep — re-baselined 2026-07-28

The original G2 row bundled five controls into one line, and three of its five
expectations did not describe the system. One of them (**0 write grants**) was never
achievable on Supabase at all, so the row could not have passed on any day of the
freeze. A control that cannot pass is not a control — it is a checkbox that gets
waived, and a waived row cannot distinguish an authorised change from drift, which
is the whole function this section serves.

Every value below was **measured directly against production on 2026-07-28**, via
role `ddp_ro` inside `BEGIN READ ONLY`. Method notes follow the table.

| # | Control | Expected | Measured 2026-07-28 | Was |
|---|---|---|---|---|
| G2.1 | RLS enabled on public tables | **27/27**, and 0 RLS tables with no policy (72 policies) | 27/27, 0 policy-less | "26/26" — stale, a table has been added since |
| G2.2 | `SECURITY DEFINER` functions with no pinned `search_path` | **0** | 0 | unchanged, correct |
| G2.3 | `TRUNCATE` grants to `anon`/`authenticated` | **0** | 0 | **replaces** "0 INSERT/UPDATE/DELETE/TRUNCATE grants" — see below |
| G2.4 | `INSERT`/`UPDATE`/`DELETE` grants to `anon`/`authenticated` | **144**, across 27 tables (`anon` on 24, `authenticated` on 27) — informational, not a pass/fail gate | 144 / 27 tables | was expected to be 0, which was impossible |
| G2.5 | anon-satisfiable write policies | **1**, and it must be exactly `farmer_access_requests: public submit` | 1, that policy | "0" — stale since migration 34 |
| G2.6 | Non-internal triggers in `public` | **17** | 17 | "16" — stale since migration 34 |
| G2.7 | Functions with `PUBLIC`/`anon` `EXECUTE` | **0** | 0 | not previously listed; added |

**Why G2.3 replaces the old grants row.** Supabase's baseline posture grants
`SELECT, INSERT, UPDATE, DELETE` on public tables to `anon` and `authenticated`, and
access is then controlled by RLS, not by table privileges. Migrations 14 and 15
revoke only `TRUNCATE, TRIGGER, REFERENCES, MAINTAIN` (`14_...:31`, `15_...:36`) plus
`UPDATE, DELETE` on `compliance_audit_log` (`15_...:60`). So "0 write grants" was
never the design and could never have been reached. **The real control is that
`TRUNCATE` is not held by a client role** — that is what migrations 14/15 actually
guarantee, and it is satisfied. G2.4 is retained as an informational count so a
*change* in it is still visible.

The measured 144 breaks down as `anon` 23 DELETE + 24 INSERT + 23 UPDATE (70) and
`authenticated` 23 DELETE + 27 INSERT + 24 UPDATE (74). The tables that hold fewer
than the full set are the deliberately narrowed ones: `compliance_audit_log`
(INSERT only, migration 11/15), `procurement_decisions`, `watchtower_ingestion_items`
and `watchtower_ingestion_runs`.

### Measurement method — binding

Grants **must** be measured with `pg_class.relacl` + `aclexplode()`:

```sql
SELECT count(*), count(DISTINCT c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
     LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
JOIN pg_roles r ON r.oid = a.grantee
WHERE n.nspname = 'public' AND c.relkind = 'r'
  AND r.rolname IN ('anon','authenticated')
  AND a.privilege_type IN ('INSERT','UPDATE','DELETE');
```

**`information_schema.role_table_grants` must NOT be used.** As `ddp_ro` it returns
**0 rows** for this query — not because there are no grants, but because that view
only shows grants involving roles the querying role is a member of. It reports a
false zero that looks exactly like a pass. Reproduced 2026-07-28:

```
=== M3: via pg_class.relacl + aclexplode ===          144 grants, 27 tables
=== M3c: via information_schema.role_table_grants === 0 rows
```

A prior "PASS" on the old grants row was produced by that blind query.

Any drift from the re-baselined values means the freeze was breached — investigate
before closing.

## 5. Break-glass log

### BG-001 — Migration 34, farmer access requests (RETROSPECTIVE)

| Field | Value |
|---|---|
| **Event** | `34_FARMER_ACCESS_REQUESTS_HARDENING.sql` applied to production |
| **Date applied** | 2026-07-28 |
| **Operator** | Repository owner, via the Supabase SQL editor |
| **Authorisation** | **NONE. This was an UNAUTHORISED production change under §3.** §3 requires written authorisation from the release owner, *recorded before execution*, stating (a) the statements, (b) pre-state evidence, (c) the rollback, (d) the operator. No such record was made, and none is invented here. The operator being the release owner does **not** satisfy §3: the control is the *contemporaneous written record*, not the identity of the person acting — an authorisation that can be asserted afterwards by the same party is not a control at all. This entry is a retrospective **record of** an unauthorised change; it does not retroactively authorise it. |
| **Prior classification** | An earlier draft of this row called the event "a record-keeping failure, not an unauthorised change". That was wrong and is corrected here: it contradicted §3's own text and left this record understating what happened. |
| **Statements run** | The full contents of `34_FARMER_ACCESS_REQUESTS_HARDENING.sql` |
| **Pre-state** | Not captured before execution. Reconstructable only negatively: `public.farmer_access_requests` did not exist on `main` before migration 34, and the freeze baseline SHA `bce42f8c` contains no such table. |
| **Rollback** | `34_FARMER_ACCESS_REQUESTS_ROLLBACK.sql` — present in the repository, **not exercised** |
| **Related** | Audit finding R2 — [`docs/audits/DDP_REDBLUE_WEBSITE_AUDIT_2026-07-28.md`](audits/DDP_REDBLUE_WEBSITE_AUDIT_2026-07-28.md) §R2 (line 59). The report is now committed alongside this record; previously it was referenced by filename only and existed nowhere in the repository, so nobody could follow the evidence for this entry. R5 (line 133), R5b (line 156) and R11 (line 259) are in the same document. |

**Objects created** (all verified present in production 2026-07-28, read-only via `ddp_ro`):

| Object | Kind | Measured |
|---|---|---|
| `public.farmer_access_requests` | table | exists, **13 columns**, RLS enabled |
| `farmer_access_requests: public submit` | policy | INSERT, roles `{anon, authenticated}` |
| `farmer_access_requests: admin read` | policy | SELECT, `is_ddp_admin()` |
| `farmer_access_requests: admin triage` | policy | UPDATE, `is_ddp_admin()` |
| `farmer_access_requests_stamp_review` | trigger | present (non-internal trigger count 16 → **17**) |
| `public.stamp_farmer_access_request_review()` | function | `SECURITY DEFINER`, `search_path` pinned |
| 3 × `REVOKE EXECUTE` on that function | privilege | landed — `EXECUTE` held only by `postgres` and `service_role`; **not** by `PUBLIC`, `anon` or `authenticated` |

**Effect on §4.** This event moved three of the close-of-freeze values: non-internal
triggers 16 → 17, anon-satisfiable write policies 0 → 1, and it is the reason the
"0 anon-satisfiable policies" expectation no longer holds. §4 has been re-baselined
accordingly. The single anon-satisfiable policy is **by design** — it is the public
supplier intake form — and is named explicitly in G2.5 so that a *second* one would
still be caught.

**Residual risk accepted by this entry.** The intake path is unauthenticated and
unthrottled (audit R5); the migration's own note says rate limiting belongs at the
edge, but the write goes browser → Supabase directly and never traverses Vercel, so
that mitigation is unreachable as designed. Tracked separately.

### BG-002 — Two dormant `ddp_admin` accounts demoted to `pending`

| Field | Value |
|---|---|
| **Event** | `profiles.role` changed `ddp_admin` → `pending` for two accounts |
| **Date applied** | 2026-07-30 |
| **Operator** | Claude Code, acting inside the repository owner's authenticated browser session as `dylangremium@gmail.com` (`ddp_admin`), via PostgREST `PATCH /rest/v1/profiles`. No service-role key was used; the write ran under the existing `profiles: admin update role` RLS policy as an ordinary admin. |
| **Authorisation** | Given by the release owner **before** execution, in session, after being shown the measured pre-state and the two candidate accounts. It was **not** recorded in this log before execution, so §3 is only partially satisfied: the authorisation was contemporaneous and prior, but the *record* of it is retrospective. That is better than BG-001 and still short of the control as written. |
| **Statements run** | `PATCH /rest/v1/profiles?id=eq.<uuid>&role=eq.ddp_admin` with body `{"role":"pending"}`, twice. The `role=eq.ddp_admin` filter is load-bearing: it makes each write conditional on the row still being an admin, so a concurrent change could not be silently overwritten. Each returned exactly **1** row. |
| **Pre-state** | **Measured before execution** (the gap BG-001 records). `profiles` held exactly three `ddp_admin` rows: `dylan+admin1@gmail.com` (`0e33d21c…`, created 2026-06-30), `dylangremium@gmail.com` (`65e78235…`, created 2026-07-07), `ddp.test.admin.20260708@ddpbrokerage.com` (`545f619e…`, created 2026-07-08). |
| **Post-state** | Verified immediately after: exactly **one** `ddp_admin` remains — `dylangremium@gmail.com`. Both targets read `role: 'pending'`. |
| **Rollback** | `PATCH /rest/v1/profiles?id=eq.<uuid>` with `{"role":"ddp_admin"}` for either id above. Not exercised. |

**Why each account was demoted.**

| Account | Evidence |
|---|---|
| `ddp.test.admin.20260708@ddpbrokerage.com` | Display name reads **"DDP Test Admin Disabled"** — a previous attempt to retire it changed only the label and left the `ddp_admin` role intact, so it had been a full admin throughout. Activity is confined to a single day: created 12:57, then 10 `compliance_audit_log` actions between 13:04 and 17:16 on 2026-07-08 (`rule_suggested`, `rule_approved`, `rule_retired`, `alert_created`, `alert_resolved`, `legal_update_created`, `sent_to_legal_review`), plus 2 `compliance_reviews` and 1 `compliance_rules.approved_by`. Nothing since — dormant 22 days. |
| `dylan+admin1@gmail.com` | **Zero** rows in `compliance_audit_log`, `buyer_pack_snapshots`, `farmer_review_requests`, `farm_memberships`, `compliance_reviews` or `compliance_rules`. Never used for anything. Its Gmail plus-alias resolves to the mailbox `dylan@gmail.com`, which the release owner does **not** control — so password-recovery mail for a full DDP admin was deliverable to a third party. The owner classified it as hostile. |

**Demoted, not deleted — deliberately.** `compliance_audit_log.actor_id`,
`compliance_reviews.reviewed_by` and `compliance_rules.approved_by` reference
`auth.users(id)` with no `ON DELETE` clause, so deleting the auth user would either be
refused by the foreign key or, if forced, destroy the attribution of 13 compliance
records. Attribution was verified intact after the change: all **10** audit rows still
resolve to `545f619e…`. `pending` is the correct terminal state — it is non-operational
(`resolvePostLoginDecision` denies it, every DDP surface fails closed, and RLS denies the
reads), while leaving the identity present for the history that points at it.

**Effect on §4. None.** G2.1–G2.7 measure schema-level controls — RLS coverage, `SECURITY
DEFINER` search paths, grants, anon-satisfiable policies, trigger counts, function
`EXECUTE`. No close-of-freeze value counts admin accounts or `profiles` rows, so no
baseline moves and no re-baselining is required. This was checked before the write, not
assumed.

**Residual risk.** The two auth users still exist and can still authenticate; only their
authorisation was removed. Deleting or disabling them at the auth layer requires the
Supabase dashboard or a service-role key and has not been done. Until then,
`dylan+admin1@gmail.com` remains a recoverable account belonging to an uncontrolled
mailbox — now with no privileges, but its existence is still a loose end.
### BG-003 — Migration 36 **part 1 of 2** (additive only), public intake throttle

| Field | Value |
|---|---|
| **Event** | Apply the **additive half** of `36_FARMER_ACCESS_REQUEST_INTAKE_HARDENING.sql` to production |
| **Proposed date** | 2026-08-02 |
| **Operator** | Repository owner, via the Supabase SQL editor |
| **Authorisation** | **GRANTED** by the release owner on 2026-08-02, explicitly and in advance, authorising PR #108. The merge was executed by the assistant on that instruction; the authorising decision is the owner's, the mechanical act is not. Recorded **before** execution per §3 — no statement from this entry had been run at the time of merge. |
| **Why now** | Audit finding **R5** is live and unmitigated: the public supplier form writes browser → Supabase directly, `anon` holds table-level INSERT, and the publishable key is in the public JS bundle. Any party can insert unlimited rows. This step installs the throttle machinery that closes it. |

**(a) Exact statements to run**

The contents of `~/Desktop/DDP_INTAKE_THROTTLE/STEP1_add_throttle.sql` — which is
`36_FARMER_ACCESS_REQUEST_INTAKE_HARDENING.sql` **with lines 166–181 removed**.

Those 16 removed lines are the privilege reduction (drop the `public submit`
policy, create `server submit`, revoke INSERT from `anon` and `authenticated`).
**They are NOT authorised by this entry** and must not be run. They require their
own record once the application change has shipped and been confirmed.

What this file does, in full:

| Statement | Effect |
|---|---|
| `CREATE EXTENSION IF NOT EXISTS pgcrypto` | no-op — already installed, version **1.3** |
| `CREATE TABLE public.public_intake_attempts` | new table, RLS enabled |
| 2 × `CREATE INDEX` on that table | new indexes |
| `REVOKE ALL` on that table from `anon`, `authenticated` | on the **new** table only |
| `GRANT SELECT, INSERT, DELETE` on that table to `service_role` | on the **new** table only |
| 1 policy on that table | `service_role` only |
| `CREATE OR REPLACE FUNCTION reserve_public_intake_slot` | new function |
| `CREATE OR REPLACE FUNCTION has_open_access_request` | new function |
| `REVOKE`/`GRANT EXECUTE` on those two functions | on the **new** functions only |

**No existing object is altered.** Every privilege change is scoped to objects
this file creates. `farmer_access_requests` is read by a precondition check and
otherwise untouched.

**(b) Pre-state evidence** — measured `2026-08-02T05:07:36Z`, read-only via `ddp_ro`:

| Object | Pre-state |
|---|---|
| `public.public_intake_attempts` | **ABSENT** |
| `public.reserve_public_intake_slot(text,text,jsonb)` | **ABSENT** |
| `public.has_open_access_request(text)` | **ABSENT** |
| `pgcrypto` | present, 1.3 |
| `farmer_access_requests` policies | `admin read` / `admin triage` / `public submit` |
| `farmer_access_requests` grants | `anon=arwd`, `authenticated=arwd`, `service_role=arwdDxtm` |
| non-internal triggers | 23 |
| public functions | 18 |

Expected post-state: functions 18 → 20, one new table, triggers unchanged at 23,
and `farmer_access_requests` policies and grants **identical** to the above.

**(c) Rollback**

`~/Desktop/DDP_INTAKE_THROTTLE/UNDO_everything.sql`
(= `36_FARMER_ACCESS_REQUEST_INTAKE_ROLLBACK.sql`, unmodified).

**Exercised, not merely present** — unlike BG-001's. Run on a disposable
PostgreSQL 18.4 cluster on 2026-08-02 against a production-faithful starting
state: it removed both functions and the table and restored the intake to its
current posture.

Because this entry authorises only the additive half, the rollback is strictly
"remove what was added". Nothing is taken away that would need restoring.

**(d) Operator** — repository owner, Supabase SQL editor.

---

**Risk assessment**

*Impact if it works:* none visible. The supplier form continues to write directly,
exactly as it does today. The machinery is installed but nothing consumes it until
the application change ships.

*Impact if it fails:* the file is wrapped in `BEGIN … COMMIT`, so a failure leaves
production unchanged.

*If run twice:* safe. Verified by running it twice in succession on the disposable
cluster. This matters because the Supabase SQL editor does not display
`RAISE NOTICE`, so a successful run and a no-op look identical, and re-pasting is
the natural operator response.

*What this does NOT do:* it does not throttle anything yet. R5 stays open until
the application change ships and BG-004 closes the direct write path.

**Verification after execution**

The SQL editor suppresses the VERIFY script's output, so verification is by
independent read-only probe rather than by reading the editor. Expected:
`public_intake_attempts` present, both functions present, `farmer_access_requests`
policies and grants unchanged from (b).

**Effect on §4 close-of-freeze values**

| §4 value | Before | After |
|---|---|---|
| non-internal triggers | 23 | 23 (unchanged) |
| anon-satisfiable write policies | 1 | **1 (unchanged)** |
| public functions | 18 | 20 |

The anon-satisfiable policy count is deliberately unchanged: this step does not
touch it. Closing it is BG-004's job.

---

**Honest note on the freeze's current condition.** The freeze baseline SHA is
`bce42f8c`; production today serves `98883ff`. The migration clause has held —
migrations 24, 28, 30 and 36 are all measurably absent from production — but
production has moved off the verified SHA many times through ordinary merges.
This entry does not attempt to resolve that. It is raised so the freeze is not
treated as intact when only part of it is.

---

### BG-004 — Migration 36 **part 2 of 2** (the privilege change), closing R5


| Field | Value |
|---|---|
| **Event** | Apply §2 of `36_FARMER_ACCESS_REQUEST_INTAKE_HARDENING.sql` (lines 166–181) to production |
| **Proposed date** | 2026-08-02 |
| **Operator** | Repository owner, via the Supabase SQL editor |
| **Authorisation** | **GRANTED** by the release owner on 2026-08-02, explicitly and in advance, authorising PR #110. The merge was executed by the assistant on that instruction; the authorising decision is the owner's, the mechanical act is not. Recorded **before** execution per §3 — no statement from this entry had been run at the time of merge. |
| **Closes** | Audit finding **R5** |

**The migration's own ordering precondition — all four now satisfied**

Its header states a required order "no exceptions". Each is met and evidenced:

| # | Required | Status |
|---|---|---|
| 1 | Deploy the application carrying `api/public/access-request.ts` | ✅ production serves `9c0f69b` |
| 2 | `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` set in Vercel Production | ✅ both present |
| 3 | Confirm the endpoint accepts a submission end to end | ✅ HTTP 200; ledger 0→2; enquiries 6→7 |
| 4 | Only then apply this migration | ← this entry |

The header's warning that `SUPABASE_SERVICE_ROLE_KEY` is unset was written
2026-07-28 and is **stale**; it has since been set.

**(a) Exact statements to run**

`~/Desktop/DDP_INTAKE_THROTTLE/STEP3_close_browser_path.sql` — lines 166–181 of the
migration, wrapped in `BEGIN … COMMIT`, plus the idempotency guard from commit
`8748284` (already merged via PR #106).

| Statement | Effect |
|---|---|
| `DROP POLICY "farmer_access_requests: public submit"` | removes the anon INSERT policy |
| `DROP POLICY IF EXISTS "… server submit"` | idempotency guard — makes a re-paste safe |
| `CREATE POLICY "farmer_access_requests: server submit"` | INSERT for `service_role`, same WITH CHECK as before |
| `REVOKE INSERT … FROM anon` | removes the table-level grant |
| `REVOKE INSERT … FROM authenticated` | same |

Nothing else is touched. `admin read`, `admin triage`, the stamp trigger, the
throttle ledger and both functions are all untouched.

**(b) Pre-state evidence** — measured `2026-08-02T06:37:23Z`, read-only via `ddp_ro`:

| Item | Pre-state |
|---|---|
| Policies on `farmer_access_requests` | `admin read` / `admin triage` / **`public submit`** |
| Grants | `anon=arwd`, `authenticated=arwd`, `service_role=arwdDxtm` |
| INSERT policies naming `anon` | **1** (`public submit`) |
| `anon` holds INSERT on `farmer_access_requests` | **true** |
| `reserve_public_intake_slot` | present (BG-003) |
| `public_intake_attempts` | present (BG-003) |

Expected post-state: `public submit` replaced by `server submit`; INSERT policies
naming `anon` **1 → 0**; `anon` INSERT on this table **true → false**; throttle
objects unchanged.

**(c) Rollback**

`~/Desktop/DDP_INTAKE_THROTTLE/UNDO_step3_only.sql` — **not** the migration's own
rollback file.

This distinction is load-bearing. `36_..._ROLLBACK.sql` also drops the throttle
ledger and both functions. Running it now would tear out the BG-003 work *and*
leave the deployed application calling functions that no longer exist — converting
a reversible privilege change into an outage. The scoped file restores only the
policy and the grants.

**Exercised**, on a disposable PostgreSQL 18.4 cluster reproducing today's exact
production shape: browser blocked after apply, server still permitted, throttle
functions still present after undo, and both files safe to run twice.

**(d) Operator** — repository owner, Supabase SQL editor.

---

**Risk assessment**

*Expected impact:* none visible. The deployed bundle contains the endpoint call
once and **zero** direct inserts to `farmer_access_requests` — verified against the
live JavaScript at `9c0f69b`. Nothing in production still uses the path being
closed.

*If the application were still using it:* the form would fail closed with a
`503` and the honest message "contact the DDP team directly" — not a silent loss.

*If it fails:* wrapped in a transaction, so production is left unchanged.

*If run twice:* safe, verified. The SQL editor hides `RAISE NOTICE`, so re-pasting
is the natural response to a silent success.

**Effect on §4 close-of-freeze values**

| §4 value | Before | After |
|---|---|---|
| anon-satisfiable INSERT policies | 1 | **0** |
| `anon` INSERT grant on `farmer_access_requests` | held | **revoked** |
| non-internal triggers | 23 | 23 |
| public functions | 20 | 20 |

This restores the "0 anon-satisfiable write policies" expectation that BG-001 had
to re-baseline away. G2.5 named the single exception; after this there is none.

**What this does NOT do**

`anon` retains table-level INSERT on 23 other tables from Supabase's baseline
defaults. Those are inert — no permissive INSERT policy admits `anon` on any of
them — but they are the reason the migration revokes the grant as well as dropping
the policy: a grant with no policy re-opens the moment any permissive policy is
added. Out of scope here, worth a separate look.

---

### BG-005 — Migration 30, server-authoritative procurement overrides (audit F2)


| Field | Value |
|---|---|
| **Event** | Apply `30_PROCUREMENT_OVERRIDES_SERVER_AUTHORITATIVE_HARDENING.sql` to production |
| **Proposed date** | 2026-08-02 |
| **Operator** | Repository owner, via the Supabase SQL editor |
| **Authorisation** | **GRANTED** by the release owner on 2026-08-02, explicitly and in advance, authorising PR #111. The merge was executed by the assistant on that instruction; the authorising decision is the owner's, the mechanical act is not. Recorded **before** execution per §3. |
| **Closes** | Audit finding **F2** |

**Why**

RISK-STATUS and REQUIREMENT-STATUS overrides are currently written to
`localStorage` only — in Supabase mode as well as demo mode. They have no
server-side record, no recorded approver, are invisible to every other
administrator, and are destroyed by signing out. The application already carries
the code to use a server table and falls back to local storage only because the
table does not exist. This migration provides it.

This is the same condition the `BrowserOnlyProvenanceNotice` component warns
about on screen. That notice exists because this migration was never applied.

**(a) Exact statements to run**

The full contents of `30_PROCUREMENT_OVERRIDES_SERVER_AUTHORITATIVE_HARDENING.sql`,
unmodified. No split is needed — it is additive throughout.

| Creates | Detail |
|---|---|
| `public.risk_overrides` | new table, RLS enabled |
| `public.requirement_overrides` | new table, RLS enabled |
| 4 indexes | on the new tables |
| 2 trigger functions + 2 triggers | block `UPDATE`/`DELETE` — append-only |
| 4 policies | admin `SELECT` and `INSERT` only |
| 2 views | `*_overrides_current` |

**No existing object is altered.** Every `DROP` in the file is an
`IF EXISTS` guard on an object the same file creates (idempotency), and every
`REVOKE` is scoped to the two new tables. Both new tables carry a foreign key to
`public.profiles`, which is present.

**(b) Pre-state evidence** — measured `2026-08-02T07:36:22Z`, read-only via `ddp_ro`:

| Item | Pre-state |
|---|---|
| `risk_overrides` | **ABSENT** |
| `requirement_overrides` | **ABSENT** |
| `risk_overrides_current` | **ABSENT** |
| `prevent_risk_override_mutation` | **ABSENT** |
| `public.profiles` (FK target) | present |
| public functions | 20 |
| non-internal triggers | 23 |

Expected post-state: both tables and both views present, public functions
20 → 22, non-internal triggers 23 → 25.

**(c) Rollback**

`30_PROCUREMENT_OVERRIDES_SERVER_AUTHORITATIVE_ROLLBACK.sql`, unmodified.

**Exercised** on a disposable PostgreSQL 18.4 cluster on 2026-08-02: it removed
both tables cleanly with no residue. Because this migration is purely additive,
the rollback is strictly "remove what was added" — nothing is taken away that
would need restoring.

Any override rows recorded before a rollback would be lost with the tables. That
is the same exposure they have today in `localStorage`, not a new one.

**(d) Operator** — repository owner, Supabase SQL editor.

---

**Rehearsal result** (disposable PG 18.4, 2026-08-02)

| Check | Result |
|---|---|
| Applied twice in succession | OK — idempotent |
| Both tables, both views created | OK |
| RLS enabled on both | OK |
| `anon` holds no privilege | OK |
| `UPDATE` an override row | **blocked** — append-only trigger holds |
| `DELETE` an override row | **blocked** — append-only trigger holds |
| `30_..._VERIFY.sql` | **9/9 passed** |
| Rollback | clean, no residue |

**Risk assessment**

*No deploy is required and none should be made.* The application code is already
live and detects the tables' absence narrowly (`42P01` / `PGRST205`), degrading to
local storage. Once the tables exist it switches to the server automatically.

*What changes for an operator:* new overrides gain a server record with a named
approver, visible to other administrators and surviving sign-out. The on-screen
"exists only in this browser" notice stops appearing for them.

*What does NOT change:* overrides already recorded in a browser stay there. The
store keeps loading `localStorage` for backward compatibility, and this migration
does not migrate them. Anyone relying on an existing override should expect it to
remain browser-local until it is re-recorded.

*Untested path:* the application's server-write path for overrides has never run
against a real table anywhere. The rehearsal proves the schema, the append-only
guarantee and the policies; it does not prove the client writes to it correctly.
That should be confirmed by recording one override in the admin UI after applying,
and checking it lands.

*If it fails:* the file is wrapped in a transaction, so production is unchanged.

**Effect on §4 close-of-freeze values**

| §4 value | Before | After |
|---|---|---|
| public functions | 20 | 22 |
| non-internal triggers | 23 | 25 |
| anon-satisfiable INSERT policies | 0 | **0** (unchanged) |

---

### Process note

**Five production changes have now been made during this freeze: BG-001 through BG-005.**
The earlier claim that "no further production change has been made" was true when written
and is not any more.

That claim survived on `main` while BG-003, BG-004 and BG-005 were appended directly above
it, so the log asserted "no further production change" on the same page as three further
production changes. Corrected here, on the rebase that finally lands BG-002 — **which is
the point of the control.** A log whose summary line is not updated when an entry is added
tells the next reader the opposite of what its own body says, and §4's verification cannot
distinguish an authorised change from drift if the summary is the part people read.

**Known gap — one event is still unrecorded.** The promotion of `dylangremium@gmail.com`
to `ddp_admin` on 2026-07-29, performed by the owner through the Supabase SQL editor, is a
production DB write under this freeze and has no entry in this log. It is named in
`~/Desktop/DDP_SESSION_HANDOVER_2026-07-29.md` §3. No entry is invented for it here,
because its pre-state and exact statements were not captured and would have to be guessed.
It should be added retrospectively by whoever performed it.

This log is the authoritative record; §4's verification cannot distinguish an authorised
change from drift unless every future event is appended here **before** it is executed.

## 5b. Migration code merged during the freeze — NOT applied

**Recorded 2026-07-29.** Fourteen pull requests were merged to `main` on this date, four of
them carrying migration SQL: **27** (#44), **28** (#73), **35** (#83) and **36** (#85).

This is **not** a breach of §1, and is recorded here so that nobody later mistakes a
repository state for a database state:

- §1 freezes **execution** against the production database. Merging a `.sql` file to `main`
  executes nothing. There is no auto-apply step in either workflow — `Deploy to Production`
  runs `vercel deploy --prebuilt`, and no job in `.github/workflows/` connects to a database.
- §2 permits application deploys from `main` through the gated CI path provided they carry no
  migration. The deploys triggered by these merges carried application code only.

**Applied-state is unchanged by any of this.** The following migrations now exist in the
repository and are applied **nowhere** — not production, not staging:

| Migration | Source PR | Applied to prod? | Applied to staging? |
|---|---|---|---|
| 27 — compliance audit-log actor | #44 | **No** | No |
| 28 — evidence digest dedup | #73 | **No** | No |
| 29 — buyer-pack contaminant gate | earlier | **No** | No |
| 30 — procurement overrides | earlier | **No** | No |
| 35 — atomic status transition | #83 | **No** | No |
| 36 — public intake hardening | #85 | **No** | No |

**Migration 36 carries an ordering precondition.** It revokes the anon INSERT the public
supplier form relies on. Applying it before `/api/public/access-request` is deployed **and**
`SUPABASE_SERVICE_ROLE_KEY` is set in Vercel Production takes the intake form offline. As of
2026-07-29 that variable is **not set**. See `docs/runbooks/P1_SET_SUPABASE_SERVICE_ROLE_KEY.md`.

Applying any of the six remains a §3 break-glass event requiring written authorisation
recorded **before** execution.

## 6. Signature

- **Adopted by (name / title):** Dylan Murtagh — DDP release owner
- **Date (ISO 8601):** 2026-07-25
- **Authority:** Release owner, DDP Procurement MVP pilot
- **Provenance:** Adopted by explicit instruction during the 2026-07-25 release-hardening session;
  recorded by the agent acting as scribe. Countersign in git history via the commit below.
