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

function gitRevParse(args, label) {
  try {
    return execSync(`git rev-parse ${args}`, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    console.warn(`generate-version: could not resolve git ${label} (no .git available?) — falling back to "unknown"`)
    return 'unknown'
  }
}

const commitSha = gitRevParse('HEAD', 'HEAD')
const commitShaShort = gitRevParse('--short HEAD', '--short HEAD')

mkdirSync(outDir, { recursive: true })
writeFileSync(
  join(outDir, 'version.json'),
  JSON.stringify({ version: pkg.version, builtAt: new Date().toISOString(), commitSha, commitShaShort }, null, 2) + '\n',
)

console.log(`Generated public/version.json (v${pkg.version}, ${commitShaShort})`)
