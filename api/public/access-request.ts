import { createHash } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  handleAccessRequest,
  GLOBAL_BUCKET_KEY,
  THROTTLE_RULES,
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
 * real client and the rest are proxies. x-real-ip is preferred where present.
 *
 * ASSUMPTION, STATED BECAUSE IT IS NOT PROVEN: this code assumes Vercel's proxy
 * OVERWRITES a client-supplied `x-real-ip` rather than forwarding it. That is
 * the documented behaviour of every reverse proxy this pattern is normally used
 * with, and it is why x-real-ip is preferred over the client-controllable
 * x-forwarded-for — but it has NOT been verified against Vercel's edge for this
 * deployment, and no test here can verify it, because it is a property of the
 * platform rather than of this function.
 *
 * If that assumption is wrong, a caller can set x-real-ip freely and rotate
 * per-client buckets at will. The design does not depend on it being right: the
 * GLOBAL rule in the core is evaluated on every request, is unaffected by any
 * per-client key the caller can influence, and therefore still bounds total
 * intake. Per-client throttling degrades; the ceiling does not.
 */
function clientAddress(req: VercelRequestLike): string | null {
  const realIp = headerValue(req.headers['x-real-ip'])
  if (realIp?.trim()) return realIp.trim()

  const forwarded = headerValue(req.headers['x-forwarded-for'])
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim()
    if (first) return first
  }
  return null
}

/**
 * Canonicalises an address so that two spellings of the same client cannot land
 * in two different buckets, and so that one client cannot own an effectively
 * unlimited number of buckets.
 *
 * Two distinct problems, both of which defeated the per-client rules:
 *
 *  1. SPELLING. `::1` and `0:0:0:0:0:0:0:1` are the same address; `2001:DB8::1`
 *     and `2001:db8::1` differ only in case. Hashing the raw string put each
 *     spelling in its own bucket. Node's built-in URL parser is used to
 *     normalise rather than a hand-rolled parser — it implements the RFC 4291
 *     rules (zero compression, leading zeros, lowercasing) that a regex will get
 *     wrong.
 *
 *  2. ALLOCATION SIZE. An IPv6 client is routinely assigned a /64 — 2^64
 *     addresses — so per-address bucketing gives a single attacker 2^64 buckets
 *     and no per-client limit at all. Bucketing by the /64 PREFIX makes the unit
 *     of limitation the allocation rather than the address.
 *
 * /64 is the conventional choice because it is the smallest allocation an end
 * site is guaranteed by RFC 6177/RFC 4291 addressing architecture, so it is the
 * narrowest prefix that cannot be subdivided by the client. Choosing /128 gives
 * an attacker unlimited buckets; choosing /48 or shorter would put unrelated
 * customers of the same ISP in one bucket and let one abuser lock out another
 * organisation. IPv4 is bucketed per address (/32): the address IS the scarce
 * allocation there.
 */
export function normaliseAddress(address: string): string | null {
  const trimmed = (address ?? '').trim()
  if (!trimmed) return null

  // A bracketed or port-suffixed form can arrive from some proxies.
  const unbracketed = trimmed.startsWith('[') && trimmed.includes(']')
    ? trimmed.slice(1, trimmed.indexOf(']'))
    : trimmed

  // IPv4 (optionally with a :port). Dotted-quad, no colons beyond a port.
  const v4 = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?::\d+)?$/.exec(unbracketed)
  if (v4) {
    const octets = v4[1].split('.').map(Number)
    if (octets.every(o => Number.isInteger(o) && o >= 0 && o <= 255)) {
      return `v4:${octets.join('.')}`
    }
    return null
  }

  // IPv6. Let the URL parser canonicalise it — it lowercases, compresses zero
  // runs and rejects malformed input, which a regex would not do reliably.
  let canonical: string
  try {
    const parsed = new URL(`http://[${unbracketed}]`)
    canonical = parsed.hostname.replace(/^\[|\]$/g, '')
  } catch {
    return null
  }

  // Expand to eight groups so the /64 prefix can be taken positionally.
  const [head, tail] = canonical.split('::')
  const headGroups = head ? head.split(':').filter(Boolean) : []
  const tailGroups = tail ? tail.split(':').filter(Boolean) : []
  if (canonical.includes('::')) {
    const fill = 8 - headGroups.length - tailGroups.length
    if (fill < 0) return null
    headGroups.push(...Array<string>(fill).fill('0'), ...tailGroups)
  }
  if (headGroups.length !== 8) return null

  // The /64 prefix is the first four groups.
  return `v6/64:${headGroups.slice(0, 4).map(g => g.replace(/^0+(?=.)/, '')).join(':')}`
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
 *
 * Returns null for an address that cannot be canonicalised, so the caller fails
 * closed rather than hashing an attacker-chosen string.
 */
function bucketKeyFor(address: string, salt: string): string | null {
  const canonical = normaliseAddress(address)
  if (canonical === null) return null
  return createHash('sha256').update(`${canonical}:${salt}`).digest('hex')
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
      // A null here makes the core fail closed with a 503 rather than accepting
      // an unthrottleable request — including when the address is present but
      // cannot be canonicalised.
      return address ? bucketKeyFor(address, salt) : null
    },

    now: () => new Date(),

    async reserveThrottleSlot(clientBucketKey) {
      // One round trip. The reservation and the limit check happen inside
      // public.reserve_public_intake_slot() under an advisory transaction lock,
      // so concurrent invocations on separate serverless instances cannot all
      // pass the check before any of them writes. THROTTLE_RULES is passed in so
      // the application remains the single source of the policy.
      const { data, error } = await admin.rpc('reserve_public_intake_slot', {
        p_client_key: clientBucketKey,
        p_global_key: GLOBAL_BUCKET_KEY,
        p_rules: THROTTLE_RULES,
      })
      // Throwing (rather than returning allowed) is what makes the core fail
      // closed: an unreachable throttle must never read as "no attempts yet".
      if (error) throw new Error(error.message)
      if (!data || typeof data !== 'object' || typeof (data as { allowed?: unknown }).allowed !== 'boolean') {
        throw new Error('reserve_public_intake_slot returned an unusable result')
      }
      const result = data as { allowed: boolean; windowSeconds?: number }
      return { allowed: result.allowed, windowSeconds: result.windowSeconds }
    },

    async hasOpenRequestForEmail(email) {
      // Compared as a case-insensitive LITERAL by the database. The previous
      // .ilike('email', email) sent the address to SQL ILIKE as a PATTERN, so a
      // legal `_` or `%` in the local part acted as a wildcard and matched an
      // unrelated stored address — the enquiry was then dropped as a duplicate
      // while the caller saw HTTP 200.
      const { data, error } = await admin.rpc('has_open_access_request', { p_email: email })
      if (error) throw new Error(error.message)
      if (typeof data !== 'boolean') {
        throw new Error('has_open_access_request returned an unusable result')
      }
      return data
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
export type { VercelRequestLike }
