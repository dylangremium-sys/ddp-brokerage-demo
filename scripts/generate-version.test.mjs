import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

/**
 * public/version.json is the only thing that lets anyone ask a RUNNING site
 * which commit it is. It stamped "unknown" on a real production deploy: `vercel
 * deploy --prod` uploads the source tree without `.git`, so the script's lone
 * `git rev-parse` failed in the build container and the live site lost its
 * identity. The build succeeded, so nothing went red — that is precisely why it
 * needs a test rather than vigilance.
 *
 * The script is run in a COPY inside a temp dir, never in the repo: it writes to
 * `<its own ..>/public/version.json`, and a test that ran it in place would
 * overwrite the real artefact and race any concurrent build.
 */
const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'generate-version.js')

let sandbox

function runIn(dir, env) {
  const res = spawnSync(process.execPath, [join(dir, 'scripts', 'generate-version.js')], {
    cwd: dir,
    env: { ...process.env, VERCEL_GIT_COMMIT_SHA: '', DDP_COMMIT_SHA: '', ...env },
    encoding: 'utf8',
  })
  return {
    status: res.status,
    stderr: res.stderr ?? '',
    stdout: res.stdout ?? '',
    json: (() => {
      try { return JSON.parse(readFileSync(join(dir, 'public', 'version.json'), 'utf8')) } catch { return null }
    })(),
  }
}

function makeSandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'genver-'))
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  copyFileSync(SCRIPT, join(dir, 'scripts', 'generate-version.js'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'sandbox', version: '9.9.9' }))
  return dir
}

beforeAll(() => { sandbox = makeSandbox() })
afterAll(() => { if (sandbox) rmSync(sandbox, { recursive: true, force: true }) })

describe('the version stamp survives a build container with no git', () => {
  it('the sandbox genuinely has no git, or every case below is vacuous', () => {
    // If the temp dir were inside a repo, `git rev-parse` would succeed and the
    // env-var branches would never execute while still reporting green.
    const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: sandbox, encoding: 'utf8' })
    expect(r.status).not.toBe(0)
  })

  it('falls back to VERCEL_GIT_COMMIT_SHA, which Vercel sets for CLI deploys from a repo', () => {
    const sha = 'a'.repeat(40)
    const r = runIn(sandbox, { VERCEL_GIT_COMMIT_SHA: sha })
    expect(r.status).toBe(0)
    expect(r.json.commitSha).toBe(sha)
    expect(r.json.commitShaShort).toBe(sha.slice(0, 7))
  })

  it('falls back to DDP_COMMIT_SHA, the explicit escape hatch', () => {
    const sha = 'b'.repeat(40)
    const r = runIn(sandbox, { DDP_COMMIT_SHA: sha })
    expect(r.status).toBe(0)
    expect(r.json.commitSha).toBe(sha)
  })

  it('prefers VERCEL_GIT_COMMIT_SHA over DDP_COMMIT_SHA when both are set', () => {
    const r = runIn(sandbox, { VERCEL_GIT_COMMIT_SHA: 'c'.repeat(40), DDP_COMMIT_SHA: 'd'.repeat(40) })
    expect(r.json.commitSha).toBe('c'.repeat(40))
  })

  it('with no git and no env, still exits 0 but WARNS — it must never fail a build', () => {
    const r = runIn(sandbox, {})
    expect(r.status).toBe(0)
    expect(r.json.commitSha).toBe('unknown')
    expect(r.stderr).toMatch(/will not be able to say which commit/i)
  })

  it('an empty env var is treated as absent, not as a commit', () => {
    // Vercel exposes unset variables as empty strings in some contexts, and ''
    // would otherwise be stamped as the SHA.
    const r = runIn(sandbox, { VERCEL_GIT_COMMIT_SHA: '   ' })
    expect(r.json.commitSha).toBe('unknown')
  })
})

describe('git remains authoritative when it is available', () => {
  it('a sandbox WITH a git repo stamps the real HEAD, ignoring the env var', () => {
    const dir = makeSandbox()
    try {
      const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' })
      git('init', '-q')
      git('config', 'user.email', 'test@example.com')
      git('config', 'user.name', 'Test')
      git('add', '-A')
      git('commit', '-qm', 'seed')
      const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim()
      expect(head).toMatch(/^[0-9a-f]{40}$/)

      const r = runIn(dir, { VERCEL_GIT_COMMIT_SHA: 'e'.repeat(40) })
      expect(r.json.commitSha).toBe(head)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
