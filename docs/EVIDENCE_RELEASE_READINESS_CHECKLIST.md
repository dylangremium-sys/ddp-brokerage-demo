# Evidence Request & Resolution Release Readiness Checklist

Status: Draft operational gate
Last updated: 2026-07-24
Scope: Evidence Request & Resolution feature release controls (staging and production)

## 1) Purpose

This checklist converts audit findings into explicit release gates.

The release is blocked unless every required gate below is PASS.

Policy: DB-first release for Evidence workflow.
- Database migration and hosted behavioral verification must be complete before Evidence application UI/routes are merged to main.

## 2) Gate Summary

| Gate | Name | Required to proceed? |
|---|---|---|
| G0 | Control-plane baseline hygiene | Yes |
| G1 | Binding contract reconciliation | Yes |
| G2 | Migration 24 staging apply + hosted verification | Yes |
| G3 | Migration 25 staging apply + audit-integrity verification | Yes |
| G4 | CI schema-readiness deployment guard | Yes |
| G5 | Evidence application-layer completeness | Yes |
| G6 | Production rollout authorization | Yes |

Any FAIL at any gate is a full stop.

## 3) Detailed Gates

## G0 - Control-plane baseline hygiene

Owner: Repo maintainers

PASS criteria:
- docs/MASTER_DEVELOPMENT_ROADMAP.md reflects current merged state (including migration 24 merged status and actual implementation boundary).
- docs/MIGRATION_RUNTIME_STATUS.md has current runtime state for staging and production for migrations 19-25 (UNKNOWN allowed only where explicitly unverified and dated).
- Superseded/open historical PRs and issues are triaged (closed, superseded, or relabeled) so future agents do not treat stale work as active.

Required evidence artifact(s):
- PR updating roadmap and runtime status.
- Audit note listing triaged stale PRs/issues.

FAIL conditions:
- Roadmap still claims migration 24 is only on draft PR.
- Runtime status does not explicitly record migration 24 and 25 state by environment.

Decision:
- PASS / FAIL

## G1 - Binding contract reconciliation

Owner: Product + engineering owner

PASS criteria:
- A single repository-visible binding contract exists and is marked current.
- Contract matches merged migration behavior, including:
  - draft_owner_user_id semantics
  - draft ownership claim/transfer flow
  - removal_requested_at durable tombstones
  - post-submission terminal-state cleanup semantics
  - storage size ceiling behavior
  - authoritative VERIFY acceptance criteria
- Contract version is referenced by roadmap and implementation tickets.

Required evidence artifact(s):
- Contract file committed in docs/ (current version marker and change log).
- Cross-reference update in docs/MASTER_DEVELOPMENT_ROADMAP.md.

FAIL conditions:
- Multiple conflicting contract versions are in active use.
- UI implementation tasks are still scoped against v1.0 while database behavior reflects amended model.

Decision:
- PASS / FAIL

## G2 - Migration 24 staging apply + hosted verification

Owner: Database operator + security reviewer

PASS criteria:
- Migration 24 applied to hosted staging.
- Hosted VERIFY and behavioral checks pass for non-owner principals.
- Required role matrix tested on staging: ddp_admin, farmer A, farmer B, pending, anon.
- Cross-farm request isolation enforced.
- Storage policy behavior enforced for Evidence objects (read/write/list/delete rules per role).
- Signed attachment read behavior validated for authorized and unauthorized principals.
- Runtime status updated with timestamp, operator, and evidence links.

Procedure: execute `docs/EVIDENCE_MIGRATION_24_STAGING_VERIFICATION_RUNBOOK.md` — it operationalizes this gate (apply order, VERIFY A–R, non-owner role matrix, pass/fail criteria, runtime-status template, and the GO/NO-GO for application-layer integration).

Partial automation: `npm run security:staging` group **I** automates the zero-residue **denial** surface (anon/pending/farmer refusals; unknown-id non-disclosure) under real non-owner principals, and BLOCKs if migration 24 is not fully present on the target. It is **necessary but not sufficient** for G2 — the affirmative/fixture-requiring behavioural checks (runbook §5–§6, recorded there as SKIP) remain operator-only. A green harness run alone is not a G2 PASS.

Required evidence artifact(s):
- Staging apply record (exact migration files and commit SHA).
- Hosted verification report with pass/fail per scenario.
- Updated docs/MIGRATION_RUNTIME_STATUS.md entry for migration 24.

FAIL conditions:
- Verification only performed on disposable PostgreSQL.
- Verification executed only as PostgreSQL owner role.
- Any role-matrix scenario missing or failing without approved waiver.

Decision:
- PASS / FAIL

## G3 - Migration 25 staging apply + audit-integrity verification

Owner: Database operator + security reviewer

PASS criteria:
- Migration 25 applied to hosted staging.
- Audit log actor attribution is server-forced (actor_id derived from auth.uid()) and cannot be caller-spoofed.
- Regression checks pass for migration replay safety, search_path hardening, rollback safety switches, and other migration-25 hardening items.
- Runtime status updated with explicit staging result.

Required evidence artifact(s):
- Staging apply record for migration 25.
- Security test evidence demonstrating actor spoofing prevention.
- Updated docs/MIGRATION_RUNTIME_STATUS.md entry for migration 25.

FAIL conditions:
- actor_id remains caller-controlled in any audited path.
- Migration 25 merged without hosted staging verification evidence.

Decision:
- PASS / FAIL

## G4 - CI schema-readiness deployment guard

Owner: CI/deployment owner

Implemented by (design + code, this repo):
- `scripts/check-evidence-schema-readiness.mjs` (`npm run security:evidence-readiness`) — fail-closed, SELECT-only structural readiness check; verdicts READY / NOT_READY / UNABLE_TO_DETERMINE (both non-READY states block).
- `.github/workflows/security-ci.yml` → `deploy-production` step "G4 evidence schema-readiness gate (blocking)", before build/deploy.
- `docs/DEPLOYMENT_RUNBOOK.md` §8 — behaviour, required secret/variable, break-glass, and the explicit "what it does NOT prove" boundary.

PASS criteria:
- CI includes a pre-deploy schema-readiness gate for Evidence app rollout. **(Implemented.)**
- Gate fails when required migration-24 objects are missing in target environment. **(Implemented; verdict NOT_READY, exit 1.)**
- Production deploy job cannot proceed when schema-readiness gate fails. **(Implemented; step precedes the Vercel deploy step and a non-zero exit fails the job.)**
- Gate is conditional on Evidence app-layer code being present in the deployed `src/` tree (auditable token set), and blocks on UNABLE_TO_DETERMINE (missing credential, unreachable DB, partial/ambiguous result).
- Guard is deterministic and documented in docs/DEPLOYMENT_RUNBOOK.md. **(§8.)**
- `EVIDENCE_SCHEMA_CHECK_DATABASE_URL` (read-only) is provisioned as a `Production` environment secret, **and** `EVIDENCE_SCHEMA_CHECK_EXPECTED_REF` (target project ref) is set as a variable, **before** Evidence app-layer code merges to `main`. With the app layer present, a missing DB URL **or** a missing/mismatched expected-ref makes the gate return `UNABLE_TO_DETERMINE` and blocks the deploy.

Not proven by this gate (belongs to G2, not G4):
- That RLS/triggers/storage policies actually ENFORCE at runtime under non-owner principals. G4 proves object presence and shape only. A green G4 is not hosted behavioural verification.

Required evidence artifact(s):
- Workflow change PR with failing and passing proof runs. (Local proof captured: NOT_APPLICABLE→0, READY→0, NOT_READY→1, UNABLE→2 against a synthetic catalog + fail-closed on missing credential/unreachable DB.)
- Runbook update describing gate behavior and break-glass handling. **(docs/DEPLOYMENT_RUNBOOK.md §8.)**
- `Production` environment secret `EVIDENCE_SCHEMA_CHECK_DATABASE_URL` provisioned (evidence: secret exists; value never recorded here).

FAIL conditions:
- Evidence UI can deploy with green CI while target DB lacks migration-24 objects.
- Schema-readiness check is advisory only and does not block deployment.
- Evidence app-layer code is present on `main` but the `Production` DB secret is absent (gate would return UNABLE and block — provision the secret rather than removing the gate).

Decision:
- PASS / FAIL

## G5 - Evidence application-layer completeness

Owner: Application engineering owner

PASS criteria:
- Evidence TypeScript service and shared types implemented against reconciled contract.
- Admin request list and create/review flows implemented.
- Farmer evidence detail and response flows implemented.
- Operations Desk integration completed.
- Farm Review and Inventory Review actions include Request Evidence path.
- Authenticated browser end-to-end checks pass, including account-switch tests.

Required evidence artifact(s):
- Merged PR set with feature scope mapping to contract sections.
- Test evidence: unit/integration + browser workflow pass report.

FAIL conditions:
- Database layer present but required application flows absent.
- Feature shipped without account-switch and cross-farm isolation browser evidence.

Decision:
- PASS / FAIL

## G6 - Production rollout authorization

Owner: Release owner

PASS criteria:
- G0 through G5 are PASS with linked evidence.
- Production migration plan approved (forward + rollback + stop conditions).
- Production apply and post-apply verification completed.
- Deployment proceeds through authorized CI path only.

Required evidence artifact(s):
- Go-live sign-off note with links to all gate evidence.
- Production runtime status entry (migration 24 and 25) with timestamp.

FAIL conditions:
- Any prior gate unresolved.
- Missing production post-apply verification record.

Decision:
- PASS / FAIL

## 4) Release Decision Record

Use this block at the moment of release decision.

- Decision date:
- Release owner:
- Target commit SHA:
- Environment:
- Gate outcomes: G0 [ ], G1 [ ], G2 [ ], G3 [ ], G4 [ ], G5 [ ], G6 [ ]
- Final decision: GO / NO-GO
- Notes:

## 5) Minimum Evidence Links (must be populated)

- Current binding contract file: `docs/EVIDENCE_REQUEST_RESOLUTION_CONTRACT.md` (v1.5, current/binding — added 2026-07-24)
- Staging migration 24 verification runbook: `docs/EVIDENCE_MIGRATION_24_STAGING_VERIFICATION_RUNBOOK.md`
- Staging migration 24 apply evidence:
- Staging migration 24 hosted verification evidence:
- Staging migration 25 apply evidence:
- Staging migration 25 verification evidence:
- CI schema-readiness gate workflow evidence:
- App-layer test evidence:
- Production apply + verification evidence:
- Updated runtime status file entry:
