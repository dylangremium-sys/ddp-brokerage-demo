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

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

// fileURLToPath decodes percent-encoding (e.g. a space in the workspace path
// becomes %20 in a file: URL) and applies platform-correct conversion. Using
// `new URL(...).pathname` here would leave %20 in the path and break fs calls on
// any checkout whose absolute path contains a space.
const ROOT = fileURLToPath(new URL('..', import.meta.url))
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

// ─── The deployment tool itself must be reproducible ────────────────────────
//
// The Vercel CLI is what actually puts bytes on the production domain, so an
// unpinned install makes the deployment non-reproducible: two runs of the SAME
// commit could deploy through two different tools, and a bad upstream release
// would reach production with no code change and no review. `vercel@latest`, a
// caret range, or a canary tag all reintroduce that.
//
// This asserts the SHAPE of the pin rather than a specific number, so it keeps
// working across upgrades instead of going stale the moment the version is bumped.
describe('the Vercel CLI is pinned to an exact stable version', () => {
  const install = WORKFLOW.match(/npm install --global vercel@(\S+)/)

  it('the CLI is installed with an explicit version', () => {
    expect(install, 'the deploy job must install a pinned vercel CLI').not.toBeNull()
  })

  it('is an exact numeric version — not latest, not a range', () => {
    const version = install[1]
    expect(version, `"${version}" must be exact semver like 56.2.0`).toMatch(/^\d+\.\d+\.\d+$/)
    expect(version).not.toBe('latest')
    // ^, ~, *, x and comparison operators all let the resolved version drift.
    expect(version).not.toMatch(/[\^~*x><= |]/)
  })

  it('is not a prerelease', () => {
    // canary/beta/rc builds must never be the thing that deploys production.
    expect(install[1]).not.toMatch(/alpha|beta|canary|rc|next|-/i)
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
    // Scope guard: build overrides are a separate decision and must not ride
    // along. Each key here was added deliberately and is pinned by its own
    // assertions rather than merely tolerated:
    //   `headers`  — audit R6: the live site sent no CSP/XFO/nosniff/
    //                Referrer-Policy/Permissions-Policy (own describe block below)
    //   `rewrites` — SPA deep links: without it every path except `/` returned a
    //                raw Vercel 404 (pinned immediately below)
    //   `crons`    — scheduled Watchtower ingestion; every regulatory source was
    //                previously checked only when a human clicked, and the click
    //                could not succeed at all (own describe block below)
    expect(Object.keys(VERCEL_CONFIG)).toEqual(['git', 'crons', 'rewrites', 'headers'])
  })
})

// ─── Scheduled Watchtower ingestion ─────────────────────────────────────────
//
// The cron is the only thing that makes regulatory monitoring unattended. It is
// pinned narrowly because both halves are load-bearing: the path must match the
// deployed function, and the schedule must be modest enough that DDP does not
// appear in a government access log as a scraper.
describe('vercel.json scheduled ingestion cron', () => {
  it('declares exactly one cron', () => {
    // More than one would mean a second, unreviewed scheduled trigger.
    expect(Array.isArray(VERCEL_CONFIG.crons)).toBe(true)
    expect(VERCEL_CONFIG.crons).toHaveLength(1)
  })

  it('points at the ingestion function that actually exists', () => {
    // A path typo produces a cron that fires into a 404 forever, and the
    // symptom is silence — monitoring simply never runs.
    expect(VERCEL_CONFIG.crons[0].path).toBe('/api/cron/ingest')
    expect(existsSync(join(ROOT, 'api/cron/ingest.ts'))).toBe(true)
  })

  it('runs daily, not more often', () => {
    // Politeness to the regulators, and the reason the throttle numbers are set
    // where they are. A per-minute schedule would be an IP block waiting to
    // happen against the exact hosts this feature depends on.
    expect(VERCEL_CONFIG.crons[0].schedule).toBe('0 2 * * *')
  })
})

// ─── SPA deep-link rewrites ─────────────────────────────────────────────────
//
// Client-side routing means only `/` exists as a real file. Without a rewrite,
// `https://www.ddpbrokerage.com/login` returned Vercel's UNSTYLED `404: NOT_FOUND`
// — verified against production 2026-07-30. Invitation links survived only because
// resolveInviteRedirectUrl() strips the path and Supabase appends the session as a
// fragment, so they land on `/`. Set APP_PUBLIC_URL with a path and every
// invitation would have 404'd.
describe('vercel.json SPA rewrites', () => {
  it('declares exactly one rewrite', () => {
    // More than one invites ordering questions that nothing here would catch.
    expect(Array.isArray(VERCEL_CONFIG.rewrites)).toBe(true)
    expect(VERCEL_CONFIG.rewrites).toHaveLength(1)
  })

  it('serves the SPA shell, not some other document', () => {
    expect(VERCEL_CONFIG.rewrites[0].destination).toBe('/index.html')
  })

  it('EXCLUDES /api so function routes are never masked by the SPA', () => {
    // Vercel matches the filesystem (including functions) before rewrites, so a
    // valid /api route is unaffected either way. The exclusion matters for an
    // INVALID one: without it a typo'd or removed endpoint would return the HTML
    // shell with HTTP 200 instead of a 404, so a broken API call would surface as
    // "unexpected token '<' in JSON" rather than as a missing route.
    const { source } = VERCEL_CONFIG.rewrites[0]
    expect(source).toContain('?!api/')

    const pattern = new RegExp(`^${source}$`)
    expect(pattern.test('/api/admin/provision-farmer')).toBe(false)
    expect(pattern.test('/api/public/access-request')).toBe(false)
  })

  it('DOES rewrite the app routes that were 404ing', () => {
    const pattern = new RegExp(`^${VERCEL_CONFIG.rewrites[0].source}$`)
    for (const path of ['/login', '/set-password', '/forgot-password', '/anything/deep']) {
      expect(pattern.test(path), `${path} should be rewritten to the SPA`).toBe(true)
    }
  })
})

// ─── Browser security headers (audit R6) ────────────────────────────────────
//
// These headers are applied by the Vercel platform, not by any code in this repo,
// so nothing else in the test suite can observe them. That makes vercel.json the
// only artefact a regression can be caught in — hence assertions on its content,
// not just its shape. The specific risk being closed: the admin console was
// framable (clickjacking of approve/reject/issue controls) and the Supabase
// session token lives in localStorage, so an XSS would be full session theft with
// no CSP backstop.
describe('vercel.json sets browser security headers on every route', () => {
  const rule = (VERCEL_CONFIG.headers || []).find((h) => h.source === '/(.*)')
  const header = (name) =>
    (rule?.headers || []).find((h) => h.key.toLowerCase() === name.toLowerCase())?.value

  it('applies to every path', () => {
    // A narrower source would leave the admin console (a client-side route)
    // uncovered, which is the exact surface clickjacking targets.
    expect(rule, 'no header rule matching every path').toBeTruthy()
  })

  it('denies framing two ways', () => {
    // frame-ancestors is the modern control; X-Frame-Options covers agents that
    // predate CSP level 2. Both, because the cost of the second is one line.
    expect(header('Content-Security-Policy')).toContain("frame-ancestors 'none'")
    expect(header('X-Frame-Options')).toBe('DENY')
  })

  it('sets nosniff, Referrer-Policy and Permissions-Policy', () => {
    expect(header('X-Content-Type-Options')).toBe('nosniff')
    expect(header('Referrer-Policy')).toBe('strict-origin-when-cross-origin')
    const pp = header('Permissions-Policy')
    for (const feature of ['camera=()', 'microphone=()', 'geolocation=()']) {
      expect(pp, `Permissions-Policy must deny ${feature}`).toContain(feature)
    }
  })

  it('never allows unsafe-eval or unsafe-inline', () => {
    // The two escape hatches that would make the CSP decorative. The app needs
    // neither: Vite emits no inline script or style into dist/index.html, and
    // React sets element styles through CSSOM (which CSP does not govern) rather
    // than through a style attribute.
    const csp = header('Content-Security-Policy')
    expect(csp).not.toContain('unsafe-eval')
    expect(csp).not.toContain('unsafe-inline')
  })

  it('locks down the sinks an XSS would reach for', () => {
    const csp = header('Content-Security-Policy')
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("base-uri 'self'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("form-action 'self'")
    expect(csp).toContain("script-src 'self'")
  })

  it('permits exactly the external origins the app actually uses', () => {
    // Derived from the deployed artefact, not from memory: index.html loads the
    // Google Fonts stylesheet + font files, and the bundle talks to exactly one
    // Supabase project origin. A CSP of "'self' plus Supabase" — the shape the
    // audit recommended — would have blocked the site's own webfonts.
    const csp = header('Content-Security-Policy')
    expect(csp).toContain("style-src 'self' https://fonts.googleapis.com")
    expect(csp).toContain("font-src 'self' https://fonts.gstatic.com")
    expect(csp).toContain('connect-src')
    expect(csp).toMatch(/connect-src [^;]*'self'/)
    expect(csp).toMatch(/connect-src [^;]*https:\/\/\w+\.supabase\.co/)
    // No wildcard host anywhere — a single `https:` or `*` would readmit every
    // origin the rest of this policy just excluded.
    expect(csp).not.toMatch(/\*/)
    expect(csp).not.toMatch(/(^|[; ])(script|connect|style|font|img)-src[^;]*\shttps:(\s|;|$)/)
  })

  it('deliberately does NOT allow external regulatory feed origins', () => {
    // Reviewer point (Codex P1): this policy blocks the Watchtower "Check feed"
    // button. Confirmed, and kept — the decision is recorded with its measurement
    // in docs/CSP_FEED_RETRIEVAL_DECISION.md.
    //
    // Both seeded RSS sources (sukl.gov.cz, eur-lex.europa.eu) return no
    // Access-Control-Allow-Origin, so a browser already refuses them; the CSP
    // makes an already-failing path fail one step earlier. Widening connect-src
    // could not fix it in general anyway: administrators register feed URLs at
    // runtime and vercel.json is baked at deploy time.
    //
    // This test exists so the exclusion stays a decision rather than drifting
    // into an accident — if a future change adds feed origins here, it should
    // come with the server-side proxy and an update to that document.
    const csp = header('Content-Security-Policy')
    for (const feedHost of ['sukl.gov.cz', 'eur-lex.europa.eu', 'moph.go.th', 'customs.go.th']) {
      expect(csp, `${feedHost} must not be granted by the CSP without the proxy decision being revisited`)
        .not.toContain(feedHost)
    }
  })
})
