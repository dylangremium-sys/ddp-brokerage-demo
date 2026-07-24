# Czech Pilot — Go / No-Go

**Date:** 2026-07-24 · **Decision owner:** DDP Operator (Controller)

## Current decision: 🔴 NO-GO for first REAL farm today

**Why:** The live/staging Supabase environment is still not connected — as of the 2026-07-24 verification pass, all 9 `STAGING_*` env vars are UNSET and no `.env.staging` exists — so SG-1, SG-2, SG-3(live), SG-4 and SG-6(live) cannot be marked PASS. Code is in good shape; the gap is **verification against a real DB**, not known defects. No gate will be marked PASS on unverified evidence.

---

## Gate board

| Gate | Status | Evidence / blocker |
|------|--------|--------------------|
| A. Local CI (tests/type/lint/build) | ✅ PASS | `ci:verify` exit 0 — 1740 tests, security:sql, tsc, lint, build |
| SG-1 Access control (RLS, admin-only status) | ⏸ NOT RUN | Needs `npm run security:staging` + staging creds. **Static-verified:** RLS/trigger guards exist in migrations 19/20/22 + INVENTORY_BATCHES patches; must confirm they are **applied** to the pilot DB |
| SG-2 Audit trail | ⏸ NOT RUN | Same runner (group F psql facts + audit-insert probe). Status-history + `compliance_audit_log` writes exist in code |
| SG-3 Upload smoke (happy+fail) | ⏸ NOT RUN | Needs staging app; HF-001 improves reliability. Static: PDF-only + size guards + throw/catch present. Onboarding **required-field floor added** (FarmerOnboarding.tsx, uncommitted) — blocks empty submit; tsc+1740 tests green |
| SG-4 Backup/restore drill | ⏸ NOT RUN | Needs staging DB; run `RESET_A` counts + snapshot + rehearse restore |
| SG-5 Incident mini-runbook | 🟢 ARTIFACT PRESENT | `CZECH_PILOT_INCIDENT_RUNBOOK.md` present + operator-usable (severity/triggers/containment/diagnosis/recovery/comms/resolution). Dry-run walkthrough still pending |
| SG-6 Human-approval fail-closed (export) | 🟢 STATIC-VERIFIED | `canEmitBuyerPackOutput` + print-CSS fail-closed + server-authoritative issuance (migration 23) confirmed in code; confirm live once app is up |

Legend: ✅ passed · 🟢 static-verified (code) · ⏸ not run (needs env) · 🔴 fail

## What flipped GREEN this pass
- Local CI fully green (A-suite).
- 2 hotfix branches ready (HF-001 evidence-upload reliability; HF-003 silent-failure on farm-submit + status actions) — both test-green, awaiting merge authorization.
- Security-critical gates (export approval gate, farmer-cannot-self-approve, COA storage RLS) **static-verified sound** by targeted review — no gate bypass found.

## Path to GO (ordered)
1. **You provide staging creds** (see `CZECH_PILOT_SMOKE_SUITE.md` §B env list) → I run `security:staging` (SG-1, SG-2).
2. **Confirm migrations 19/20/22 + RLS patches are APPLIED** to the pilot DB (they are manual-apply). If not applied → SG-1 FAILS regardless of code.
3. Bring up the staging app → run manual smoke C1–C4 (SG-3, SG-6 live).
4. Run backup + restore rehearsal (SG-4); write + dry-run incident runbook (SG-5).
5. Authorize merge of HF-001 + HF-003.
6. Re-evaluate → GO when SG-1…SG-6 all PASS.

## Honest ETA to first real farm
- **Engineering readiness:** ~1 hour of merges + smoke once staging is connected.
- **Gate verification:** ~2–3 hours with staging creds (dominated by SG-1/SG-2 + backup/restore drill).
- **Hard external dependency:** real partner accounts provisioned on the pilot DB + a real farm's documents in hand. Not controllable from code.
- **Earliest honest GO:** same-day **only if** staging creds + applied migrations are confirmed this session and real farm data is ready; otherwise next working session.
