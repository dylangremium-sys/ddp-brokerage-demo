// Static boundary guard for the DDP-controlled provisioning workstream.
//
// Locks in two invariants that keep the security model intact:
//   1. The shipped CLIENT source (src/, excluding tests) contains no public
//      signup path (supabase.auth.signUp / signUpFarmer) and never references a
//      service-role secret.
//   2. The server endpoint reads the service-role key only from process.env and
//      never from a VITE_/import.meta.env value.
//
// Lives in scripts/ (.mjs) because reading the tree from disk needs node types
// the app tsconfig withholds from src.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const root = new URL('..', import.meta.url)

function walk(relDir) {
  const dir = fileURLToPath(new URL(relDir, root))
  const out = []
  for (const name of readdirSync(dir)) {
    const abs = `${dir}/${name}`
    if (statSync(abs).isDirectory()) {
      out.push(...walk(`${relDir}/${name}`))
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(abs)
    }
  }
  return out
}

// Shipped client source = src/ minus test files (tests are never bundled).
const clientFiles = walk('src').filter((f) => !/\.test\.(ts|tsx)$/.test(f))
const clientText = clientFiles.map((f) => readFileSync(f, 'utf8')).join('\n')

describe('public signup can create an account but never an operational one', () => {
  // Public self-registration is permitted: a signup mints a NON-operational
  // 'pending' profile, because public.handle_new_user() assigns the role
  // server-side (21_DDP_CONTROLLED_FARMER_PROVISIONING_HARDENING.sql) and RLS
  // permits a role change only for a ddp_admin. The invariant this file guards
  // is therefore no longer "the client cannot call signUp" but the stronger,
  // more accurate "the client cannot influence the role it is assigned".
  const authSrc = readFileSync(fileURLToPath(new URL('src/services/auth.ts', root)), 'utf8')
  const signUpBody = authSrc.slice(
    authSrc.indexOf('export async function signUp('),
    authSrc.indexOf('export async function getCurrentProfile('),
  )

  it('has a signUp wrapper at all (public registration is enabled)', () => {
    expect(signUpBody).toMatch(/supabase\.auth\.signUp\b/)
  })

  it('never sends a role, so the server assigns pending', () => {
    expect(signUpBody).not.toMatch(/\brole\b\s*:/)
  })

  it('is the only signUp call in the shipped client', () => {
    const calls = clientText.match(/supabase\.auth\.signUp\b/g) ?? []
    expect(calls).toHaveLength(1)
  })

  it('has no signUpFarmer symbol', () => {
    expect(clientText).not.toMatch(/signUpFarmer/)
  })
})

describe('service-role secret never reaches the client', () => {
  it('client source references no service-role key', () => {
    expect(clientText).not.toMatch(/SERVICE_ROLE|service_role/)
  })

  it('client Supabase client uses only the anon key', () => {
    const supa = readFileSync(fileURLToPath(new URL('src/lib/supabase.ts', root)), 'utf8')
    expect(supa).toMatch(/VITE_SUPABASE_ANON_KEY/)
    expect(supa).not.toMatch(/SERVICE_ROLE|service_role/)
  })
})

describe('server endpoint keeps the service-role key server-side', () => {
  const api = readFileSync(
    fileURLToPath(new URL('api/admin/provision-farmer.ts', root)),
    'utf8',
  )

  it('reads the service-role key only from process.env', () => {
    expect(api).toMatch(/process\.env\.SUPABASE_SERVICE_ROLE_KEY/)
  })

  it('never uses VITE_ or import.meta.env (client-exposed) for secrets', () => {
    expect(api).not.toMatch(/import\.meta\.env/)
    expect(api).not.toMatch(/VITE_/)
  })
})
