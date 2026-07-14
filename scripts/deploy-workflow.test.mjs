// Regression guard: the CI-controlled Production deployment path.
//
// Vercel's Git integration used to deploy `main` automatically, in parallel with
// CI and without waiting for it — a red build could reach production. The
// replacement is a GitHub Actions job that CANNOT start until the verification job
// has succeeded. Everything that makes that guarantee real lives in one YAML file,
// and YAML has no type system: a single edit — dropping `needs`, widening the `if`,
// adding `continue-on-error` — silently converts the gate back into a rubber stamp
// while the workflow still looks correct and still goes green.
//
// So these properties are asserted directly against the workflow source. Each test
// below corresponds to a way the gate could be quietly disarmed.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

const ROOT = new URL('..', import.meta.url).pathname
const WORKFLOW = readFileSync(join(ROOT, '.github/workflows/security-ci.yml'), 'utf8')
const VERCEL_CONFIG = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'))

/** The `deploy-production:` job block, from its key to the next top-level job key. */
function deployJob() {
  const start = WORKFLOW.indexOf('\n  deploy-production:')
  if (start === -1) return ''
  const rest = WORKFLOW.slice(start + 1)
  // Next sibling job = a line indented exactly two spaces ending in ':'
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/)
  return next === -1 ? rest : rest.slice(0, next + 1)
}

describe('the workflow exists and defines both jobs', () => {
  it('loaded', () => {
    expect(WORKFLOW.length).toBeGreaterThan(500)
  })

  it('keeps the required check job name unchanged (branch protection pins this string)', () => {
    // Branch protection requires the context "Static security & build checks".
    // Renaming this job silently removes the required check from every future PR.
    expect(WORKFLOW).toMatch(/name: Static security & build checks/)
  })

  it('defines a deploy-production job', () => {
    expect(deployJob().length).toBeGreaterThan(200)
  })
})

describe('a deployment cannot start before verification succeeds', () => {
  it('deploy-production depends on verify', () => {
    expect(deployJob(), 'deploy-production must declare `needs: verify`').toMatch(/needs:\s*verify\b/)
  })

  it('no step may swallow a failure with continue-on-error', () => {
    // continue-on-error on verify would let a red build deploy; on a deploy step it
    // would let a failed deployment report success.
    expect(WORKFLOW).not.toMatch(/continue-on-error/)
  })
})

describe('deployment is restricted to main, and never runs on a pull request', () => {
  it('is gated on a push to refs/heads/main', () => {
    const job = deployJob()
    expect(job).toMatch(/if:.*github\.event_name == 'push'/)
    expect(job).toMatch(/if:.*github\.ref == 'refs\/heads\/main'/)
  })

  it('no deployment command appears outside the deploy-production job', () => {
    // A `vercel deploy` anywhere else — e.g. in the PR-triggered verify job — would
    // hand production to any pull request.
    const outside = WORKFLOW.replace(deployJob(), '')
    expect(outside, 'a deploy command exists outside deploy-production').not.toMatch(/vercel\s+deploy/)
    expect(outside).not.toMatch(/--prod\b/)
  })

  it('uses the Production environment, which is restricted to protected branches', () => {
    expect(deployJob()).toMatch(/environment:\s*Production/)
  })
})

describe('the deployment itself', () => {
  it('deploys the PREBUILT artifact to production', () => {
    // --prebuilt ships exactly what was built and verified in this run. Without it,
    // Vercel rebuilds from source and the deployed bytes are not the tested bytes.
    expect(deployJob()).toMatch(/vercel deploy --prebuilt --prod/)
  })

  it('verifies the live site actually serves this commit, and fails if it does not', () => {
    const job = deployJob()
    expect(job, 'the deployed commit must be checked against GITHUB_SHA').toMatch(/GITHUB_SHA/)
    expect(job, 'version.json is the proof the artifact is live').toMatch(/version\.json/)
    expect(job, 'a mismatch must fail the job, not warn').toMatch(/exit 1/)
  })
})

describe('a promoting deployment is never cancelled out from under itself', () => {
  it('the deploy job queues rather than cancels', () => {
    expect(deployJob()).toMatch(/cancel-in-progress:\s*false/)
  })

  it('workflow-level cancellation is scoped to pull requests only', () => {
    // The original `cancel-in-progress: true` would have killed a push-to-main run
    // mid-promotion when a second merge landed.
    expect(WORKFLOW).toMatch(/cancel-in-progress:\s*\$\{\{\s*github\.event_name == 'pull_request'\s*\}\}/)
  })
})

describe('credentials', () => {
  it('references exactly the expected secret names', () => {
    for (const name of ['VERCEL_TOKEN', 'VERCEL_ORG_ID', 'VERCEL_PROJECT_ID']) {
      expect(WORKFLOW, `${name} must come from secrets`).toContain(`secrets.${name}`)
    }
  })

  it('contains NO literal token', () => {
    // Vercel tokens are 24+ chars of [A-Za-z0-9]. Any such literal assigned to a
    // token-ish key means a credential was committed.
    expect(WORKFLOW).not.toMatch(/VERCEL_TOKEN:\s*['"]?[A-Za-z0-9]{20,}/)
    expect(WORKFLOW).not.toMatch(/--token[= ]['"]?[A-Za-z0-9]{20,}/)
  })

  it('never echoes a secret', () => {
    expect(WORKFLOW).not.toMatch(/echo\s+.*\$\{\{\s*secrets\./)
  })
})

// ─── The cutover: Vercel must not deploy `main` behind CI's back ─────────────
//
// Vercel's Git integration deployed `main` the instant a merge landed — for the
// PR #13 merge it fired at 21:09:25Z, a full minute before the verification job
// finished at 21:10:21Z. That is the ungated path this config closes, leaving the
// GitHub Actions job as the only routine automated route to Production.
//
// The danger in this file is over-reach, not under-reach: `deploymentEnabled: false`
// (a bare boolean) would disable EVERY branch, killing the Preview deployments that
// PR review depends on — and Preview is the only layer that caught the PR #9 outage.
// These assertions pin the narrow form.
describe('vercel.json disables Git production deploys for main — and nothing more', () => {
  it('disables Git-triggered deployment for main', () => {
    expect(VERCEL_CONFIG.git?.deploymentEnabled?.main).toBe(false)
  })

  it('does NOT disable deployments globally — Previews must keep working', () => {
    // A bare `false` here (rather than a per-branch map) would switch off Preview
    // deployments for every PR branch too.
    expect(typeof VERCEL_CONFIG.git?.deploymentEnabled).toBe('object')
    expect(VERCEL_CONFIG.git?.deploymentEnabled).not.toBe(false)
  })

  it('disables main and ONLY main', () => {
    // Any other branch listed here would silently stop its Previews.
    expect(Object.keys(VERCEL_CONFIG.git.deploymentEnabled)).toEqual(['main'])
  })

  it('adds no unrelated Vercel configuration', () => {
    // Scope guard: this file exists to close one bypass path. Rewrites, headers,
    // build overrides and crons are separate decisions and must not ride along.
    expect(Object.keys(VERCEL_CONFIG)).toEqual(['git'])
  })
})
