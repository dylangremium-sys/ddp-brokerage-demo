# Migration 24 — Hosted Staging Verification Runbook & Package

**Feature:** Evidence Request & Resolution
**Migration family:** `24_EVIDENCE_REQUEST_RESOLUTION_{HARDENING,STORAGE,VERIFY,ROLLBACK}.sql`
**Release gate satisfied by this document:** `docs/EVIDENCE_RELEASE_READINESS_CHECKLIST.md` → **G2**
**Binding behaviour reference:** `docs/EVIDENCE_REQUEST_RESOLUTION_CONTRACT.md` (v1.5)
**Status vocabulary:** `docs/MIGRATION_RUNTIME_STATUS.md`

> **Purpose.** Give a human operator an unambiguous procedure to (1) apply migration
> 24 to hosted **staging**, (2) verify it under **non-owner principals**, and (3)
> record the result as durable evidence. Completing this runbook with a **GO**
> decision is the precondition for integrating the Evidence application layer from
> `feature/evidence-request-workflow-v2`.

> **This document does not itself apply anything.** No migration is applied by
> reading it. Every mutating step below is an explicit operator action against
> hosted staging.

---

## 0. Current state (must be true before you start)

| Fact | Value |
|---|---|
| Migration 24 SQL | **Merged on `main`** (PR #37, `9496e1c`, 2026-07-23) |
| Migration 24 on hosted staging | **`NOT_APPLIED`** (as of the last runtime-status entry) |
| Migration 24 on hosted production | **`NOT_APPLIED`** — **out of scope for this runbook** |
| Existing runtime evidence | Disposable local PostgreSQL only (VERIFY A–M, owner role). **Insufficient** — see §1. |
| Evidence coverage in `npm run security:staging` | **None.** The harness has no evidence group and its catalog-VERIFY allowlist is only files 11/12/14/15. The role matrix in §5 is therefore executed **manually** for this migration. |

If migration 24 is already present in staging (unexpected), **stop** and reconcile
`docs/MIGRATION_RUNTIME_STATUS.md` before doing anything else — do not re-apply.

---

## 1. Why owner-role / disposable-PostgreSQL evidence is not enough

The only verification to date ran `24_..._VERIFY.sql` against a throwaway local
PostgreSQL **as the database owner**. That is useful but **cannot** stand in for
hosted verification, because:

- **RLS is bypassed for the table owner.** Every row-level rule in the contract
  (cross-farm isolation, non-disclosure, farmer read-only-when-ready, storage
  object policies) is invisible to an owner session. Only **non-owner principals**
  (`anon`, `authenticated` farmers, a `pending` user, and `ddp_admin` acting
  through PostgREST/Storage) exercise it.
- **Supabase Storage is not local PostgreSQL.** The private bucket, the
  `file_size_limit` ceiling, signed-URL issuance, and the `storage.objects`
  policies only exist and behave correctly on hosted Supabase.
- **`SECURITY DEFINER` search_path, EXECUTE ACLs, and `service_role` grants**
  behave against the real Supabase role set, not a single-owner local role.

**Rule for this runbook:** treat the psql VERIFY run (§4) as the *object/constraint*
layer and the §5 role matrix as the *authorization* layer. **Both** must pass. A
green VERIFY alone is **not** a GO.

---

## 2. Environment boundaries (fail-closed)

| | |
|---|---|
| **Staging project ref** | `szqocdabwkjrggrddocx` |
| **Production project ref** | `iihxjrfxmycjafbtjvvq` — **never touched by this runbook** |
| **Apply surface** | Supabase **dashboard SQL editor** for the target staging project (a role holding `supabase_storage_admin` membership — required by the STORAGE companion) |
| **VERIFY / catalog surface** | `psql "$STAGING_DATABASE_URL"` where the URL contains `szqocdabwkjrggrddocx` |
| **Role-matrix surface** | Real staging Supabase sessions via the app or direct PostgREST/Storage REST, one JWT per principal |

**Before every command, confirm the connection targets staging.** The repo's harness
(`scripts/run-staging-security-tests.mjs`) hard-refuses the production ref and any
unknown ref; mirror that discipline by hand here. If a connection string contains
`iihxjrfxmycjafbtjvvq`, **stop**.

Required environment (same variables the staging harness uses; load from the
gitignored `.env.staging.local`, `set -a; source .env.staging.local; set +a`):

```
STAGING_SUPABASE_URL
STAGING_SUPABASE_ANON_KEY
STAGING_DATABASE_URL              # staging Postgres connection string (psql)
STAGING_ADMIN_EMAIL / _PASSWORD           # ddp_admin principal
STAGING_FARMER_A_EMAIL / _PASSWORD        # farmer A (operational on farm A)
STAGING_FARMER_B_EMAIL / _PASSWORD        # farmer B (operational on farm B)
STAGING_PENDING_EMAIL / _PASSWORD         # optional: a profiles.role='pending' user
```

If `STAGING_PENDING_EMAIL`/`_PASSWORD` are absent, the `pending` row in §5 is
**BLOCK**, not PASS — a pending check that cannot run must **not** be recorded as
satisfied.

---

## 3. Apply order (operator action on staging)

Apply through the Supabase dashboard SQL editor for the **staging** project only.

1. **Pre-apply snapshot / note.** Record the staging DB point-in-time (Supabase
   backup or a noted timestamp) so a failed apply can be reasoned about. Capture the
   `main` commit SHA you are applying from.
2. **Apply HARDENING:** paste and run `24_EVIDENCE_REQUEST_RESOLUTION_HARDENING.sql`
   in full. It is a single `BEGIN … COMMIT`. It must complete without error.
3. **Apply STORAGE:** paste and run `24_EVIDENCE_REQUEST_RESOLUTION_STORAGE.sql` in
   full. Its precondition block will hard-fail if `can_operationally_access_farm`
   is missing (apply order violated) or if the current role lacks
   `supabase_storage_admin` membership. Both failures are self-explanatory; fix and
   re-run — it is idempotent (`ON CONFLICT` converges the bucket to private + 100 MiB).

**Apply order is not optional:** HARDENING **→** STORAGE. The reverse fails the
storage precondition.

**Rollback order (only if you must abandon the apply):** run the storage-companion
rollback block (documented at the foot of `24_..._STORAGE.sql`) **first**, then
`24_EVIDENCE_REQUEST_RESOLUTION_ROLLBACK.sql`. The ROLLBACK **refuses** while any
evidence request/history row exists unless the operator sets
`SET LOCAL evidence.rollback_destructive = 'true';` in the same transaction — that
guard is intentional (contract §6.6). Do not force it to clear real evidence data.

---

## 4. Behavioural VERIFY — object/constraint layer (psql)

Run the committed VERIFY script against staging. It is a single transaction that
ends in `ROLLBACK`, so it **creates no lasting rows** — but it does take locks and
consume sequence values (it builds real fixtures then discards them), so prefer a
low-traffic window.

```bash
# Confirm the target first — must be the staging ref, never production.
case "$STAGING_DATABASE_URL" in
  *iihxjrfxmycjafbtjvvq*) echo "PRODUCTION REF — ABORT"; exit 1 ;;
  *szqocdabwkjrggrddocx*) : ;;
  *) echo "NOT the staging ref — ABORT"; exit 1 ;;
esac

psql "$STAGING_DATABASE_URL" -v ON_ERROR_STOP=1 -f 24_EVIDENCE_REQUEST_RESOLUTION_VERIFY.sql
```

**PASS criterion:** psql exits `0` and every section emits its `VERIFY <X> PASSED`
notice for sections **A through R** (18 sections). Any `VERIFY … FAILED` raises and,
under `ON_ERROR_STOP=1`, aborts with a non-zero exit — that is a **FAIL**.

Section coverage (record each):

| Section | Proves |
|---|---|
| A | All migration-24 objects exist; RLS enabled; RPCs are `SECURITY DEFINER` with pinned `search_path` |
| B | No direct DML grants/policies; `anon` has no access |
| C | Request scope/target/category-matrix/length/immutability/no-delete enforced |
| D | History append-only; submitted responses immutable; single-draft enforced |
| E | `can_operationally_access_farm()` fails closed for anon and NULL |
| F | Migration 21 intact; Buyer Pack untouched (isolation) |
| G | Ready draft attachment removable; history preserved with `attachment_id` nulled |
| H | Manual `attachment_id` nulling refused while attachment exists; FK cleanup allowed |
| I | `removal_requested_at` present; authorized removal completes; linked docs need no storage stage |
| J | Terminal requests no longer strand unsubmitted draft evidence; submitted evidence immutable |
| K | Filename/MIME/category validation enforced |
| L | Draft-ownership handoff transfers authority, preserves provenance & single draft, is audited, frozen at submission |
| M | Extension validated against final MIME; category-valid MIME shifts still rejected |
| N | CoA request accepts a coa document, rejects same-batch non-coa |
| O | request-upload tombstone persists, excluded from active evidence, immutable once set, paths not reused |
| P | Tombstone cleanup survives submission & terminal states; submitted evidence immutable; no new tombstone post-submission |
| Q | Internal helpers deny all client roles incl. `service_role`; policy helper keeps `authenticated`; public RPCs keep intended grants |
| R | Evidence bucket is private with a 100 MiB (104857600-byte) `file_size_limit` |

**This layer runs at service/definer level and does not exercise farmer-vs-farmer
RLS.** It is necessary but not sufficient. Proceed to §5.

---

## 5. Role-matrix verification — authorization layer (non-owner principals)

> **Partially automated.** The **denial** portion of this matrix (anon/pending/farmer
> refusals and the unknown-id non-disclosure entry path) is exercised automatically by
> group **I** of `npm run security:staging` — see §9. Run that first; it is
> zero-residue. The **affirmative** and **fixture-requiring** rows below (a farmer
> *seeing* a real request, a real cross-farm denial, attachments, tombstones,
> signed-read, transfer, terminal state) remain **operator-only** and must be done by
> hand here. A green harness run is necessary, not sufficient, for G2.

Execute each principal as a **real staging session** (app login or direct
PostgREST/Storage REST with that principal's JWT). Fixtures: at least one evidence
request on **farm A** in `open` status, and the ability to reach `farmer_submitted`
and a terminal status for the terminal checks. Tag any fixtures you create so you can
remove them afterward.

**Legend:** ✅ must succeed · ⛔ must be denied · N/A not applicable.
Record each cell as **PASS / FAIL / BLOCK** with the observed result.

| Capability | anon | pending | farmer A (farm A) | farmer B (farm B) | ddp_admin |
|---|:--:|:--:|:--:|:--:|:--:|
| Read any evidence request | ⛔ | ⛔ | ✅ farm A only | ✅ farm B only | ✅ all |
| Create evidence request | ⛔ | ⛔ | ⛔ | ⛔ | ✅ |
| See farm A request by id | ⛔ `NOT_FOUND` | ⛔ `NOT_FOUND` | ✅ | ⛔ **`NOT_FOUND`** (non-disclosure) | ✅ |
| Open/save/submit draft on farm A | ⛔ | ⛔ | ✅ | ⛔ `NOT_FOUND` | ⛔ (admin never submits) |
| Claim/transfer draft ownership | ⛔ | ⛔ | ✅ only if current owner non-operational | ⛔ | ⛔ |
| Reserve/upload attachment | ⛔ | ⛔ | ✅ reserved path only | ⛔ | ⛔ (admin read-only on storage) |
| List/read a **ready** farm-A object | ⛔ | ⛔ | ✅ | ⛔ | ✅ (admin read) |
| Read a **pending (unfinalized)** object | ⛔ | ⛔ | ⛔ (hidden until ready) | ⛔ | ⛔ |
| Remove own draft attachment (tombstone) | ⛔ | ⛔ | ✅ two-phase | ⛔ | ⛔ |
| Resolve / reject / clarify / cancel | ⛔ | ⛔ | ⛔ | ⛔ | ✅ |
| Direct table INSERT/UPDATE/DELETE | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ (RPC-only) |

Non-disclosure detail: a real-but-unauthorized id and a fabricated id must be
**indistinguishable** — both return `NOT_FOUND`, never `FORBIDDEN`, and must not
differ by lock-contention timing (contract §8.4).

---

## 6. Explicit pass/fail criteria (behavioural)

Each block is a required gate. **Any FAIL is a NO-GO** unless an explicit, recorded
waiver is approved (§8).

### 6.1 Request creation and visibility
- **PASS:** `create_evidence_request` succeeds **only** for `ddp_admin`; rejects a
  mismatched `farm_id`, two targets, no target, a `coa` category on a `farm_profile`
  target, and short title/explanation. Created requests are visible to admins and to
  operational farmers **of that farm only**; title/scope are immutable after
  creation; requests cannot be deleted.
- **FAIL:** any non-admin creates a request; any scope/target/matrix/length rule is
  accepted; a farmer sees another farm's request; a request is mutated or deleted.

### 6.2 Cross-farm isolation
- **PASS:** farmer B receives `NOT_FOUND` for every farm-A request id (real or
  fabricated), across read and every RPC; farmer A symmetric for farm B.
- **FAIL:** any foreign-farm request is readable or actionable; `FORBIDDEN` vs
  `NOT_FOUND` leaks existence; a foreign id is distinguishable from a fabricated one.

### 6.3 Draft ownership claim / transfer
- **PASS:** `claim_evidence_response_draft` transfers edit authority **only** when the
  current `draft_owner_user_id` is no longer operational for the farm; an active
  owner's draft returns `CONFLICT`; caller-already-owner returns `INVALID_TRANSITION`;
  a `draft_ownership_transferred` history event records previous/new owner;
  `created_by_user_id` is unchanged; only one draft still exists.
- **FAIL:** an active owner's draft is taken; `created_by_user_id` is rewritten; a
  second draft appears; the transfer is unaudited; a terminal request is claimed.

### 6.4 Attachment upload / list / read / remove
- **PASS:** `reserve_evidence_attachment` requires a draft response on an actionable
  request (`open`/`clarification_requested`) owned by the caller; storage `INSERT`
  succeeds **only** at the exact reserved path while `removal_requested_at IS NULL`;
  `finalize` measures size/MIME/final-extension and sets `ready`; there is **no**
  `UPDATE` path on objects; admins can read but never write; farmers read **ready**
  objects of their farm and never a `pending` one.
- **FAIL:** an object lands at an unreserved path; a pending/unfinalized object is
  readable by any farm member; an object is overwritten in place; an admin writes an
  object; a farmer reads another farm's object.

### 6.5 `removal_requested_at` tombstone behaviour
- **PASS:** the first `remove_draft_evidence_attachment` call sets
  `removal_requested_at` and returns `STORAGE_DELETE_REQUIRED` (never deletes the
  row); the marker is **immutable once set**; the row is **retained as a tombstone**
  and excluded from active evidence, counts, and the aggregate size; a tombstoned
  object is readable/deletable **only** by the current draft owner for cleanup, and
  hidden from other farm members; a spent reservation admits **no** new upload at that
  path.
- **FAIL:** a request-upload row is hard-deleted; the marker is cleared or changed; a
  tombstone counts toward limits or is visible to other members; a new object is
  admitted at a tombstoned path.

### 6.6 Post-submission / terminal-state cleanup semantics
- **PASS:** an existing tombstone's cleanup **survives** the response becoming
  `submitted` and the request reaching a terminal status (the frozen
  `draft_owner_user_id` remains the cleanup principal); a submitted response and its
  attachments are immutable and undeletable; **no new** tombstone can start once the
  response is submitted.
- **FAIL:** submitted evidence is mutated/deleted; a new tombstone starts after
  submission; a terminal request strands unsubmitted draft evidence with no cleanup
  path.

### 6.7 Signed attachment read behaviour
- **PASS:** the bucket is private (`public=false`); an **authorized** principal
  (admin for any object; farmer for a ready object of their farm) can obtain a
  short-lived signed URL that returns the bytes; an **unauthorized** principal
  (other-farm farmer, pending, anon) cannot obtain a usable signed URL for the object.
- **FAIL:** any public URL serves an object; an unauthorized principal reads bytes via
  a signed URL; a signed URL is issued for a pending/unfinalized object to a farm
  member.

### 6.8 Terminal-state restrictions
- **PASS:** `resolved`, `rejected`, `cancelled` are terminal — no reopen, no new
  draft, no submit, no clarification; only the tombstone-cleanup exception (§6.6) may
  still act.
- **FAIL:** any terminal request is reopened or accepts a draft/submit/transition
  other than the documented cleanup exception.

### 6.9 Audit-integrity (actor attribution) — in-scope portion
- **PASS:** every `evidence_request_history` row written by the RPCs carries
  `actor_user_id = auth.uid()` (server-forced inside `SECURITY DEFINER`), never a
  caller-supplied actor; history is append-only (no UPDATE/DELETE).
- **FAIL:** any history actor is caller-controlled; any history row is mutable.
- **Note:** the broader compliance-audit-log actor-attribution item is **migration 25
  (Watchtower)** and is **out of scope** here (release checklist G3).

---

## 7. Runtime-status update template (record the result)

On completion, append an entry to `docs/MIGRATION_RUNTIME_STATUS.md` and update the
migration-24 row of its status matrix. Use the register's vocabulary
(`APPLIED_AND_VERIFIED` / `APPLIED_NOT_VERIFIED` / `PARTIALLY_APPLIED` / `NOT_APPLIED`
/ `BLOCKED` / `UNKNOWN`). Copy and fill:

```md
### Migration 24 — hosted staging verification record

| Field | Value |
|---|---|
| Operator | <name / handle> |
| Date/time (UTC) | <YYYY-MM-DDTHH:MM:SSZ> |
| Target environment | Staging (`szqocdabwkjrggrddocx`) |
| Applied-from commit SHA | <main SHA at apply time> |
| Migration files applied | 24_..._HARDENING.sql; 24_..._STORAGE.sql (order: HARDENING → STORAGE) |
| VERIFY result (§4) | <A–R all PASSED = pass | else list failing sections> |
| Role matrix result (§5) | <PASS / FAIL / BLOCK per principal; note any BLOCK, e.g. pending absent> |
| Behavioural gates (§6.1–6.9) | <per-gate PASS/FAIL> |
| Signed-read check (§6.7) | <authorized reads bytes; unauthorized denied — pass/fail> |
| Storage residue after run | <objects created/removed; any orphan> |
| Resulting staging status | <APPLIED_AND_VERIFIED | APPLIED_NOT_VERIFIED | PARTIALLY_APPLIED> |
| Unresolved failures / waivers | <none | list with waiver approver + rationale> |
| Evidence links | <psql VERIFY log; role-matrix log; dashboard apply screenshot/note> |
```

Do **not** record `APPLIED_AND_VERIFIED` unless §4 passed **and** §5 ran under real
non-owner principals with no unwaived FAIL and no unresolved BLOCK. If the pending
principal was unavailable, the strongest honest status is `APPLIED_NOT_VERIFIED` with
the pending gap named explicitly.

Also update, minimally:
- `docs/EVIDENCE_RELEASE_READINESS_CHECKLIST.md` → **G2** decision and the two
  "Staging migration 24 …" evidence links.

---

## 8. GO / NO-GO — may application-layer integration proceed?

Application-layer integration from `feature/evidence-request-workflow-v2`
(commit `4fb72f7`) **may proceed only on a GO**.

**GO requires all of:**
1. §3 apply completed on staging with no error.
2. §4 VERIFY: sections **A–R all PASSED** via psql against the staging ref.
3. §5 role matrix executed under **real non-owner principals**; every ⛔ denied and
   every ✅ allowed; no unresolved **BLOCK** (a missing `pending` principal is a BLOCK,
   not a pass).
4. §6.1–6.9 behavioural gates all PASS (or any FAIL covered by a recorded, approved
   waiver naming approver and rationale).
5. §6.7 signed-read verified for both an authorized and an unauthorized principal.
6. §7 runtime-status record written; staging status is `APPLIED_AND_VERIFIED`.

**NO-GO if any of the above is unmet.** On NO-GO, do not integrate the application
layer; file the specific failing gate(s) and remediate on the SQL side (a fix is a
new migration 25-family patch *for that defect only* — not an edit to merged
migration 24, per contract §6.8).

**Decision record:**

```md
- Decision date:
- Operator / release owner:
- Staging commit SHA verified:
- VERIFY A–R:            PASS / FAIL
- Role matrix (§5):      PASS / FAIL / BLOCK
- Behavioural gates:     PASS / FAIL (list any waiver)
- Signed-read (§6.7):    PASS / FAIL
- Runtime status set to: APPLIED_AND_VERIFIED / APPLIED_NOT_VERIFIED / ...
- DECISION:              GO / NO-GO for application-layer integration
- Notes:
```

**Scope reminder:** a GO authorizes **staging application-layer integration only**.
It does **not** authorize production apply or production rollout — those remain gated
by checklist **G4/G6** and are out of scope for this runbook.

---

## 9. Automated harness support (group I) — supports G2, does not complete it

`npm run security:staging` (`scripts/run-staging-security-tests.mjs`) now includes
group **`I. evidence request & resolution (migration 24)`**. It automates the parts
of this runbook that can be exercised **safely and without leaving residue**, and
explicitly defers the rest to the manual role matrix in §5. Run it after §3 apply to
get a fast, repeatable pass over the denial surface; it does **not** replace §4–§8.

### 9.1 What group I proves automatically (zero-residue)

Gated behind a **substrate preflight** (read-only catalog check via
`STAGING_DATABASE_URL`): if migration 24 is not fully present — all four tables with
RLS, all 14 RPCs, the private 100 MiB bucket, and the five storage policies — every
evidence probe is **BLOCK** (never a false pass), mirroring the pending-matrix gate.

When the substrate is present, it asserts, under **real non-owner principals**:

- **anon** cannot `SELECT` any evidence table (no grant) and cannot `EXECUTE` the
  evidence RPCs.
- **pending** (gated exactly like group H — absent creds or an unproven-`pending`
  role → BLOCK) is refused by `create`, `get_or_create`, `reserve`, and `claim`.
- **farmer A** cannot create a request (admin-only), and every workflow RPC
  (`get_or_create` / `submit` / `reserve` / `claim`) **fails closed on an unknown
  request id**; **farmer B** likewise. This exercises the non-disclosure entry path.

Every probe is a call the database must reject, and each rejection happens **before
any row is written** (anon has no grant; `create_evidence_request` checks
`is_ddp_admin()` before its `INSERT`; the other RPCs lock a visible request first, so
a fabricated id raises `NOT_FOUND` first). The group ends with a zero-residue
assertion (admin read-back for any tag-titled request). **No evidence rows are
created** — deliberately, because migration-24 rows are non-deletable by contract.

### 9.2 What remains operator-only (recorded as SKIP)

These require a **persistent, non-deletable** evidence fixture (or state the harness
must not create), so they are **not** automated and appear as `SKIP` with a pointer
to the section here that covers them manually:

- affirmative own-farm request visibility (§6.1) and **real** cross-farm
  non-disclosure of a live request id (§6.2) — the *fabricated-id* case is automated;
  the *real-but-unauthorized* case is not;
- draft ownership claim/transfer (§6.3);
- attachment reserve/finalize/list/read/remove lifecycle (§6.4);
- `removal_requested_at` tombstone behaviour (§6.5);
- post-submission / terminal-state cleanup (§6.6);
- signed-read authorization on a real object (§6.7);
- terminal-state restriction on a real request (§6.8).

### 9.3 How to read group I for the G2 decision

- **BLOCK** in group I ⇒ migration 24 is not (fully) applied to the target, or the
  DB-URL/pending principal is unavailable → **G2 not yet runnable**; fix the substrate
  or credentials.
- **All group-I probes PASS** ⇒ the denial surface holds. This is **necessary but not
  sufficient** for G2. The `SKIP` rows are the exact checks a human must still perform
  via §5–§6. **A green `security:staging` is not a G2 GO** until those SKIPs are
  covered manually and recorded in §7.
- Environment: group I reuses the harness's existing variables — `STAGING_DATABASE_URL`
  (substrate preflight), the admin / farmer A / farmer B credentials, and the optional
  `STAGING_PENDING_*` (absent → the pending sub-probes BLOCK). **No new secret is
  introduced.**

Offline drift guard: `scripts/evidence-staging-harness.test.mjs` fails if the group's
table/RPC/bucket/policy ground truth drifts from the merged migration-24 SQL, so the
automated surface cannot silently fall out of step with the schema.
