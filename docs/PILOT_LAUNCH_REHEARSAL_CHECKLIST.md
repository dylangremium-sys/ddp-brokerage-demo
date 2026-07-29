# Pilot Launch Rehearsal Checklist

Last updated: 2026-07-25

Objective: run one end-to-end controlled rehearsal against the same environment
intended for pilot use, using disposable records only.

## Preconditions

1. `origin/main` commit selected and recorded.
2. Migration runtime register updated for target environment.
3. Read-only verification bundle executed for target environment.
4. Backup and restore validation completed for target environment.

## Evidence capture requirements

For each step below, capture:

- UTC timestamp,
- actor identity (admin/farmer/buyer/system),
- input used,
- observed output,
- pass/fail decision.

Store artifacts under `evidence/<date>/pilot-rehearsal/`.

## Workflow A: Farmer onboarding and submission

1. Admin creates farmer account invitation.
2. Farmer authenticates successfully.
3. Farmer profile is created and remains non-operational until approval.
4. Farmer submits farm profile data.
5. Farmer submits inventory batch.
6. Farmer uploads required evidence documents.

Pass criteria:

- only invited farmer can access farmer scope,
- pending state is enforced before approval,
- all writes are attributed to correct farmer context.

## Workflow B: DDP review and controls

1. Admin reviews farm profile and inventory submission.
2. Admin requests additional evidence.
3. Farmer resolves evidence request.
4. Admin approves inventory.
5. Risk/compliance evaluation surface is generated.

Pass criteria:

- unauthorized user cannot approve/reject admin workflows,
- evidence-request lifecycle is auditable,
- approval transition is explicit and attributable.

## Workflow C: Buyer pack issuance path

1. Admin records procurement decision.
2. System attempts Buyer Pack issuance.
3. Immutable snapshot is created.
4. Buyer preview/download path works.

Pass criteria:

- pack issuance blocked without valid procurement decision,
- snapshot mutation attempts are denied,
- issuance event has complete audit trail.

## Workflow D: Watchtower ingestion path

1. Admin triggers source ingestion from an official source.
2. System normalizes input and deduplicates candidates.
3. Candidate legal update is created with provenance.
4. Human review queue receives candidate in `new` state.
5. Rule approval path links to affected assets and alerts.

Pass criteria:

- ingestion failures are explicit, not silent,
- candidate provenance is complete and queryable,
- no autonomous AI enforcement bypasses human approval.

## Boundary attack tests (mandatory)

1. Pending farmer attempts direct access to restricted records.
2. Farmer attempts cross-tenant/cross-farm record access.
3. Farmer attempts admin-only field mutation.
4. Admin attempts forged compliance audit actor identifier.
5. Buyer pack issuance attempted with malformed approval evidence.
6. Unauthenticated provisioning call attempted.
7. App boot attempted with missing required Supabase env config.

Pass criteria:

- all attacks fail closed,
- each failure path is logged/auditable,
- no unauthorized state mutation occurs.

## Stop conditions

Stop rehearsal and declare `NO-GO` if any occur:

1. RLS/policy failure on protected tables,
2. missing audit trail entries for critical transitions,
3. buyer pack snapshot mutation permitted,
4. silent Watchtower failure,
5. unresolved production parity unknowns.

## Rehearsal completion template

```text
Rehearsal date:
Target environment:
Commit SHA:
Migration register version:
Read-only verification bundle artifact:

Workflow A: PASS/FAIL
Workflow B: PASS/FAIL
Workflow C: PASS/FAIL
Workflow D: PASS/FAIL
Boundary tests: PASS/FAIL

Final rehearsal decision: GO/NO-GO
Blocking defects:
Owner:
```
