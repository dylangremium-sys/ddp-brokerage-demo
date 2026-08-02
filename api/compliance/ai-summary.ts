import { createHash } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { LegalUpdate } from '../../src/types.js'
import {
  AI_SUMMARY_GLOBAL_BUCKET_KEY,
  AI_SUMMARY_THROTTLE_RULES,
  aiSummaryClientBucketKey,
} from '../../src/lib/serverAiSummaryThrottle.js'
import type { NormalizedRequest, ServerAiSummaryDeps } from '../../src/lib/serverAiSummary.js'
import { AI_SUMMARY_ROUTE, runAiSummaryEndpoint } from '../../src/lib/serverAiSummaryEndpoint.js'
import { logServerError, newRequestId } from '../../src/lib/observability.js'
import { createServerAiSummaryProvider } from '../../src/lib/serverAiProvider.js'
import type { ComplianceAiSummaryProvider } from '../../src/lib/aiComplianceProvider.js'

// ─── Secure server-side AI draft-summary Vercel Function (Phase 2I) ─────────
//
// A thin adapter: it reads server-only environment variables, wires the
// Supabase auth/authorisation dependencies and the server AI provider, then
// delegates ALL request handling to the pure, mock-tested core
// (src/lib/serverAiSummary.ts). No secret is logged, returned, or committed.
// Credentials come from server-only env vars — never a VITE_-prefixed value:
//   SUPABASE_URL, SUPABASE_ANON_KEY  — verify the caller's token + read their
//                                      own profile row (RLS enforced).
//   ANTHROPIC_API_KEY, AI_SUMMARY_MODEL — the AI provider (fail closed to a
//                                      provider_unconfigured result if absent).

// Minimal request/response shapes — avoids adding an @vercel/node dependency.
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
 * The user id is hashed rather than stored: `public_intake_attempts` is a
 * throttle ledger, not an audit trail, and it should not become a second record
 * of which administrator did what and when. The salt reuses the intake's, since
 * both are the same class of value; falling back to the project URL keeps the
 * hash salted rather than raw if the dedicated variable was never set — a
 * forgotten env var should degrade the property, not remove it.
 *
 * The prefix is what guarantees this cannot collide with an intake bucket. See
 * serverAiSummaryThrottle.ts.
 */
function aiBucketKeyFor(userId: string, salt: string): string {
  return aiSummaryClientBucketKey(createHash('sha256').update(`${userId}:${salt}`).digest('hex'))
}

function buildDeps(): ServerAiSummaryDeps | null {
  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY
  if (!supabaseUrl || !supabaseAnonKey) return null

  // THE THROTTLE NEEDS A PRIVILEGE THE CALLER MUST NOT HAVE.
  //
  // This file previously stated, accurately, that "no service-role key is ever
  // used". That property is weakened here, and only here, on purpose: a spend
  // ceiling the caller can bypass is not a ceiling, and migration 36 revokes
  // EXECUTE on reserve_public_intake_slot from `anon` and `authenticated`
  // precisely so a client cannot reserve, inspect or exhaust slots itself.
  //
  // The narrowing that keeps the original property meaningful: the service-role
  // client below is used for the throttle reservation and NOTHING else. Every
  // read of actual data — the caller's identity, their profile role, and the
  // legal update itself — still goes through the caller-bound client under the
  // caller's own RLS. Widening this client's use would silently turn an
  // RLS-enforced endpoint into an RLS-bypassing one.
  //
  // Absent key => buildDeps returns null => 503 server_misconfigured. That is
  // fail-closed by design: an endpoint that cannot enforce its spend ceiling
  // must not serve. It also means SUPABASE_SERVICE_ROLE_KEY is now REQUIRED in
  // any environment where this endpoint is expected to answer.
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceRoleKey) return null

  const throttleClient: SupabaseClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const throttleSalt = process.env.PUBLIC_INTAKE_IP_SALT || supabaseUrl

  const anthropicKey = process.env.ANTHROPIC_API_KEY
  const model = process.env.AI_SUMMARY_MODEL || 'claude-opus-5'
  const provider: ComplianceAiSummaryProvider | null = anthropicKey
    ? createServerAiSummaryProvider({
        apiKey: anthropicKey,
        model,
        baseUrl: process.env.AI_SUMMARY_BASE_URL,
        anthropicVersion: process.env.ANTHROPIC_VERSION,
      })
    : null

  // Request-scoped client bound to the caller's token so RLS restricts every
  // read to the caller's own rows. Set during authenticate, reused for the role
  // lookup — no service-role key is ever used.
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
    // The authoritative evidence read. Uses the SAME caller-bound client as the
    // role lookup, so the row is fetched under the caller's own RLS — the
    // `legal_updates: admin all` policy is what permits it, and no service-role
    // key is introduced. A caller who cannot see the row gets `missing_update`,
    // which is the correct answer for both "does not exist" and "not yours".
    getLegalUpdate: async (legalUpdateId) => {
      if (!sessionClient) return null
      const { data, error } = await sessionClient
        .from('legal_updates')
        // reviewer_notes is selected because buildAiSummaryRequest recovers the
        // provenance checksum from it. Dropping the column would silently make
        // provenanceChecksum null on every request — the checksum would come
        // from nowhere instead of from the record, which is the opposite of
        // what reading the stored row is for.
        .select('id, title, jurisdiction, source_name, source_url, published_at, raw_text, status, reviewer_notes')
        .eq('id', legalUpdateId)
        .maybeSingle()
      if (error || !data) return null
      return {
        id: String(data.id),
        sourceId: null,
        title: String(data.title ?? ''),
        jurisdiction: String(data.jurisdiction ?? ''),
        sourceName: String(data.source_name ?? ''),
        sourceUrl: String(data.source_url ?? ''),
        publishedAt: data.published_at ? String(data.published_at) : null,
        detectedAt: '',
        rawText: String(data.raw_text ?? ''),
        summary: '',
        affectedAreas: [],
        aiRiskLevel: null,
        status: data.status as LegalUpdate['status'],
        reviewerNotes: String(data.reviewer_notes ?? ''),
        createdAt: '',
        updatedAt: '',
      }
    },
    // One round trip; the reservation and the limit check happen inside a single
    // SQL function under an advisory transaction lock, so concurrent invocations
    // on separate serverless instances cannot all pass the check before any of
    // them writes. The rules are passed in because the application owns the
    // policy and the function owns only the atomicity.
    reserveAiSummarySlot: async (userId) => {
      const { data, error } = await throttleClient.rpc('reserve_public_intake_slot', {
        p_client_key: aiBucketKeyFor(userId, throttleSalt),
        p_global_key: AI_SUMMARY_GLOBAL_BUCKET_KEY,
        p_rules: AI_SUMMARY_THROTTLE_RULES,
      })
      // THROW, never return allowed:true. The core turns a throw into a
      // fail-closed 503; returning "allowed" here would make an unreachable
      // ledger indistinguishable from an empty one, which is the single failure
      // mode that would restore unbounded spending.
      if (error || !data) throw new Error('throttle_unavailable')
      const result = data as { allowed: boolean; windowSeconds?: number }
      return { allowed: result.allowed, windowSeconds: result.windowSeconds }
    },
    provider,
  }
}

export default async function handler(req: VercelRequestLike, res: VercelResponseLike): Promise<void> {
  // One correlation ID per request, generated before anything can fail, so that
  // even a fault inside buildDeps() is reportable. It is echoed to the caller in
  // every failure response and appears in the matching log line — that pairing is
  // the whole point: a user can quote the ID and we can find the event.
  const requestId = newRequestId()

  const method = req.method ?? 'GET'

  try {
    const normalized: NormalizedRequest = {
      method,
      contentType: headerValue(req.headers['content-type']),
      authorization: headerValue(req.headers['authorization']),
      body: req.body,
    }

    const result = await runAiSummaryEndpoint(normalized, buildDeps(), requestId)
    res.status(result.status).json(result.body)
  } catch {
    // Backstop: reached only if buildDeps() or the response write itself throws.
    // The exception is never logged, inspected or surfaced — it is the object most
    // likely to carry a token, a prompt or vendor text. Only safe codes escape.
    logServerError({
      event: 'api_error',
      requestId,
      category: 'internal_error',
      status: 500,
      method,
      route: AI_SUMMARY_ROUTE,
    })
    res.status(500).json({ ok: false, error: 'internal_error', message: 'An unexpected error occurred.', requestId })
  }
}
