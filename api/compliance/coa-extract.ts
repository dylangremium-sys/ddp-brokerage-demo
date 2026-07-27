import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  COA_EXTRACT_ROUTE,
  handleCoaExtractRequest,
  type NormalizedRequest,
  type ServerCoaReviewDeps,
} from '../../src/lib/serverCoaReview.js'
import { createCoaReviewSupabaseRepository } from '../../src/lib/coaReviewSupabaseRepository.js'
import { unpdfTextExtractor } from '../../src/lib/unpdfExtractor.js'
import { logServerError, newRequestId } from '../../src/lib/observability.js'

// ─── Server-side COA extraction Vercel Function (Gate P0 — issue #77) ───────
//
// A thin adapter, matching api/compliance/ai-summary.ts: it reads server-only
// environment variables, wires the Supabase auth/authorisation dependencies and
// the PDF engine, then delegates ALL request handling to the pure, mock-tested
// core (src/lib/serverCoaReview.ts).
//
// This is where the supplied COA's bytes are read. They are parsed in memory,
// fingerprinted, and discarded — never written to disk, never logged, never
// returned to the client. Only extracted fields travel back.
//
// Credentials come from server-only env vars, never a VITE_-prefixed value:
//   SUPABASE_URL, SUPABASE_ANON_KEY — verify the caller's token and read their
//                                     own profile row (RLS enforced).
// No service-role key is used anywhere in this path.

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

function buildDeps(): ServerCoaReviewDeps | null {
  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY
  if (!supabaseUrl || !supabaseAnonKey) return null

  // Request-scoped client bound to the caller's token so RLS restricts every
  // read and write to what that administrator may do. Set during authenticate
  // and reused for the role lookup and all persistence.
  let sessionClient: SupabaseClient | null = null
  let userId: string | null = null

  return {
    authenticate: async (accessToken) => {
      sessionClient = createClient(supabaseUrl, supabaseAnonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { Authorization: `Bearer ${accessToken}` } },
      })
      const { data, error } = await sessionClient.auth.getUser(accessToken)
      if (error || !data.user) return null
      userId = data.user.id
      return { userId: data.user.id }
    },
    getProfileRole: async (id) => {
      if (!sessionClient) return null
      const { data, error } = await sessionClient.from('profiles').select('role').eq('id', id).single()
      if (error || !data) return null
      return typeof data.role === 'string' ? data.role : null
    },
    get repository() {
      if (!sessionClient) throw new Error('repository requested before authentication')
      return createCoaReviewSupabaseRepository(sessionClient, userId)
    },
    pdfExtractor: unpdfTextExtractor,
    now: () => new Date().toISOString(),
  } as ServerCoaReviewDeps
}

export default async function handler(req: VercelRequestLike, res: VercelResponseLike): Promise<void> {
  const requestId = newRequestId()
  const method = req.method ?? 'GET'

  try {
    const deps = buildDeps()
    if (!deps) {
      logServerError({
        event: 'api_error', requestId, category: 'misconfigured',
        status: 500, method, route: COA_EXTRACT_ROUTE,
      })
      res.status(500).json({ ok: false, error: 'misconfigured', message: 'The service is not configured.', requestId })
      return
    }

    const normalized: NormalizedRequest = {
      method,
      contentType: headerValue(req.headers['content-type']),
      authorization: headerValue(req.headers['authorization']),
      body: req.body,
    }

    const result = await handleCoaExtractRequest(normalized, deps, requestId)
    res.status(result.status).json(result.body)
  } catch {
    // The exception is never logged or surfaced: for a malformed PDF it can
    // embed fragments of the document, which is private evidence.
    logServerError({
      event: 'api_error', requestId, category: 'internal_error',
      status: 500, method, route: COA_EXTRACT_ROUTE,
    })
    res.status(500).json({ ok: false, error: 'internal_error', message: 'An unexpected error occurred.', requestId })
  }
}
