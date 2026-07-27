import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  SOURCE_RETRIEVE_ROUTE,
  handleSourceRetrieveRequest,
  type NormalizedRequest,
  type ServerCoaReviewDeps,
} from '../../src/lib/serverCoaReview.js'
import { createCoaReviewSupabaseRepository } from '../../src/lib/coaReviewSupabaseRepository.js'
import { unpdfTextExtractor } from '../../src/lib/unpdfExtractor.js'
import { logServerError, newRequestId } from '../../src/lib/observability.js'

// ─── Official-source retrieval Vercel Function (Gate P0 — issue #77) ────────
//
// Performs the FRESH, server-side retrieval of the configured official
// authority source, persists the retrieved version (or the failure), and binds
// a preliminary suggestion to it — or refuses to create one.
//
// It must run server-side. The previous connector could only fetch from the
// browser, where CORS blocks regulatory sites and the result carries no
// trustworthy provenance. Here the request passes through the reused SSRF and
// allowlist controls, with every redirect hop revalidated.
//
// The COA is never sent anywhere: this endpoint takes only a coaDocumentId, and
// the outbound request is a credential-free GET to a fixed allowlisted host.

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
    // Unused on this route, but the dependency shape is shared with extraction.
    pdfExtractor: unpdfTextExtractor,
    // fetchImpl omitted: the core defaults to the real server-side fetcher.
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
        status: 500, method, route: SOURCE_RETRIEVE_ROUTE,
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

    const result = await handleSourceRetrieveRequest(normalized, deps, requestId)
    res.status(result.status).json(result.body)
  } catch {
    logServerError({
      event: 'api_error', requestId, category: 'internal_error',
      status: 500, method, route: SOURCE_RETRIEVE_ROUTE,
    })
    res.status(500).json({ ok: false, error: 'internal_error', message: 'An unexpected error occurred.', requestId })
  }
}
