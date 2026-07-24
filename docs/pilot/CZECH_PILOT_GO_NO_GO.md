# Czech Pilot — Go / No-Go

**Date:** 2026-07-24 · **Decision owner:** DDP Operator (Controller)

## Current decision: 🔴 NO-GO for first REAL farm — but one narrow, one-line blocker from GO

**Why (updated 2026-07-24, staging pass #3 — final gate closure):** SG-1, SG-2, SG-4, SG-5 all **PASS with hard staging evidence** and SG-6 is code-verified. The **only** thing keeping this from GO is **SG-3**: the `farmer-documents` storage bucket on staging has **no server-side type/size enforcement** (`allowed_mime_types` and `file_size_limit` are null), so a non-PDF uploads successfully at the API level (HTTP 200). Client-side validation still rejects it and RLS still confines each farmer to their own prefix, so this is a **P2 defense-in-depth gap, not a tenant hole** — but it fails SG-3's server-side failure-path check. **One-line fix** applies migration 8's bucket config; after that + a live SG-6 export check, this flips to **GO**.

---

## Gate board

| Gate | Status | Evidence / blocker |
|------|--------|--------------------|
| A. Local CI (tests/type/lint/build) | ✅ PASS | `ci:verify` exit 0 — 1740 tests, security:sql, tsc, lint, build |
| SG-1 Access control (RLS, admin-only status) | ✅ PASS | `security:staging` **111 PASS · 0 FAIL · 0 BLOCK** (pending matrix SATISFIED, 58/58) + psql verify 19 (8 passed), 21 (3), 22 (8), all exit 0. Proven live on `szqocdabwkjrggrddocx`: farmer A can't read/update/delete farmer B farms or storage prefix; farmer can't set status/compliance_status/risk_level/partner_tier on own farm; farmer can't self-elevate to ddp_admin (SQLSTATE 42501) |
| SG-2 Audit trail | ✅ PASS | Within the 111: admin can INSERT `compliance_audit_log` (append-only, retained) but admin UPDATE and DELETE of that row are **blocked**; authenticated farmer and anon **cannot** INSERT; catalog VERIFY 11 (truncate hardening) passed |
| SG-3 Upload smoke (happy+fail) | 🔴 FAIL (P2) | **Happy path PASS:** Farmer-A PDF upload HTTP 200, signed-URL retrieval HTTP 200, RLS confines to own prefix. **Failure path FAIL:** non-PDF upload accepted (HTTP 200) — bucket `farmer-documents` has `allowed_mime_types=null`, `file_size_limit=null`; server does not enforce PDF-only/10MB (client-only). Fix: `update storage.buckets set file_size_limit=10485760, allowed_mime_types=array['application/pdf'] where id='farmer-documents';` (migration 8) |
| SG-4 Backup/restore drill | ✅ PASS | `pg_dump` of `public.farms` (exit 0, valid 143-line dump); restore rehearsed into throwaway `_restore_drill` schema — table + 5 RLS policies + trigger recreated, row parity (0=0), scratch schema dropped & verified gone. Caveat: `farms` had 0 live rows at drill time (structure/policy restore fully exercised; data-parity trivial) |
| SG-5 Incident mini-runbook | ✅ PASS | Tabletop **exercised** 2026-07-24 (not just read) — walked the "status shows success but didn't persist" scenario end-to-end through the runbook to the HF-003 fix; record appended to `CZECH_PILOT_INCIDENT_RUNBOOK.md` |
| SG-6 Human-approval fail-closed (export) | 🟢 CODE-VERIFIED | `canEmitBuyerPackOutput` + print-CSS fail-closed + server-authoritative issuance (migration 23) confirmed in code. Not exercised via live UI this run — recommend one live export click-through before real farms |

Legend: ✅ passed (live evidence) · 🟢 code-verified · ⏸ not run · 🔴 fail

## What flipped GREEN this pass
- Local CI fully green (A-suite).
- 2 hotfix branches ready (HF-001 evidence-upload reliability; HF-003 silent-failure on farm-submit + status actions) — both test-green, awaiting merge authorization.
- Security-critical gates (export approval gate, farmer-cannot-self-approve, COA storage RLS) **static-verified sound** by targeted review — no gate bypass found.

## Path to GO (ordered)
1. ✅ DONE — staging DB connected; creds file present. Migration-apply confirmed via psql (SG-1 structural PASS).
2. **Provision 3 test users IN THE STAGING PROJECT** `szqocdabwkjrggrddocx` (Authentication → Users): 1 admin + 2 farmers, emails **confirmed**, passwords matching `.env.staging`; set `profiles.role` = `ddp_admin` / `farmer` / `farmer`; each farmer owns ≥1 farm (so cross-tenant isolation is testable). Then re-run `security:staging` → SG-1 auth + SG-2.
3. Bring up the staging app → run manual smoke C1–C4 (SG-3, SG-6 live).
4. Run backup + restore rehearsal (SG-4); write + dry-run incident runbook (SG-5).
5. Authorize merge of HF-001 + HF-003.
6. Re-evaluate → GO when SG-1…SG-6 all PASS.

## Honest ETA to first real farm
- **Engineering readiness:** ~1 hour of merges + smoke once staging is connected.
- **Gate verification:** ~2–3 hours with staging creds (dominated by SG-1/SG-2 + backup/restore drill).
- **Hard external dependency:** real partner accounts provisioned on the pilot DB + a real farm's documents in hand. Not controllable from code.
- **Earliest honest GO:** same-day **only if** staging creds + applied migrations are confirmed this session and real farm data is ready; otherwise next working session.
