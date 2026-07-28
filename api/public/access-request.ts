import { createHash } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  handleAccessRequest,
  GLOBAL_BUCKET_KEY,
  type AccessRequestSubmission,
  type IntakeDeps,
} from '../../src/lib/serverAccessRequestIntake.js'

// ─── Public supplier-intake Vercel Function (audit R5) ──────────────────────
//
// Thin adapter: reads server-only environment variables, wires a service-role
// Supabase client, derives a salted client bucket from the request, and delegates
// every decision to the pure, mock-tested core
// (src/lib/serverAccessRequestIntake.ts).
//
// The service-role key is read from process.env.SUPABASE_SERVICE_ROLE_KEY — a
// server-only variable. It is never bundled into the browser, never imported into
// src/, and never returned to the client.
//
// This endpoint is UNAUTHENTICATED by design: it is the public supplier enquiry
// form. Its protection is the throttle, the column CHECKs, and the fact that an
// insert can only ever create a status='new' row that no anonymous caller can
// read back.

interface VercelRequestLike {
  method?: string
  headers: Record<string, string | string[] | undefined>
  body?: unknown
}
interface VercelResponseLike {
  status(code: number): VercelResponseLike
  setHeader(name: string, value: string): void
  json(body: unknown): void
}

function headerValue(v: string | string[] | undefined): string | null {
  if (Array.isArray(v)) return v[0] ?? null
  return v ?? null
}

/**
 * The client address, as Vercel reports it.
 *
 * x-forwarded-for is a comma-separated chain; on Vercel the FIRST entry is the
 * real client and the rest are proxies. x-real-ip is preferred where present
 * because Vercel sets it itself and it cannot be spoofed by a client-supplied
 * header. A caller CAN spoof x-forwarded-for, so treating it as authoritative
 * would let an attacker rotate buckets at will — hence the ordering, and hence
 * the global rule in the core, which no per-client spoofing can evade.
 */
function clientAddress(req: VercelRequestLike): string | null {
  const realIp = headerValue(req.headers['x-real-ip'])
  if (realIp && realIp.trim()) return realIp.trim()

  const forwarded = headerValue(req.headers['x-forwarded-for'])
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim()
    if (first) return first
  }
  return null
}

/**
 * Salted, non-reversible client identifier.
 *
 * The raw address is NEVER stored. The salt prefers a dedicated server-only
 * variable and falls back to SUPABASE_URL, which is always present whenever this
 * function is configured at all — a form that dies because one more optional
 * variable was forgotten is a worse outcome than a salt that is merely
 * deployment-specific.
 *
 * This is pseudonymisation for abuse control, not a secrecy claim: anyone holding
 * both the salt and a candidate address can confirm a match. That bound is stated
 * on the table comment in migration 36.
 */
function bucketKeyFor(address: string, salt: string): string {
  return createHash('sha256').update(`${address}:${salt}`).digest('hex')
}

function buildDeps(req: VercelRequestLike): IntakeDeps | null {
  const url = process.env.SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceRoleKey) return null

  const salt = process.env.PUBLIC_INTAKE_IP_SALT || url

  const admin: SupabaseClient = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  return {
    bucketKeyForClient() {
      const address = clientAddress(req)
      return address ? bucketKeyFor(address, salt) : null
    },

    now: () => new Date(),

    async countAttempts(bucketKey, since) {
      const { count, error } = await admin
        .from('public_intake_attempts')
        .select('id', { count: 'exact', head: true })
        .eq('bucket_key', bucketKey)
        .gt('occurred_at', since.toISOString())
      // Throwing (rather than returning 0) is what makes the core fail closed:
      // an unreadable throttle must never read as "no attempts yet".
      if (error) throw new Error(error.message)
      return count ?? 0
    },

    async recordAttempt(bucketKey) {
      const { error } = await admin.from('public_intake_attempts').insert({ bucket_key: bucketKey })
      if (error) throw new Error(error.message)
    },

    async hasOpenRequestForEmail(email) {
      const { data, error } = await admin
        .from('farmer_access_requests')
        .select('id')
        .ilike('email', email)
        .in('status', ['new', 'contacted'])
        .limit(1)
      if (error) throw new Error(error.message)
      return (data ?? []).length > 0
    },

    async insertRequest(input: AccessRequestSubmission) {
      const { error } = await admin.from('farmer_access_requests').insert({
        full_name: input.fullName,
        email: input.email,
        phone: input.phone,
        province: input.province,
        position: input.position,
        preferred_language: input.preferredLanguage,
        note: input.note,
        status: 'new',
      })
      if (error) throw new Error(error.message)
    },
  }
}

export default async function handler(req: VercelRequestLike, res: VercelResponseLike): Promise<void> {
  const outcome = await handleAccessRequest(req.method, req.body, buildDeps(req))

  if (outcome.status === 429 && 'retryAfterSeconds' in outcome.body) {
    res.setHeader('Retry-After', String(outcome.body.retryAfterSeconds))
  }
  // This endpoint is same-origin only. There is no reason for another site to
  // POST enquiries into this queue on a visitor's behalf.
  res.setHeader('Cache-Control', 'no-store')

  res.status(outcome.status).json(outcome.body)
}

export { bucketKeyFor, clientAddress, GLOBAL_BUCKET_KEY }
