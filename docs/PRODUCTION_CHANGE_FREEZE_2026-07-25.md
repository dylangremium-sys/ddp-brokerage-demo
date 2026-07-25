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
| G2 control sweep | RLS enabled on 26/26 public tables; 0 SECURITY DEFINER functions without pinned `search_path`; 0 INSERT/UPDATE/DELETE/TRUNCATE grants to `anon`/`authenticated`; 0 anon-satisfiable policies; 16 non-internal triggers |
| Release chain | `/version.json` `commitSha` identical on all three production surfaces and equal to the deployed SHA |

Any drift means the freeze was breached — investigate before closing.

## 5. Break-glass log

_(none)_

## 6. Signature

- **Adopted by (name / title):** Dylan Murtagh — DDP release owner
- **Date (ISO 8601):** 2026-07-25
- **Authority:** Release owner, DDP Procurement MVP pilot
- **Provenance:** Adopted by explicit instruction during the 2026-07-25 release-hardening session;
  recorded by the agent acting as scribe. Countersign in git history via the commit below.
