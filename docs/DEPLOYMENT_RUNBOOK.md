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
| **Type** | Vercel access token, **scoped to the `ddp-brokerage-demo` project only** |
| **Why project-scoped** | The Vercel team contains 7 projects. A team-scoped token would grant deploy rights to 6 unrelated ones. |
| **Stored** | GitHub Actions **environment secret** `VERCEL_TOKEN`, on the `Production` environment only |
| **Owner** | `dylangremium-sys` |
| **Expiry** | None. Rotation is therefore procedural, not automatic. |
| **Rotate** | Create a replacement token in the Vercel dashboard (scoped to this project), update the `VERCEL_TOKEN` environment secret, then revoke the old token. |
| **Revoke** | Vercel dashboard → Account Settings → Tokens → revoke; or `vercel tokens rm "github-actions-ddp-brokerage-prod"`. Revocation is independent of every other credential. |

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
| Automation deploy tokens | — | ✅ None exist beyond the project-scoped CI token |

The single remaining ungated principal is the Vercel account owner. Closing that would require Vercel Enterprise RBAC, which is a separate commercial decision.
