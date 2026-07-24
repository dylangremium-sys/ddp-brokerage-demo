# Czech Pilot — Go / No-Go

**Date:** 2026-07-24 · **Decision owner:** DDP Operator (Controller)

## Current decision: 🔴 NO-GO for first REAL farm today

**Why (updated 2026-07-24, staging pass #2):** Staging DB is now connected and the **hardening migrations are verified APPLIED and PASSING** (19/21/22 verify scripts — see evidence below). However the **staging auth test users do not authenticate** (admin + both farmers return `invalid_credentials` on `szqocdabwkjrggrddocx`), so `security:staging` refused and the **runtime** access-control (SG-1 auth-level), audit (SG-2), and live smoke (SG-3/SG-6) could not run. Blocker is now **staging test-user provisioning**, not code and not migration-apply.

---

## Gate board

| Gate | Status | Evidence / blocker |
|------|--------|--------------------|
| A. Local CI (tests/type/lint/build) | ✅ PASS | `ci:verify` exit 0 — 1740 tests, security:sql, tsc, lint, build |
| SG-1 Access control (RLS, admin-only status) | 🟡 DB-LEVEL PASS / auth NOT RUN | **PASS (structural):** staging psql verify 19 (B3–B7), 21 (A–C), 22 (A–G) all PASSED on `szqocdabwkjrggrddocx` — RLS applied, farmer can't write admin fields / non-member farms, storage policy guards read+write, pending denied. **NOT RUN (runtime):** farmer-A-can't-read-farmer-B cross-tenant test blocked — staging test users don't authenticate |
| SG-2 Audit trail | ⏸ NOT RUN | `security:staging` refused before the audit-insert probe (needs a staging login). Status-history + `compliance_audit_log` writes exist in code |
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
