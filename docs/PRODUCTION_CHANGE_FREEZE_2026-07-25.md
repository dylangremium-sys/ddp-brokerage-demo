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
| **Authorisation** | **RETROSPECTIVE — recorded 2026-07-28, after execution.** §3 requires written authorisation *before* execution. No such record was made, and none is invented here. The change itself was made by the owner, so this is a **record-keeping failure, not an unauthorised change**. |
| **Statements run** | The full contents of `34_FARMER_ACCESS_REQUESTS_HARDENING.sql` |
| **Pre-state** | Not captured before execution. Reconstructable only negatively: `public.farmer_access_requests` did not exist on `main` before migration 34, and the freeze baseline SHA `bce42f8c` contains no such table. |
| **Rollback** | `34_FARMER_ACCESS_REQUESTS_ROLLBACK.sql` — present in the repository, **not exercised** |
| **Related** | Audit finding R2, `DDP_REDBLUE_WEBSITE_AUDIT_2026-07-28.md` |

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

### Process note

No further production change has been made during this freeze. This log is now the
authoritative record; §4's verification cannot distinguish an authorised change from
drift unless every future event is appended here **before** it is executed.

## 6. Signature

- **Adopted by (name / title):** Dylan Murtagh — DDP release owner
- **Date (ISO 8601):** 2026-07-25
- **Authority:** Release owner, DDP Procurement MVP pilot
- **Provenance:** Adopted by explicit instruction during the 2026-07-25 release-hardening session;
  recorded by the agent acting as scribe. Countersign in git history via the commit below.
