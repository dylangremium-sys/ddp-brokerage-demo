# P4 — Apply migration 22's storage overlay

**Audit finding:** R9 — MEDIUM.
**Owner:** Release owner **+** a DB operator holding a write credential.
**Break-glass required:** **YES** — freeze §1.3 (RLS policy) *and* §1.4 (storage).
**Authoritative request document:** `docs/BREAK_GLASS_REQUEST_STORAGE_OVERLAY_22.md`
**Source:** `22_OPERATIONAL_FARMER_ACCESS_RLS_HARDENING.sql`, lines 156-172.

---

## This runbook does not restate the request

`docs/BREAK_GLASS_REQUEST_STORAGE_OVERLAY_22.md` already carries the exact
statements, the impact analysis, the rollback and the authorisation block, and it
is written to freeze §3's required shape. **Use it.** Copying its SQL into a second
document would create two sources of truth for a policy definition, which is how
they drift.

What follows is only what a runbook adds: an independent re-measurement of the
pre-state, the post-state check, and an operator record.

## Re-measured 2026-07-28 (read-only, `ddp_ro`)

The 2026-07-26 finding still holds. `storage.objects` carries exactly **three**
policies, all scoped to `farmer-documents`:

| Policy | Predicate |
|---|---|
| `farmer-documents: admin all` | `bucket_id='farmer-documents' AND is_ddp_admin()` |
| `farmer-documents: farmer read own` | `… AND (is_ddp_admin() OR auth.uid()::text = (string_to_array(name,'/'))[1])` |
| `farmer-documents: farmer upload own` | `… AND auth.uid()::text = (string_to_array(name,'/'))[1]` |

The upload check is a **path-prefix test only — no role check.** Migration 22's
RESTRICTIVE `farmer buckets: operational farmer or admin` overlay is absent, and
**`farmer-photos` has no policy at all.**

### Two things that keep this at MEDIUM

**No bucket is publicly readable.** The public object path returns
`Bucket not found` for `farmer-documents`, `farmer-photos`, `coa-uploads`,
`evidence-files` and `buyer-packs`, and an anonymous `storage/object/list` returns
`[]`.

**Cross-tenant read remains blocked** by the existing prefix predicate. The accurate
impact is unauthorised storage consumption and content staging by non-operational
identities — a `pending` account holding a valid JWT — **not** cross-tenant data
leakage. Do not overstate it.

**UNPROVEN:** whether any `pending` identity currently exists. `ddp_ro` has no
`EXECUTE` on `is_ddp_admin()`, so RLS-gated `public.profiles` cannot be counted
from that credential. The gap is structural and confirmed; reachability is
unmeasured — which is not the same as "no risk".

## Pre-state (read-only — run and keep the output)

```sql
BEGIN READ ONLY;

-- Expect exactly the three farmer-documents policies listed above, and no
-- 'farmer buckets: operational farmer or admin'.
SELECT policyname, permissive, cmd, roles
FROM pg_policies WHERE schemaname='storage' AND tablename='objects'
ORDER BY policyname;

-- Expect 0 — this is what P4 installs.
SELECT count(*) AS overlay_present
FROM pg_policies
WHERE schemaname='storage' AND tablename='objects'
  AND policyname = 'farmer buckets: operational farmer or admin';

-- RLS must already be ON for storage.objects; the overlay is meaningless without it.
SELECT c.relrowsecurity AS storage_objects_rls
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='storage' AND c.relname='objects';   -- expect t

-- The overlay calls this. It must exist, or CREATE POLICY fails and rolls back.
SELECT to_regprocedure('public.has_operational_farmer_access()') AS helper;  -- non-NULL

COMMIT;
```

**If `overlay_present` is 1, stop** — it is already applied.

## Statements to run

Exactly the two statements in §2 of `docs/BREAK_GLASS_REQUEST_STORAGE_OVERLAY_22.md`
(a `DROP POLICY IF EXISTS` and the `CREATE POLICY … AS RESTRICTIVE`), and nothing
else. Do not run any other part of migration 22 — the 11-table overlay and its
helper are already applied and correct.

Two cautions specific to this one:

- **Ownership.** `CREATE POLICY` on `storage.objects` requires ownership of that
  table. If the executing role does not own it, the statement fails and the whole
  transaction rolls back. That is a safe failure, not a partial apply — but plan
  for it rather than discovering it mid-window.
- **RESTRICTIVE semantics.** The overlay **narrows**: an operation must satisfy it
  **and** an existing permissive policy. Adding it cannot widen access, which is
  why it is safe to apply ahead of any application change. It can, however, revoke
  access from an identity that has it today — specifically a non-`farmer` account
  currently uploading under its own prefix, which is the behaviour being removed.

## Post-state verification

```sql
BEGIN READ ONLY;

-- 1. The overlay exists and is RESTRICTIVE. PERMISSIVE would be a silent
--    no-op — worse than absent, because it looks applied.
SELECT policyname, permissive, cmd, roles, qual
FROM pg_policies
WHERE schemaname='storage' AND tablename='objects'
  AND policyname = 'farmer buckets: operational farmer or admin';
-- Expect exactly 1 row, permissive = 'RESTRICTIVE'.

-- 2. The three pre-existing policies are untouched — 4 total now.
SELECT count(*) AS storage_policies
FROM pg_policies WHERE schemaname='storage' AND tablename='objects';   -- expect 4

COMMIT;
```

Then, on a **non-production** project if one is available, confirm behaviourally
that a `pending` identity can no longer upload under its own prefix and that an
operational farmer still can. A storage policy that silently blocks legitimate
farmer uploads is a worse outcome than the gap it closes.

Also confirm no bucket became publicly readable:

```bash
for b in farmer-documents farmer-photos coa-uploads evidence-files buyer-packs; do
  printf '%s -> ' "$b"
  curl -s "https://iihxjrfxmycjafbtjvvq.supabase.co/storage/v1/object/public/$b/probe" | head -c 80; echo
done
```

Expected: `Bucket not found` for each.

## Freeze §4 impact

Policy counts in §4 cover `public`, not `storage`, so the G2 sweep values are
unchanged by this. Record the event in §5 regardless — §3 requires it for every
break-glass action, and this one touches storage, which §1.4 names explicitly.

## Rollback

```sql
DROP POLICY IF EXISTS "farmer buckets: operational farmer or admin" ON storage.objects;
```

Restores the current state exactly. No object, bucket or row is affected — the
policy governs access, not data. Rolling back re-opens R9. Record it in §5 as its
own event.

## Operator record

| Field | Value |
|---|---|
| Break-glass authorisation completed in `BREAK_GLASS_REQUEST_STORAGE_OVERLAY_22.md` §6 **before** execution | ☐ |
| Recorded in freeze §5 before execution | ☐ |
| Authorised by | |
| Operator (name / role) | |
| Date / time (ISO 8601, UTC) | |
| Pre-state: 3 policies, `overlay_present` = 0, RLS = `t`, helper present | ☐ |
| Executing role owns `storage.objects` | ☐ |
| Post-state: 4 policies, overlay is `RESTRICTIVE` | ☐ |
| Buckets still non-public | ☐ |
| Behavioural check (environment: ) | ☐ |
| `farmer-photos` still unpoliced — accepted / follow-up raised | |
| Notes | |

> **`farmer-photos` is not fixed by this.** The overlay is scoped to the farmer
> buckets named in migration 22; the audit found `farmer-photos` carries **no
> policy at all**. Decide explicitly whether that is acceptable and record the
> decision — do not let P4 close R9 by implication.
