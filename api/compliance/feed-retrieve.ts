import { createHash } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { RegulatorySource } from '../../src/types.js'
import {
  FEED_RETRIEVAL_GLOBAL_BUCKET_KEY,
  FEED_RETRIEVAL_THROTTLE_RULES,
  feedRetrievalClientBucketKey,
} from '../../src/lib/serverFeedRetrievalThrottle.js'
import type { NormalizedRequest, ServerFeedRetrievalDeps } from '../../src/lib/serverFeedRetrieval.js'
import { FEED_RETRIEVE_ROUTE, runFeedRetrieveEndpoint } from '../../src/lib/serverFeedRetrievalEndpoint.js'
import { logServerError, newRequestId } from '../../src/lib/observability.js'
import { retrieveOfficialSource, nodeSourceFetch } from '../../src/lib/serverSourceRetrieval.js'
import { nodeHostResolver } from '../_lib/nodeHostResolver.js'

// ─── Server-side regulatory feed retrieval Vercel Function ──────────────────
//
// A thin adapter: reads server-only environment variables, wires the Supabase
// auth/authorisation dependencies and the SSRF-guarded retriever, then delegates
// ALL request handling to the pure, mock-tested core
// (src/lib/serverFeedRetrieval.ts). No secret is logged, returned or committed.
//
// WHY THIS FUNCTION EXISTS
// `src/lib/browserRssFetch.ts` cannot reach any registered feed and never could.
// Measured 2026-07-28 and re-measured 2026-08-02: neither of the two feed-
// modality sources sends an `Access-Control-Allow-Origin` header, and the
// deployed CSP (`connect-src 'self' <supabase>`) refuses the request before CORS
// is consulted. Widening the CSP is not the fix — administrators register feed
// URLs at runtime and a static header cannot enumerate them. This function is
// the server-side path that decision deferred to.
//
// Credentials come from server-only env vars — never a VITE_-prefixed value:
//   SUPABASE_URL, SUPABASE_ANON_KEY   — verify the caller's token and read their
//                                       own profile row + the source (RLS).
//   SUPABASE_SERVICE_ROLE_KEY         — the throttle reservation, and NOTHING
//                                       else (see below).

interface VercelRequestLike {
  method?: string
  headers: Record<string, string | string[] | undefined>
  body?: unknown
}
interface VercelResponseLike {
  status(code: number): VercelResponseLike
  json(body: unknown): void
}

function headerValue(v: string | string[] | undefined): string | null {
  if (Array.isArray(v)) return v[0] ?? null
  return v ?? null
}

/**
 * The per-admin bucket key.
 *
 * The user id is hashed rather than stored, for the reason given in
 * api/compliance/ai-summary.ts: `public_intake_attempts` is a throttle ledger,
 * not an audit trail, and it should not become a second record of which
 * administrator did what and when. The salt is shared with the intake and the
 * AI summariser because it is the same class of value; the PREFIX is what makes
 * the buckets disjoint. See serverFeedRetrievalThrottle.ts.
 */
function feedBucketKeyFor(userId: string, salt: string): string {
  return feedRetrievalClientBucketKey(createHash('sha256').update(`${userId}:${salt}`).digest('hex'))
}

// The outbound User-Agent is NOT set here. retrieveOfficialSource already sends
// an honest, credential-free identifier ('DDP-Compliance-Watchtower/1.0'), and
// having a second one in this adapter would mean two places to change and one
// of them silently losing.

function buildDeps(): ServerFeedRetrievalDeps | null {
  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY
  if (!supabaseUrl || !supabaseAnonKey) return null

  // THE THROTTLE NEEDS A PRIVILEGE THE CALLER MUST NOT HAVE.
  //
  // Migration 36 revokes EXECUTE on reserve_public_intake_slot from `anon` and
  // `authenticated` precisely so a client cannot reserve, inspect or exhaust
  // slots itself. The narrowing that keeps the endpoint's RLS story intact: the
  // service-role client below is used for the throttle reservation and NOTHING
  // else. Every read of actual data — the caller's identity, their profile role,
  // and the regulatory source row — goes through the caller-bound client under
  // the caller's own RLS.
  //
  // Absent key => buildDeps returns null => 503 server_misconfigured. Fail-closed
  // by design: an endpoint that cannot enforce its ceiling must not serve.
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceRoleKey) return null

  const throttleClient: SupabaseClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const throttleSalt = process.env.PUBLIC_INTAKE_IP_SALT || supabaseUrl

  // Request-scoped client bound to the caller's token so RLS restricts every
  // read to what the caller may see. Set during authenticate, reused after.
  let sessionClient: SupabaseClient | null = null

  return {
    authenticate: async (accessToken) => {
      sessionClient = createClient(supabaseUrl, supabaseAnonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { Authorization: `Bearer ${accessToken}` } },
      })
      const { data, error } = await sessionClient.auth.getUser(accessToken)
      if (error || !data.user) return null
      return { userId: data.user.id }
    },
    getProfileRole: async (userId) => {
      if (!sessionClient) return null
      const { data, error } = await sessionClient
        .from('profiles')
        .select('role')
        .eq('id', userId)
        .single()
      if (error || !data) return null
      return typeof data.role === 'string' ? data.role : null
    },
    // The authoritative target read. Same caller-bound client, so the row is
    // fetched under the caller's own RLS. A caller who cannot see the row gets
    // `unknown_source`, the correct answer for both "does not exist" and
    // "not yours".
    getRegulatorySource: async (sourceId) => {
      if (!sessionClient) return null
      const { data, error } = await sessionClient
        .from('regulatory_sources')
        .select('id, name, jurisdiction, source_type, url, is_active, monitoring_method')
        .eq('id', sourceId)
        .maybeSingle()
      if (error || !data) return null
      return {
        id: String(data.id),
        name: String(data.name ?? ''),
        jurisdiction: String(data.jurisdiction ?? ''),
        sourceType: String(data.source_type ?? ''),
        url: String(data.url ?? ''),
        isActive: data.is_active === true,
        monitoringMethod: (data.monitoring_method ?? null) as RegulatorySource['monitoringMethod'],
        createdAt: '',
        updatedAt: '',
      }
    },
    reserveFeedRetrievalSlot: async (userId) => {
      const { data, error } = await throttleClient.rpc('reserve_public_intake_slot', {
        p_client_key: feedBucketKeyFor(userId, throttleSalt),
        p_global_key: FEED_RETRIEVAL_GLOBAL_BUCKET_KEY,
        p_rules: FEED_RETRIEVAL_THROTTLE_RULES,
      })
      // THROW, never return allowed:true. The core turns a throw into a
      // fail-closed 503; returning "allowed" here would make an unreachable
      // ledger indistinguishable from an empty one.
      if (error || !data) throw new Error('throttle_unavailable')
      const result = data as { allowed: boolean; windowSeconds?: number }
      return { allowed: result.allowed, windowSeconds: result.windowSeconds }
    },
    // The real retriever, with the Node DNS resolver supplied so the SSRF guard
    // checks RESOLVED addresses and not merely the hostname. Without the
    // resolver an allowlisted name that resolves to 169.254.169.254 would pass
    // the name-based check — the resolver is what makes the guard more than
    // advisory.
    retrieve: ({ url, allowedHosts, retrievedAt }) =>
      retrieveOfficialSource({
        url,
        policy: { allowedHosts },
        retrievedAt,
        fetchImpl: nodeSourceFetch,
        resolveHost: nodeHostResolver,
      }),
    now: () => new Date().toISOString(),
  }
}

export default async function handler(req: VercelRequestLike, res: VercelResponseLike): Promise<void> {
  const requestId = newRequestId()
  const method = req.method ?? 'GET'

  try {
    const normalized: NormalizedRequest = {
      method,
      contentType: headerValue(req.headers['content-type']),
      authorization: headerValue(req.headers['authorization']),
      body: req.body,
    }

    const result = await runFeedRetrieveEndpoint(normalized, buildDeps(), requestId)
    res.status(result.status).json(result.body)
  } catch {
    // Backstop: reached only if buildDeps() or the response write itself throws.
    logServerError({
      event: 'api_error',
      requestId,
      category: 'internal_error',
      status: 500,
      method,
      route: FEED_RETRIEVE_ROUTE,
    })
    res.status(500).json({ ok: false, error: 'internal_error', message: 'An unexpected error occurred.', requestId })
  }
}
