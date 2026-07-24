# Czech Pilot — Incident Mini-Runbook

## Purpose
Provide a fast, repeatable response path for pilot-critical incidents affecting Czech farm onboarding and compliance reporting.

## Scope
This runbook applies only to the four Czech pilot flows:
1. Farm profile creation
2. Evidence upload
3. Compliance status review
4. Client report export

## Roles
- Incident Owner: DDP Operator (Controller)
- Onboarding Ops: Partner 1
- Compliance QA: Partner 2

## Severity Matrix
- P0: Launch blocked or data integrity risk in pilot flows.
- P1: Major degradation with workaround.
- P2: Minor issue with low immediate launch impact.

## Trigger Conditions
Start this runbook immediately when any of these occur:
- Submit action reports success but write did not persist.
- Evidence upload fails repeatedly for valid files.
- Compliance status change is visible in UI but not in storage.
- Export fails or generates inconsistent farm status output.
- Access-control anomaly (wrong role can view or mutate pilot data).

## Immediate Response (first 15 minutes)
1. Declare incident in ops channel with severity and impacted flow.
2. Freeze risky operator actions for impacted flow only.
3. Capture evidence:
- timestamp (UTC)
- operator account
- farm id or inventory id
- exact UI step and action
- error message or console output
4. Assign owner and scribe.

## Containment
1. If write integrity is uncertain, stop new writes on the affected flow.
2. Use known-good last state in dashboard/reporting (do not fabricate data).
3. Route partner actions to unaffected flows while fix is prepared.

## Diagnosis Checklist
1. Confirm role and account context (ddp_admin, farmer, pending).
2. Reproduce with one deterministic test record.
3. Check client-side validation path and submit gate.
4. Check persistence call success/failure handling.
5. Check audit/log trail for action and result.
6. Confirm whether issue is code defect, environment config, or data anomaly.

## Recovery
1. Apply minimal hotfix scoped to the failing pilot flow.
2. Run targeted validation:
- happy path pass
- failure path pass
- no false-success UI state
3. Re-run pilot smoke checks for impacted flow.
4. Restore partner operations and monitor for 30 minutes.

## Communication Template
- Incident ID:
- Severity:
- Impacted flow:
- Start time (UTC):
- Current status: Investigating | Contained | Recovering | Resolved
- Operator guidance now:
- Next update ETA:

## Resolution Criteria
All must be true:
1. Root cause identified and documented.
2. Hotfix validated on impacted flow.
3. No false-success path remains.
4. Smoke checks pass for impacted flow.
5. Hotfix logged in CZECH_PILOT_HOTFIX_LOG.md.

## Post-Incident (within 24 hours)
1. Add timeline and root-cause note to CZECH_PILOT_HOTFIX_LOG.md.
2. Update CZECH_PILOT_GO_NO_GO.md gate status if affected.
3. Add one preventive check to the smoke suite.
