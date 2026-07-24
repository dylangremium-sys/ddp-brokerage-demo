# Production Deployment Runbook

**Production:** https://www.ddpbrokerage.com
**Vercel project:** `ddp-brokerage-demo`
**Protected branch:** `main`

---

## 1. The authorised path to Production

**GitHub Actions is the only authorised automated route to Production.**

```
open PR  →  "Static security & build checks" must pass  →  merge to main
         →  verify job runs again on the merge commit
         →  deploy-production job (needs: verify) deploys to Vercel
         →  job fails unless https://www.ddpbrokerage.com/version.json reports the merge commit
```

`deploy-production` (`.github/workflows/security-ci.yml`) cannot start unless `verify` has **succeeded** — that is what `needs: verify` enforces. It never runs on a pull request, and it only runs for a push to `refs/heads/main`.

It deploys the **prebuilt** artifact (`vercel deploy --prebuilt --prod`), so the bytes that go live are exactly the bytes CI verified — Vercel does not rebuild from source.

---

## 2. Why Vercel Git auto-deploy is STILL ACTIVE (PR 1 only)

This is deliberate and temporary.

PR 1 **adds** the CI-controlled path but **does not remove** the old one. Vercel's Git integration still auto-deploys `main`. Disabling it before the replacement has ever successfully deployed Production would leave no working path at all — so the old path stays until the new one is proven.

**Expected consequence: when PR 1 merges, Production is deployed TWICE — once by Vercel's Git integration and once by GitHub Actions — from the same merge commit.** Identical content, so the outcome is the same either way. This is expected, not a fault. Two Production deployments for one commit will appear in the Vercel deployment list.

**PR 2 removes the duplicate** by adding `vercel.json`:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "git": { "deploymentEnabled": { "main": false } }
}
```

This disables Git-triggered deployments for `main` only. **Preview deployments for pull-request branches continue to work** — they are what makes the pre-merge Preview probe possible, and that probe is the only layer that would have caught the PR #9 outage.

PR 2 must not be opened until a CI-controlled Production deployment has succeeded.

---

## 3. Deployment credential

| | |
|---|---|
| **Name** | `github-actions-ddp-brokerage-prod` |
| **Stored** | GitHub Actions **environment secret** `VERCEL_TOKEN`, on the `Production` environment only |
| **Owner** | `dylangremium-sys` |
| **Expiry** | None. Rotation is therefore procedural, not automatic. |
| **Revoke** | Vercel dashboard → Account Settings → Tokens → revoke; or `vercel tokens rm "github-actions-ddp-brokerage-prod"`. Revocation is independent of every other credential. |

**Token scope:** Team-scoped Vercel access token covering all seven projects in the Vercel team.

**Current blast radius:** The workflow targets only `ddp-brokerage-demo` through `VERCEL_PROJECT_ID`, but the token itself is not restricted to that project and can authenticate deployment actions against the other six team projects.

**Preferred future state:** Replace the current token with a project-scoped token created through:

`vercel tokens add --project prj_i61VbKejp67md9rK8sueVqp1gIJx`

This requires a Vercel session authorised to mint tokens. The existing GitHub OAuth-backed CLI session returned:

`403 Cannot create tokens for this app`

After creating the narrower token:

1. replace the GitHub `Production` environment secret `VERCEL_TOKEN`;
2. verify the CI-controlled deployment path;
3. revoke the old team-scoped token.

The token value must **never** be committed, echoed, printed, placed in a Vercel environment variable, or exposed as a `VITE_*` variable (`VITE_*` values are inlined into the browser bundle).

Supporting identifiers, also stored as `Production` environment secrets: `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`. These are identifiers, not credentials.

The `Production` environment is restricted to **protected branches**, so a workflow run from any other ref cannot read these secrets. There are **no required reviewers** — with a single maintainer, a review requirement would deadlock every deployment.

---

## 4. Rollback

Rolling back is a **Vercel-side** action and does not require a revert commit.

```bash
vercel rollback                       # roll back to the previous Production deployment
vercel promote <deployment-url>       # promote a specific known-good deployment
vercel rollback status                # confirm
```

Then verify:

```bash
curl -s https://www.ddpbrokerage.com/version.json     # commitSha should be the rolled-back commit
```

Rolling back leaves `main` ahead of Production. **Follow it with a real fix or a revert PR** — otherwise the next merge silently re-deploys the broken commit.

Prior Production deployments remain available as rollback candidates; check with `vercel list --prod`.

---

## 5. Manual Vercel deployment is EMERGENCY ONLY

`vercel deploy --prod`, `vercel promote`, dashboard redeploy and API deployment all still work for the Vercel account **owner**. They bypass GitHub entirely: no PR, no required check, no CI.

**This power cannot be removed on the current plan.** Vercel Pro has no role-based restriction preventing the account owner from deploying manually, and the project has a single member with the `OWNER` role. Do not describe Production as "impossible to bypass" — it is not. What is true is that the *routine automated* path is now gated.

Rules:

- **Do not** use manual deployment as a normal workflow. It is not the authorised path.
- Use it only when CI itself is broken or unavailable and Production must change urgently.
- After any manual deployment, record what was deployed and why, and reconcile `main` so the repository and Production agree.

---

## 6. Required verification after EVERY Production deployment

CI does the first two automatically and fails if they do not hold. Do the rest by hand after anything unusual.

1. **`/version.json` reports the deployed commit** — the deploy job polls until this matches `GITHUB_SHA` and fails otherwise.
2. Homepage returns **HTTP 200**.
3. The AI-summary endpoint **loads** — an unauthenticated `POST /api/compliance/ai-summary` returns a normal correlated `401`, not `FUNCTION_INVOCATION_FAILED`.
4. **No 5xx and no `ERR_MODULE_NOT_FOUND`** in Vercel runtime logs.

Point 3 is not a formality. A green `ci:verify` once shipped a serverless function that could not load at all (PR #9): Vite, Vitest and TypeScript all resolve extensionless imports, but Vercel's native Node ESM runtime does not. **CI cannot see that class of failure.** Any change under `api/` must be probed on the PR's Preview deployment *before* merge.

---

## 7. Who can still change Production

| Principal | Path | Gated? |
|---|---|---|
| GitHub Actions `deploy-production` | Merge to `main` after `verify` passes | ✅ Yes — the authorised path |
| Vercel account **owner** | `vercel deploy --prod`, `promote`, dashboard redeploy, API | ❌ **No — documented emergency override** |
| Deploy Hooks | — | ✅ None exist |
| Automation deploy tokens | — | ⚠️ One exists: the team-scoped CI token (`VERCEL_TOKEN`). It reaches all seven team projects, not only this one — see §3. |

The single remaining ungated principal is the Vercel account owner. Closing that would require Vercel Enterprise RBAC, which is a separate commercial decision.

---

## 8. Evidence schema-readiness gate (G4)

A **fail-closed deployment precondition** that stops Evidence application-layer code
from shipping into a Production database that does not yet contain the migration-24
objects it depends on. This is release-readiness gate **G4** in
`docs/EVIDENCE_RELEASE_READINESS_CHECKLIST.md`.

### 8.1 Where it runs and what it blocks

- **Job/step:** `deploy-production` → step **"G4 evidence schema-readiness gate
  (blocking)"** in `.github/workflows/security-ci.yml`, positioned **after
  `npm ci` and before the Vercel build/deploy steps**.
- **Blocking:** it runs `npm run security:evidence-readiness`
  (`scripts/check-evidence-schema-readiness.mjs`). A non-zero exit fails the step,
  which fails the job, so `vercel deploy --prebuilt --prod` never runs. This is the
  same mechanical model as `needs: verify` — nothing advisory.
- **Scope:** it governs the **authorised CI path to Production** (§1). It does **not**
  govern Vercel Git **preview** deployments of PR branches (those bypass this
  workflow entirely — see §2); that is a documented residual gap, not something this
  gate enforces. Do not describe preview environments as G4-protected.

### 8.2 When it applies (conditional, auditable, self-activating)

The gate reads the **deployed `src/` tree**. It is **APPLICABLE** only when that tree
references a migration-24 evidence RPC or the evidence storage bucket id
(`evidence-request-files`) — the ground-truth token list in the script. Functional
Evidence code cannot avoid these references, so:

- **Today** (Evidence app layer not on `main`): **NOT APPLICABLE** → the gate passes
  and requires no secret.
- **When the feature lands on `main`:** **APPLICABLE** → the readiness check becomes
  mandatory and a missing credential blocks the deploy.

There is deliberately **no skip/override environment variable**. Bypassing the gate
requires a git-visible edit to the script or workflow.

### 8.3 The three states (only READY ships)

| Verdict | Exit | Deploy | Meaning |
|---|:--:|---|---|
| `READY` (or `NOT APPLICABLE`) | 0 | proceeds | All required objects present with the required shape, or no Evidence code deployed. |
| `NOT_READY` | 1 | **blocked** | At least one required migration-24 object is absent or wrong in the target DB. |
| `UNABLE_TO_DETERMINE` | 2 | **blocked** | Missing credential, unreachable/timed-out DB, absent storage schema, query error, or a target that fails the expected-ref guard. |

**"Unable to determine" blocks.** The gate never treats an unknown as a pass.

### 8.4 What it checks (structural surface)

Read-only catalog checks (`SELECT`-only, run with
`default_transaction_read_only=on`; no DDL/DML; connection string never printed):

- The 4 evidence tables exist **with RLS enabled**.
- The 14 client-invoked RPCs (13 workflow RPCs + `can_operationally_access_farm`)
  exist, are **`SECURITY DEFINER`**, and **pin `search_path`**.
- The `evidence-request-files` bucket exists, is **private**, and has
  `file_size_limit = 104857600` (100 MiB).
- The **5 named `storage.objects` policies** for that bucket exist.

### 8.5 What it does NOT prove

It proves **structural presence and shape only**. It does **not** prove RLS actually
denies cross-farm/non-disclosure access, that triggers enforce append-only history
and submitted-evidence immutability, that reserve/finalize size-MIME-extension
validation works, tombstone/post-submission-cleanup behaviour, or signed-URL
authorization. **Presence ≠ enforcement.** Those are hosted **behavioural**
properties proven by `24_EVIDENCE_REQUEST_RESOLUTION_VERIFY.sql` (A–R) and the role
matrix in `docs/EVIDENCE_MIGRATION_24_STAGING_VERIFICATION_RUNBOOK.md`. **G4 is not a
substitute for G2.**

### 8.6 Required secret / variable and where they belong

| Name | Kind | Location | Purpose |
|---|---|---|---|
| `EVIDENCE_SCHEMA_CHECK_DATABASE_URL` | **Secret** | GitHub **`Production` environment** (protected-branch runs only — same boundary as `VERCEL_TOKEN`) | Read-only Postgres connection string for the **target Production** database. Use a read-only role. |
| `EVIDENCE_SCHEMA_CHECK_EXPECTED_REF` | Variable (non-secret) | Repo/environment **variable** | **Required whenever the gate applies:** substring (target Supabase project ref) the connection string must contain. If unset, the gate fails closed (`UNABLE_TO_DETERMINE`) — target identity cannot be confirmed, so a `READY` could describe the wrong database. Both this and the secret must be provisioned before Evidence app code merges to `main`. |

The `Production` environment is restricted to protected branches, so a run from any
other ref cannot read the secret — consistent with §3. Provision the read-only DB
role and this secret **before** the Evidence application layer merges to `main`;
until then the gate is inert and neither is required.

### 8.7 Break-glass

There is no in-band override. If the gate is wrong (e.g. a false `UNABLE` from a
transient DB outage) and Production must change urgently, the only path is the
documented **emergency manual Vercel deployment** (§5), which bypasses GitHub Actions
entirely and must be recorded and reconciled afterward. Prefer fixing the underlying
cause (apply migration 24 to the target, or repair the credential) over manual
deployment.

### 8.8 Relationship to the release checklist and staging verification

- **G2** (hosted staging apply + behavioural verification) and **G4** are distinct.
  G2 proves the security/behaviour model live on staging under non-owner principals;
  G4 is a per-deploy structural precondition on the Production target. A green G4 with
  no G2 evidence means "the objects are present," **not** "the model is proven."
- Run order in the programme: reconcile contract (G1) → verify on staging (G2) → this
  deploy-time gate (G4) protects the Production ship → production rollout
  authorization (G6). See the checklist for the full gate sequence.
