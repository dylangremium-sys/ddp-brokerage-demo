// Generates public/version.json before every build so the running app can
// display which build is live — no git dependency, works identically
// locally and on Vercel (unlike a git-SHA approach, which needs the build
// container to have .git available).
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'))
const outDir = join(__dirname, '..', 'public')

mkdirSync(outDir, { recursive: true })
writeFileSync(
  join(outDir, 'version.json'),
  JSON.stringify({ version: pkg.version, builtAt: new Date().toISOString() }, null, 2) + '\n',
)

console.log(`Generated public/version.json (v${pkg.version})`)
