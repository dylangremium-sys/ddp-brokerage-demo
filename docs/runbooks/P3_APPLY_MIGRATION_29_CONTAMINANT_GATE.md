# P3 — Apply migration 29 (server-side contaminant blocker gate)

**Audit finding:** R4 — HIGH (requires an authenticated `ddp_admin`).
**Owner:** Release owner **+** a DB operator holding a write credential.
**Break-glass required:** **YES** — production DDL during an active freeze.
**Depends on:** **P2 (migration 30) must be applied first.** See below.
**Files:** `29_BUYER_PACK_CONTAMINANT_BLOCKER_GATE_{HARDENING,VERIFY,ROLLBACK}.sql`

---

## ⚠️ Two standing hazards, both load-bearing here

**1. `10_BUYER_PACK_SNAPSHOTS_MVP.sql` must NEVER execute against production.** It
re-creates `public.issue_buyer_pack_snapshot` and would silently revert migration
23's server-authoritative issuance to the client-trusting definition — undoing both
migration 23 and this one in a single statement, with no error. There is no
numeric-ordering runner here, and `ls *.sql | sort` orders `10` before `3, 4, 8, 9`,
so **any glob-and-run triggers it.** Apply one named file at a time.

**2. Ordering.** Migration 29 replaces the same function migration 23 owns, and its
gate reasons about override state. Apply **30 first, then 29**, so the durable
override store exists before the gate that consults the world it describes. Applying
29 first is not fatal, but it produces a window in which a server-side gate is
enforced against overrides that live only in a browser — the exact incoherence this
pair exists to remove.

## Why

Production's `public.issue_buyer_pack_snapshot`, measured 2026-07-28:

```
               md5                | len  | prosecdef |              config               | contaminant marker
----------------------------------+------+-----------+-----------------------------------+--------------------
 c4a255b81f220d2e6f67b4d59a97f961 | 3934 | t         | search_path=public, auth, pg_temp | f
```

That is migration **23**'s hardened function — correct, and matching freeze §4
exactly. But its body contains **no** contaminant or lab-status marker: migration 29
is not applied.

The repository states the consequence itself
(`29_..._HARDENING.sql:29-34`): migration 23's gate is admin + decision + named
approver, **never blockers** — so the database will mint an immutable,
audit-logged snapshot for a batch whose own
`heavy_metals`/`pesticides`/`mycotoxins`/`microbial` status is `'fail'`, if the
client-side derivation is bypassed.

**The accidental path is already closed.** `composeRiskId()`
(`src/lib/procurementControl.ts:242-280`) folds an FNV-1a fingerprint of
`severity + issue` into every risk id, so a risk whose content changes to a lab
failure arrives as a new, un-overridden `'open'` blocker, and pre-fix overrides are
inert by construction. Exploitation now requires **deliberate tampering by an
authenticated administrator**, not the accidental route. This is defence in depth
that does not currently exist — real, but not an emergency.

## Pre-state (read-only — run and keep the output)

```sql
BEGIN READ ONLY;

-- 1. The function must be migration 23's, unmodified. If md5 differs, STOP and
--    investigate before replacing it.
SELECT md5(p.prosrc) AS md5, length(p.prosrc) AS len, p.prosecdef,
       array_to_string(p.proconfig, ',') AS config,
       (p.prosrc ~* 'contaminant|heavy_metals|mycotoxin|microbial') AS has_marker
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'issue_buyer_pack_snapshot';
-- Expect: c4a255b81f220d2e6f67b4d59a97f961 | 3934 | t | search_path=public, auth, pg_temp | f

-- 2. P2 must already be applied — both non-NULL.
SELECT to_regclass('public.risk_overrides')        AS risk_overrides,
       to_regclass('public.requirement_overrides') AS requirement_overrides;

-- 3. Snapshots issued so far, for comparison afterwards.
SELECT count(*) AS snapshots FROM public.buyer_pack_snapshots;

COMMIT;
```

**If check 1 returns a different `md5`,** production is not running the function this
migration expects to replace. Stop and reconcile — that is drift, and a
break-glass event of its own.

**If check 2 returns NULLs,** P2 has not been done. Go back and do it.

## Statements to run

```bash
psql "$PROD_WRITE_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f 29_BUYER_PACK_CONTAMINANT_BLOCKER_GATE_HARDENING.sql
```

Prefer `psql` over the Supabase SQL editor: the editor hides `RAISE NOTICE` output,
so the migration's own progress and precondition messages are invisible there.

## Post-state verification

**1. The function changed, and changed in the expected direction:**

```sql
BEGIN READ ONLY;
SELECT md5(p.prosrc) AS md5, length(p.prosrc) AS len, p.prosecdef,
       array_to_string(p.proconfig, ',') AS config,
       (p.prosrc ~* 'contaminant|heavy_metals|mycotoxin|microbial') AS has_marker
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'issue_buyer_pack_snapshot';
COMMIT;
```

- `has_marker` must now be **`t`** — this is the check that actually distinguishes
  migration 29 from migration 23.
- `md5` must **differ** from `c4a255b8…`. Record the new value.
- `prosecdef` must still be `t` and `config` still `search_path=public, auth, pg_temp`.
  A `SECURITY DEFINER` function with an unpinned `search_path` is a
  privilege-escalation vector; freeze §4 G2.2 expects **0** of them.

**2. Section A of the migration's VERIFY** (read-only; never the whole file against
production).

Section A is **extracted first**, so only the reviewed read-only prefix reaches
production — the previous form passed the whole file to `psql` and relied on a warning
the command itself ignored:

```bash
# Extract ONLY Section A (everything before the Section B header) and run that.
sed '/^-- SECTION B —/,$d' 29_BUYER_PACK_CONTAMINANT_BLOCKER_GATE_VERIFY.sql \
  > /tmp/verify29_section_a.sql

# Match the section HEADER line, not the string "SECTION B" — that also appears in
# the file's own preamble, so a bare `grep -c 'SECTION B'` prints 1 on a correct
# extraction and would read as a failure.
grep -c '^-- SECTION B —' /tmp/verify29_section_a.sql              # must print 0
grep -ciE '^[[:space:]]*(insert|update|delete|begin;)' \
  /tmp/verify29_section_a.sql                                     # must print 0

# No pipe: psql's own exit status is the result.
psql "$PROD_RO_DATABASE_URL" -v ON_ERROR_STOP=1 -f /tmp/verify29_section_a.sql
echo "psql exit: $?"    # must be 0
```

Expected: `VERIFY A PASSED`, and `psql exit: 0`.

**Never pipe this into `grep 'VERIFY A'`.** That pattern matches `VERIFY A FAILED` exactly
as well as `VERIFY A PASSED`, and the pipeline's exit status is `grep`'s rather than
`psql`'s — so a failure, a `RAISE EXCEPTION`, or a connection error all read as success.
Section B (line 139 onward) builds a fixture and calls the RPC; against a read-only role
those writes are refused, but they are still attempted and they abort the run.

**3. Update freeze §4.** The issuance-identity row pins
`md5 = c4a255b81f220d2e6f67b4d59a97f961, length = 3934`. **That row becomes wrong
the moment this migration lands.** Replace both values with the newly measured ones
in the same change as the §5 break-glass entry — otherwise every future
close-of-freeze check fails against a stale expectation, which is exactly the
failure mode R11 recorded.

**4. Behaviour, on a NON-PRODUCTION project first if at all possible.** Attempt to
issue a buyer pack for a batch with a `'fail'` contaminant status and confirm the
database refuses it. Verifying this in production means minting a real snapshot —
`buyer_pack_snapshots` is immutable and append-only, so a test row cannot be
removed.

## Rollback

```bash
psql "$PROD_WRITE_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f 29_BUYER_PACK_CONTAMINANT_BLOCKER_GATE_ROLLBACK.sql
```

Read it before running. It restores migration 23's function definition — verify
afterwards that `md5` is back to `c4a255b81f220d2e6f67b4d59a97f961` and
`length = 3934`, and restore freeze §4's issuance row to those values.

Snapshots already issued are **not** removed and cannot be: the table is immutable
and append-only by trigger. Rolling back re-opens R4.

## Operator record

| Field | Value |
|---|---|
| P2 (migration 30) applied first | ☐ |
| Break-glass authorisation recorded in freeze §5 **before** execution | ☐ |
| Authorised by | |
| Operator (name / role) | |
| Date / time (ISO 8601, UTC) | |
| Pre-state `md5` = `c4a255b8…`, `has_marker` = `f` | ☐ |
| Applied via (`psql` / SQL editor) | |
| Post-state `has_marker` = `t` | ☐ |
| **New `md5`** | |
| **New `length`** | |
| `prosecdef` = `t`, `search_path` pinned | ☐ |
| `VERIFY A PASSED` | ☐ |
| Freeze §4 issuance row updated to the new md5/length | ☐ |
| Blocker refusal exercised (environment: ) | ☐ |
| Notes | |
