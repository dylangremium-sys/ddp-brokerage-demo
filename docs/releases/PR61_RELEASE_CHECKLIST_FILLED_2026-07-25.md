# Release checklist — PR #61 (public self-signup)

    Release ID:         signup-enablement-01
    Date (UTC):         2026-07-25
    Operator:           Claude Code (agent), on behalf of the release owner
    Target branch:      feat/public-self-signup -> main
    Target commit SHA:  606fc2b

Template: [`../RELEASE_CHECKLIST.md`](../RELEASE_CHECKLIST.md)

## A) Platform-enforced gates — **PASS**

Branch protection on `main` requires exactly one status context and zero approvals:

    required_status_checks.contexts   ["Static security & build checks"]
    required_approving_review_count   0
    strict                            true
    enforce_admins                    true

| # | Item | Result | Evidence |
|---|---|---|---|
| 1 | Required checks passing | PASS | `Static security & build checks` = pass on 606fc2b |
| 2 | Up to date with base | PASS | 0 commits behind `origin/main` (2dd6f53) |
| 3 | Merge method | PASS | squash, consistent with #57/#59/#60 |
| 4 | No conflicts | PASS | `mergeable: MERGEABLE` |

`mergeStateStatus: UNSTABLE` reflects a **non-required** check only. Nothing
mechanical blocks this merge.

## B) Process-enforced security gates — **PASS**

| # | Item | Result | Evidence |
|---|---|---|---|
| 1 | No schema/policy/privilege drift | PASS | diff has no `.sql`, no policy file, no `api/` file |
| 2 | Payload cannot set role/elevation | PASS | `signUp` sends `email`, `password`, `options.data.display_name` only |
| 3 | Pending fail-closed | PASS | `src/lib/postLoginRouting.ts` byte-identical to `main` |
| 4 | Inventory visibility unchanged | PASS | no inventory file in the diff |
| 5 | Routes / role-routing unchanged | PASS | routing untouched; `PUBLIC_PAGES` gains `'signup'` only |
| 6 | No secrets or dump artifacts | PASS | 0 secret-shaped matches; `backups/` gitignored; no tracked dump |

Server-side approval gate is **unmodified and pre-existing**: `public.handle_new_user()`
assigns `pending`; RLS *"profiles: admin update role"* permits a role change only for a
`ddp_admin`; `resolvePostLoginDecision()` denies `pending`. A pending account therefore
reaches no dashboard, and so no inventory view.

Reviewer note: `scripts/client-provisioning-boundary.test.mjs` was **amended, not
deleted**. The assertion *"client must not call signUp"* became the stricter *"client
signup must never submit a role"*. `signUpFarmer` and all service-role assertions are
unchanged. This is the single item most deserving of review scrutiny.

## C) Quality and stability gates — **FAIL (unknown)**

| # | Item | Result |
|---|---|---|
| 1 | Static analysis disposition | **FAIL — UNKNOWN** |
| 2 | Lint | PASS |
| 3 | Test suite | PASS — 1742 tests, 80 files |
| 4 | Build | PASS |
| 5 | No new critical runtime errors | PASS — preview deploy succeeded; production error feed clean over 24h |

The JavaScript quality gate reports a failure whose class could not be determined
from any available access path. This is a documented limitation, not an assumption:

- it is delivered as a **commit status**, not a check-run, so it carries no
  annotations and no output body — there is no API route to the detail;
- the only line-level comments on the PR are pinned to **superseded** commits
  (`line: null`), i.e. outdated, with none raised against 606fc2b;
- no analyzer configuration file exists in the repository or anywhere in its
  history, so thresholds are not inspectable from the repo;
- the run URL requires an authenticated session (HTTP 302).

Under the release rule that **unknown = FAIL**, this gate cannot be marked PASS, and
it cannot be WAIVED either: a waiver requires a named owner, a rationale and an
expiry, all of which are human decisions. Two prior remediations were applied and
validated (a variable rename, and a presentational component extraction); both were
behaviour-preserving and neither cleared the gate.

    Quality gates status: FAIL (UNKNOWN)
    Waiver: none.  Owner: unassigned.  Expiry: n/a.

## D) Human review gate — **FAIL**

`reviewDecision` is empty. The only review on the PR is an automated comment. The
PR author cannot self-approve, so this gate requires a second person or an explicitly
recorded single-approver exception with owner and expiry.

    Review gate status: FAIL
    Reviewer(s): none

## E) Freeze and change-control gate — **PASS**

This release is code-only; it makes no production posture change. The auth-provider
toggle is a separate, later step. Its exception entry (BG-001) is drafted but
deliberately **not recorded**, because the mandated sequence requires the merge first.

    Change-control status: PASS
    Exception reference: BG-001 (drafted, unrecorded)

## F) Execution sequence — **PASS (unbroken)**

Halted correctly at step 1. No merge, no exception recorded, no configuration change.

## G) Post-change validation pack — **PENDING**

Not run; this is pre-merge. Baseline invariants captured for later comparison:

| Invariant | Value at 2026-07-25 |
|---|---|
| `md5(prosrc)` of `public.issue_buyer_pack_snapshot` | `c4a255b81f220d2e6f67b4d59a97f961` |
| RLS enabled on public tables | 26 / 26 |
| Production release SHA | `2dd6f53` on all three surfaces |

    Evidence path: ~/ddp-evidence/

## H) Rollback decision tree — not executed

Nothing to roll back: no merge, no configuration change.

## I) Final decision — **NO-GO**

Two gates fail: **C** (quality disposition unknown) and **D** (no independent review).
Every platform-enforced gate and every security gate passes.

Neither open item is a security finding. Both are process discipline the repository
does not itself enforce — worth stating plainly, because nothing mechanical will
object if they are skipped.

    Final status: NO-GO
    Approved by: —
    Timestamp (UTC): 2026-07-25
