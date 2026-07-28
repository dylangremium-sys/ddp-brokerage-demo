# P2 — Apply migration 30 (durable risk/requirement override store)

**Audit finding:** R3 — HIGH.
**Owner:** Release owner **+** a DB operator holding a write credential.
**Break-glass required:** **YES.** This is production DDL during an active freeze
(§1.1, §1.3). Record the authorisation in freeze §5 **before** executing, per §3.
**Files:** `30_PROCUREMENT_OVERRIDES_SERVER_AUTHORITATIVE_{HARDENING,VERIFY,ROLLBACK}.sql`

---

## Why

`risk_overrides` and `requirement_overrides` do not exist in production. Measured
2026-07-28, read-only:

```
 risk_overrides | requirement_overrides
----------------+-----------------------
                |                          <- both NULL: absent
```

`src/lib/procurementOverrideStore.ts:114-116,204,263,308` degrades to
`'local-cache'` on exactly `42P01`/`PGRST205` — the state production is in. So
today, risk-status and requirement-status overrides are written to **`localStorage`**
(`ddp_risk_overrides`, `ddp_requirement_overrides`).

Those overrides feed `hasBlockingIssues`, which `src/lib/buyerApprovalGate.ts:24`
combines with a recorded procurement decision to produce
**"DDP Reviewed — Human Approved for Buyer Discussion"**. Both keys are in
`SENSITIVE_DDP_KEYS` (`src/lib/browserPersistence.ts:47-49`), so **sign-out deletes
them**.

A clearance that materially participates in a controlled-substance release label is
therefore unattributable, invisible to other administrators, editable from devtools,
and destroyed by sign-out.

A partial mitigation is already live: `BrowserOnlyProvenanceNotice` renders on both
override surfaces in Supabase mode (`DDPRiskRegister.tsx:231`,
`DDPMissingDocuments.tsx:252`). The system tells the truth about the gap; applying
this migration closes it.

## Prerequisite

**A write credential.** `ddp_ro` is `SELECT`-only and cannot execute any statement
below. As of 2026-07-28 no production write credential is known to exist in this
environment (the `pgpass` `postgres` password is stale and no service-role key was
configured). Obtain one before starting; do not begin and stop half way.

## Pre-state (read-only — run and keep the output)

```sql
BEGIN READ ONLY;

-- Both must be NULL. If either is non-NULL, STOP: the migration is already applied.
SELECT to_regclass('public.risk_overrides')        AS risk_overrides,
       to_regclass('public.requirement_overrides') AS requirement_overrides;

-- Baselines to compare against afterwards.
SELECT count(*) AS public_tables
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind='r';                       -- expect 27

SELECT count(*) AS non_internal_triggers
FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
     JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE NOT t.tgisinternal AND n.nspname='public';                  -- expect 17

-- Migration 30 references public.profiles for its decided_by FK.
SELECT to_regclass('public.profiles') AS profiles;                -- must be non-NULL

COMMIT;
```

## Statements to run

One file, exactly as committed, as a single transaction:

```bash
psql "$PROD_WRITE_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f 30_PROCUREMENT_OVERRIDES_SERVER_AUTHORITATIVE_HARDENING.sql
```

The file is already wrapped in `begin; … commit;`. **Do not** paste it in fragments —
a partial apply leaves tables without their triggers, which is append-only in name
only.

> If you must use the Supabase SQL editor, note that it **hides `RAISE NOTICE`
> output**. You will not see the migration's own progress messages there. Prefer
> `psql`. This is how migration 34's application produced no usable record.

**Never** run `10_BUYER_PACK_SNAPSHOTS_MVP.sql`, and never glob-and-run the SQL
directory — see `docs/runbooks/README.md`.

## Post-state verification

**1. Section A of the migration's own VERIFY** — read-only, safe against production:

```bash
psql "$PROD_RO_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f 30_PROCUREMENT_OVERRIDES_SERVER_AUTHORITATIVE_VERIFY.sql 2>&1 | grep 'VERIFY A'
```

Expected: `VERIFY A PASSED`.

**Do not run the whole file against production.** Sections B onward build a fixture
and insert into `auth.users`.

**2. Object state:**

```sql
BEGIN READ ONLY;
SELECT to_regclass('public.risk_overrides')                AS risk_overrides,          -- non-NULL
       to_regclass('public.requirement_overrides')         AS requirement_overrides,   -- non-NULL
       to_regclass('public.risk_overrides_current')        AS risk_current,            -- non-NULL
       to_regclass('public.requirement_overrides_current') AS requirement_current;     -- non-NULL

-- Append-only must be enforced at BOTH layers.
SELECT tablename, cmd, count(*)
FROM pg_policies WHERE schemaname='public'
  AND tablename IN ('risk_overrides','requirement_overrides')
GROUP BY 1,2 ORDER BY 1,2;
-- Expect SELECT and INSERT only. Any UPDATE/DELETE/ALL row is a FAILURE.

SELECT count(*) AS append_only_triggers
FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
WHERE NOT t.tgisinternal
  AND c.relname IN ('risk_overrides','requirement_overrides');    -- expect 2

-- `authenticated` must hold neither UPDATE nor DELETE, or the append-only claim
-- is contradicted at the privilege layer. Measured via relacl, NOT
-- information_schema.role_table_grants (which returns a false zero as ddp_ro).
SELECT c.relname, r.rolname, a.privilege_type
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace,
     LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
JOIN pg_roles r ON r.oid=a.grantee
WHERE n.nspname='public' AND c.relname IN ('risk_overrides','requirement_overrides')
  AND r.rolname IN ('anon','authenticated')
  AND a.privilege_type IN ('UPDATE','DELETE')
ORDER BY 1,2,3;
-- Expect ZERO rows.
COMMIT;
```

**3. Freeze §4 deltas.** This migration adds 2 tables and 2 triggers:

| Control | Before | After |
|---|---|---|
| public tables / RLS | 27/27 | **29/29** |
| non-internal triggers | 17 | **19** |
| anon-satisfiable write policies | 1 | **1** (unchanged) |

Update freeze §4 in the same change as the §5 break-glass entry. A §4 that
disagrees with reality is the defect R11 already recorded once.

**4. Application behaviour.** No deploy is needed — the client prefers the server
unconditionally once the tables exist. Sign in as a `ddp_admin`, set a risk-status
override, sign out, sign back in, and confirm the override **survives**. Before this
migration it would not.

## Rollback

```bash
psql "$PROD_WRITE_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f 30_PROCUREMENT_OVERRIDES_SERVER_AUTHORITATIVE_ROLLBACK.sql
```

**DESTRUCTIVE.** It drops both tables **and the audit history they hold** — the only
server-side record of who cleared a blocking risk or requirement, when, and why.
The client's localStorage copy is a cache, carries no actor, and is wiped at
sign-out. **Export first if any row has evidentiary value:**

```
\copy (SELECT * FROM public.risk_overrides ORDER BY decided_at) TO 'risk_overrides_backup.csv' CSV HEADER
\copy (SELECT * FROM public.requirement_overrides ORDER BY decided_at) TO 'requirement_overrides_backup.csv' CSV HEADER
```

Rolling back re-opens R3 in full. Record the rollback in freeze §5 as its own event.

## Operator record

| Field | Value |
|---|---|
| Break-glass authorisation recorded in freeze §5 **before** execution | ☐ |
| Authorised by | |
| Operator (name / role) | |
| Date / time (ISO 8601, UTC) | |
| Pre-state output attached | ☐ |
| Applied via (`psql` / SQL editor) | |
| `VERIFY A PASSED` | ☐ |
| Post-state: 4 objects present, no UPDATE/DELETE policy, 0 write grants | ☐ |
| Freeze §4 updated (29/29 tables, 19 triggers) | ☐ |
| Override survives sign-out (end-to-end) | ☐ |
| Notes | |
