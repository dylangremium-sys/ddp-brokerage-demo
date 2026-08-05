// Generates public/version.json before every build so the running app can
// display which build is live, and so a deployed environment can be
// verified against a specific commit without relying only on the Vercel
// API. Includes the git commit SHA when available; falls back to "unknown"
// for the commit fields if git metadata isn't available in the build
// container (e.g. no .git directory) — this script must never fail the
// build over that.
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { execSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'))
const outDir = join(__dirname, '..', 'public')
const repoRoot = join(__dirname, '..')

function gitRevParse(args) {
  try {
    return execSync(`git rev-parse ${args}`, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return null
  }
}

/**
 * Resolve the commit being built, in order of authority.
 *
 * `git rev-parse` alone was not enough, and the gap was found the hard way: a
 * production deploy made with `vercel deploy --prod` from a local checkout
 * uploads the source tree WITHOUT `.git`, so git failed in the build container
 * and the live site advertised `commitSha: "unknown"`. The site was fine; the
 * one artefact that says WHICH build is serving traffic was not, which is the
 * entire reason this file exists. It has to survive a build container with no
 * git, because that is a normal way to deploy, not an error.
 *
 * Order:
 *   1. git — authoritative locally and in git-integration builds.
 *   2. VERCEL_GIT_COMMIT_SHA — set by Vercel whenever a deployment carries git
 *      metadata, including CLI deploys made from inside a repo.
 *   3. DDP_COMMIT_SHA — explicit escape hatch, so a deployer who knows the SHA
 *      can always stamp it: `vercel deploy --prod --build-env DDP_COMMIT_SHA=$(git rev-parse HEAD)`.
 *   4. "unknown" — still never fails the build.
 */
function resolveCommit() {
  const full = gitRevParse('HEAD')
  if (full) return { commitSha: full, commitShaShort: gitRevParse('--short HEAD') ?? full.slice(0, 7), source: 'git' }

  const fromEnv = process.env.VERCEL_GIT_COMMIT_SHA || process.env.DDP_COMMIT_SHA
  if (fromEnv?.trim()) {
    const sha = fromEnv.trim()
    return {
      commitSha: sha,
      commitShaShort: sha.slice(0, 7),
      source: process.env.VERCEL_GIT_COMMIT_SHA ? 'VERCEL_GIT_COMMIT_SHA' : 'DDP_COMMIT_SHA',
    }
  }

  // skipcq: JS-0002 — Node build script, never served to a browser. This warning
  // is the only signal that a deploy is about to lose its identity, and a test
  // asserts it reaches stderr.
  console.warn(
    'generate-version: no .git, and neither VERCEL_GIT_COMMIT_SHA nor DDP_COMMIT_SHA is set — ' +
      'falling back to "unknown". The deployed site will not be able to say which commit it is.',
  )
  return { commitSha: 'unknown', commitShaShort: 'unknown', source: 'none' }
}

const { commitSha, commitShaShort, source: shaSource } = resolveCommit()

mkdirSync(outDir, { recursive: true })
writeFileSync(
  join(outDir, 'version.json'),
  JSON.stringify({ version: pkg.version, builtAt: new Date().toISOString(), commitSha, commitShaShort }, null, 2) + '\n',
)

// skipcq: JS-0002 — this is a Node build script, never bundled or served to a
// browser. Its stdout IS the interface: naming the SHA source here is what makes
// a silent downgrade to "unknown" visible in the build log instead of on the
// live site afterwards, which is the defect this file was changed to fix.
console.log(`Generated public/version.json (v${pkg.version}, ${commitShaShort}, sha from: ${shaSource})`)
