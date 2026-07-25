# DDP Release Checklist (vendor-neutral)

Copy this file per release into `docs/releases/` and fill it in. It deliberately
separates **platform-enforced** gates — the ones a merge is mechanically blocked
on — from **process-enforced** gates, which the repository does not enforce and
which therefore depend entirely on operator discipline.

That distinction matters: a green platform gate does not mean the release is
safe, and a failing process gate will not stop anyone. Know which kind you are
looking at before you act on it.

    Release ID:
    Date (UTC):
    Operator:
    Target branch:
    Target commit SHA:

## A) Platform-enforced gates (mechanical merge requirements)

1. Required status checks are complete and passing.
2. Branch is up to date with the target base branch.
3. Merge method matches team policy (squash / merge / rebase).
4. No merge conflicts.
5. If any required platform gate is red or pending: **STOP (NO-MERGE)**.

    Platform gates status: PASS / FAIL
    Blocker details:

## B) Process-enforced security gates (hardening discipline)

1. No schema or policy drift in this release:
   - no SQL migration changes
   - no authorization policy changes
   - no privilege model changes
2. Signup/request payload cannot set role or elevation fields.
3. Pending users remain fail-closed from operational dashboards.
4. Inventory visibility and approval gates are unchanged.
5. Security-sensitive routes and role-routing behaviour unchanged.
6. Secrets and dump artifacts are not included in the diff.
7. Any unknown is treated as **FAIL**.
8. Any failure: **STOP (NO-MERGE)**.

    Process gates status: PASS / FAIL
    Blocker details:

## C) Quality and stability gates (process decision, not security)

1. Static analysis disposition: pass, or explicit documented waiver with owner,
   rationale and expiry.
2. Lint pass.
3. Test suite pass.
4. Build pass.
5. No new critical runtime errors in preview/smoke logs.

    Quality gates status: PASS / FAIL / WAIVED
    Waiver, owner, expiry:

## D) Human review gate

1. Independent non-author review completed.
2. Reviewer explicitly confirms: no security model drift; no role-elevation path
   introduced; no approval-gate weakening.
3. Reviewer marks unknown as FAIL.
4. No independent review: **STOP (NO-MERGE)**.

    Review gate status: PASS / FAIL
    Reviewer(s):

## E) Freeze and change-control gate

1. If the release includes a production posture change (for example an
   auth-provider toggle), create a controlled exception entry **before** the change.
2. The entry includes: reason, scope, risk, owner, change window, rollback,
   validation plan, evidence location.
3. No production posture change without a recorded exception.

    Change-control status: PASS / FAIL
    Exception reference:

## F) Execution sequence (must be in order)

1. Merge code.
2. Record exception entry (if required).
3. Apply production configuration change (if required).
4. Run the post-change validation pack.
5. Record evidence and close out.
6. Sequence broken: **STOP, NO-GO**.

    Sequence status: PASS / FAIL

## G) Post-change validation pack

1. New account flow works as intended.
2. New account lands in the pending state by default.
3. Pending account cannot access operational dashboards.
4. Pending account cannot self-promote role.
5. Inventory/master visibility remains approval-gated.
6. Existing admin and farmer logins remain functional.
7. Hardening invariants unchanged (function hashes, RLS counts, grant posture,
   release SHA parity, as applicable).
8. Any failure: execute rollback immediately.

    Validation status: PASS / FAIL
    Evidence path:

## H) Rollback decision tree

1. **Config-only failure** — revert the production config toggle, re-run critical
   validation.
2. **Code regression** — revert the merge commit, re-run CI and smoke.
3. **Authorization failure (critical)** — immediate NO-GO, halt the pilot, incident
   path, full control re-verification before resuming.

    Rollback executed: YES / NO
    Details:

## I) Final decision

1. **GO** only if all platform-enforced and process-enforced gates are PASS (or
   explicitly WAIVED where policy allows) and no unknowns remain.
2. **NO-GO** if any gate is FAIL or UNKNOWN.

    Final status: GO / NO-GO
    Approved by:
    Timestamp (UTC):
