# P6 — Apply migration 37: assert storage bucket privacy

**Source:** `37_STORAGE_BUCKET_PRIVACY_HARDENING.sql` (PR #96).
**Owner:** release owner.
**STATUS 2026-07-30:** the SQL Editor runs as `postgres`, which does **not** own
`storage.objects` — so **section 3 (the policies) cannot be applied this way.** See the
correction in Step 0. Section 2 (bucket privacy) may still be possible; Step 0b decides.
**Break-glass required:** **YES** — freeze §1.3 (RLS policy) and §1.4 (storage).
**Verify:** `37_STORAGE_BUCKET_PRIVACY_VERIFY.sql` — read-only, safe on production whole.

---

## The blocking assumption this runbook removes

`docs/runbooks/README.md` records P2, P3 and P4 as blocked on a **"DB write
credential"**, and the working assumption since 2026-07-27 has been that none
exists: `~/.pgpass` fails authentication and no `PROD_RO_DATABASE_URL` is present
anywhere on the engineering machine. That is all still true.

**It does not follow that the changes cannot be applied.** The Supabase
**SQL Editor** in the project dashboard executes SQL as a privileged database role.
On 2026-07-30 the owner ran

```sql
select id, public, file_size_limit from storage.buckets;
```

in that editor and it returned a row. **`ddp_ro` cannot do that** — it has no USAGE
on schema `storage`, which is precisely why bucket privacy had never been measured.
So the editor is demonstrably more privileged than the read-only credential, and
the "no write credential" blocker is about a *psql connection string*, not about
the ability to change the database.

**What is NOT yet proven** is whether that role can also `CREATE POLICY` on
`storage.objects`, which requires membership in that table's owner (in Supabase,
`supabase_storage_admin`). Step 0 settles it in one read-only query. Do not skip it.

> **No password reset is needed to attempt this.** If Step 0 says the route is
> insufficient, *then* a credential is required and P6 stops — but find out with a
> read, not by resetting a production password.

## Why every check here returns a TABLE

The Supabase SQL Editor **does not display `RAISE NOTICE` output.** Migration 37 and
its VERIFY report success through notices, so running them in the editor shows
"Success. No rows returned" and tells you nothing about what happened.

Failures still surface — `RAISE EXCEPTION` appears as an error — so the editor is
**safe**, just **blind on success**. Every check below is therefore written as a
`SELECT` that returns rows you can read. Do not substitute the notice-based scripts
and assume a silent run means a good one.

---

## Step 0 — Capability probe (READ-ONLY, run first, both environments)

Paste as-is. It writes nothing.

```sql
SELECT
  current_user AS running_as,
  (SELECT pg_get_userbyid(c.relowner)
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'storage' AND c.relname = 'objects') AS storage_objects_owner,
  pg_has_role(current_user,
    (SELECT c.relowner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'storage' AND c.relname = 'objects'), 'USAGE')
    AS can_change_storage_policies,
  pg_has_role(current_user,
    (SELECT c.relowner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'storage' AND c.relname = 'buckets'), 'USAGE')
    AS can_write_storage_buckets,
  to_regprocedure('public.has_operational_farmer_access()') IS NOT NULL
    AS helper_present,
  to_regprocedure('public.is_ddp_admin()') IS NOT NULL AS admin_fn_present,
  (SELECT c.relrowsecurity
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'storage' AND c.relname = 'objects') AS storage_objects_rls;
```

`pg_has_role` is called with the owner's **OID**, not its name, so this cannot error
out just because a role name differs between projects.

### CORRECTION 2026-07-30 — `can_write_storage_buckets` above tests the wrong thing

Measured result from the production SQL Editor:

```
running_as | can_change_storage_policies | can_write_storage_buckets | helper | admin_fn | rls
postgres   | false                       | false                     | true   | true     | true
```

`can_change_storage_policies = false` is **correct and decisive**: `CREATE POLICY`
strictly requires ownership of the table, so the policy section of migration 37
cannot be applied from the SQL Editor. That part stands.

**`can_write_storage_buckets` is a bad test.** Writing a row to `storage.buckets` is
an ordinary `INSERT`/`UPDATE` and needs only **table privileges** — not ownership. The
probe asked the ownership question for both, so a `false` here says nothing about
whether the bucket write would succeed. Use Step 0b instead; do not conclude the
bucket half is blocked from the row above.

**Required to proceed with the POLICY section — must hold:**

| Column | Required |
|---|---|
| `can_change_storage_policies` | `true` |
| `helper_present` | `true` |
| `admin_fn_present` | `true` |
| `storage_objects_rls` | `true` |

**If `can_change_storage_policies` is `false` — as measured on production — STOP on
the policy section.** The migration would fail at its own precondition: a clean,
whole-transaction refusal, not a partial apply, so attempting it is not dangerous,
but it cannot succeed. Escalate for a role holding `supabase_storage_admin`, or create
the three policies through the dashboard's **Storage → Policies** UI, which performs
the change server-side rather than through your SQL session.

## Step 0b — Can the bucket half be applied? (READ-ONLY)

This is the security-critical half: asserting `public = false`. It needs INSERT and
UPDATE on `storage.buckets`, nothing more.

```sql
SELECT
  has_table_privilege('storage.buckets', 'INSERT') AS can_insert_buckets,
  has_table_privilege('storage.buckets', 'UPDATE') AS can_update_buckets,
  pg_get_userbyid((SELECT c.relowner FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'storage' AND c.relname = 'objects')) AS objects_owner;
```

`ddp_ro` cannot run this — it has no USAGE on schema `storage`, so
`has_table_privilege` cannot even resolve the table name. It must be run in the SQL
Editor.

- **Both `true`** → apply migration 37's **section 2 only** (the two
  `INSERT … ON CONFLICT` statements). Skip section 3. Section 0's precondition loop
  checks ownership of `buckets` as well, so the file as written will still refuse —
  run the two bucket statements directly, and record on the PR that section 3 was
  deferred.
- **Either `false`** → the whole migration needs an escalated role.
- `objects_owner` names the role to request access to.

### The parts that need no SQL at all

Creating a private bucket is a dashboard action and always has been — migration 8
PART B records `farmer-documents` as exactly that, a "MANUAL Supabase Dashboard step".
So regardless of the above:

**Storage → New bucket → name `farmer-photos` → leave "Public bucket" OFF.**

That achieves the same end state as migration 37 section 2 for the new bucket, and
the existing bucket's privacy can be confirmed or corrected under
**Storage → farmer-documents → Edit bucket**. Prefer the SQL when it is available,
because it is idempotent and reviewable; use the UI when it is not. Either way,
verify with Step 3's queries — the end state is what matters, not the route.

**If `helper_present` is `false`, STOP.** Migration 22 is not applied here. Migration
37's policies call that function; creating them without it would produce policies
that deny every caller — a silent lockout of the bucket.

---

## Step 1 — Pre-state (READ-ONLY, keep the output)

```sql
SELECT id, name, public, file_size_limit
FROM storage.buckets
WHERE id IN ('farmer-documents', 'farmer-photos')
ORDER BY id;

SELECT policyname, permissive, cmd
FROM pg_policies
WHERE schemaname = 'storage' AND tablename = 'objects'
ORDER BY policyname;
```

**Production pre-state as measured 2026-07-30:** one bucket row —
`farmer-documents | false | null` — and three policies, all scoped to
`farmer-documents`. `farmer-photos` does not exist.

**If any bucket shows `public = true`, STOP and treat it as a live incident.**
Applying P6 would close the hole, but any path already published stays published;
the response is wider than this runbook.

---

## Step 2 — Apply to STAGING first

Project `szqocdabwkjrggrddocx`. Paste the **whole** contents of
`37_STORAGE_BUCKET_PRIVACY_HARDENING.sql`. It is one transaction and idempotent —
re-running it converges rather than duplicating.

Expect "Success. No rows returned" (the notices are hidden). **An error means it
refused and rolled back whole; read the message, it names the precondition.**

Then run Step 3 against staging. Only proceed to production when staging is clean.

---

## Step 3 — Post-state verification (READ-ONLY, returns tables)

```sql
-- 1. Both buckets exist and are PRIVATE. This is the whole point of P6.
SELECT id, public, file_size_limit,
       (public IS FALSE) AS is_private_ok
FROM storage.buckets
WHERE id IN ('farmer-documents', 'farmer-photos')
ORDER BY id;
-- Expect 2 rows, is_private_ok = true on both.

-- 2. The three farmer-photos policies landed with the right shape.
SELECT policyname, permissive, cmd,
       (coalesce(qual,'') || coalesce(with_check,'')) LIKE '%farmer-photos%'
         AS scoped_ok,
       (coalesce(qual,'') || coalesce(with_check,'')) LIKE '%has_operational_farmer_access%'
         AS role_checked
FROM pg_policies
WHERE schemaname = 'storage' AND tablename = 'objects'
  AND policyname LIKE 'farmer-photos:%'
ORDER BY policyname;
-- Expect 3 rows, all PERMISSIVE, all scoped_ok = true.
-- role_checked must be true for the two farmer policies; the admin policy is
-- legitimately false — it gates on is_ddp_admin() instead.

-- 3. Nothing pre-existing was disturbed: 3 old + 3 new = 6.
SELECT count(*) AS storage_policies_total
FROM pg_policies WHERE schemaname='storage' AND tablename='objects';

-- 4. Migration 22's overlay — reported, NOT required by P6. Still absent is
--    expected and is not a P6 failure; see P4.
SELECT count(*) AS mig22_overlay_present
FROM pg_policies
WHERE schemaname='storage' AND tablename='objects'
  AND policyname = 'farmer buckets: operational farmer or admin';
```

Optionally run `37_STORAGE_BUCKET_PRIVACY_VERIFY.sql` whole — it is catalog-SELECT
only, builds no `auth.users` fixture and performs no DML in any section, so unlike
every other VERIFY in this repository it is safe against production in full. In the
SQL Editor its passes are invisible; a **failure** will still raise. The table
queries above are the readable equivalent.

Finally, confirm no bucket became publicly readable (P4's probe, unchanged):

```bash
for b in farmer-documents farmer-photos coa-uploads evidence-files buyer-packs; do
  printf '%s -> ' "$b"
  curl -s "https://iihxjrfxmycjafbtjvvq.supabase.co/storage/v1/object/public/$b/probe" | head -c 80; echo
done
```

Expected: `Bucket not found` for each. **`farmer-photos` will now exist as a bucket
but must still report `Bucket not found` on the public path** — that is what
`public = false` means, and it is the single most important line of this output.

---

## Step 4 — Apply to PRODUCTION

Project `iihxjrfxmycjafbtjvvq`. **Before executing:** record the break-glass
authorisation in freeze §5 and complete the operator record below. §3 requires the
authorisation to exist *before* the statements run, not after.

Same paste, same expectations, then Step 3 again.

---

## Rollback

```sql
-- Removes only what migration 37 created.
DROP POLICY IF EXISTS "farmer-photos: admin all"         ON storage.objects;
DROP POLICY IF EXISTS "farmer-photos: farmer read own"   ON storage.objects;
DROP POLICY IF EXISTS "farmer-photos: farmer upload own" ON storage.objects;
```

Or paste `37_STORAGE_BUCKET_PRIVACY_ROLLBACK.sql`, which does the same plus a
guarded, opt-in-and-empty-only bucket deletion.

**The rollback deliberately does NOT set the buckets back to `public = true`.** A
rollback undoes a change; it does not reintroduce a vulnerability. Buckets remaining
private afterwards is the intended end state, not an incomplete reversal.

**Expect `farmer-photos` to become inaccessible to everyone, including admins,**
after a rollback — the `farmer-documents: admin all` policy is scoped to the other
bucket. That is the pre-P6 state, and it is fail-closed.

---

## What P6 does NOT do

- **It does not install migration 22's storage overlay.** That is P4 and remains
  outstanding. Consequence: `farmer-documents`' own policies still carry no role
  check, so a `pending` identity can still read and upload under its own prefix
  there. `farmer-photos` is not exposed this way — its policies carry the check
  inline, precisely because P4 is unresolved.
- **It does not make photo upload work.** That is the application code in PR #97,
  which writes to the bucket P6 creates. **Ship them together:** with the bucket
  absent, PR #97's uploads fail loudly per file, which is correct but visible to
  farmers.
- It does not migrate any existing `photo_urls` data. Those were base64 previews,
  never durable evidence.

---

## Operator record

| Field | Value |
|---|---|
| Step 0 probe: all five columns `true` (paste output) | ☐ |
| Step 1 pre-state captured (paste output) | ☐ |
| No bucket reported `public = true` at pre-state | ☐ |
| Break-glass authorisation recorded in freeze §5 **before** execution | ☐ |
| Authorised by | |
| Operator (name / role) | |
| Environment applied (staging / production) | |
| Date / time (ISO 8601, UTC) | |
| Applied via | Supabase SQL Editor / psql / other: |
| Step 3: both buckets `is_private_ok = true` | ☐ |
| Step 3: 3 farmer-photos policies, correct shape | ☐ |
| Step 3: total storage policies = 6 | ☐ |
| Public-path probe: `Bucket not found` for all five, incl. `farmer-photos` | ☐ |
| Staging applied and verified before production | ☐ |
| PR #97 shipped in the same release | ☐ / N/A |
| Notes | |
