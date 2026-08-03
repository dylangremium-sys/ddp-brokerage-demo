import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createCoaExtractionProvider } from '../../src/lib/serverCoaProvider.js'
import {
  handleCoaExtractRequest,
  type CoaExtractionDeps,
} from '../../src/lib/serverCoaExtraction.js'

// ─── DDP admin COA extraction Vercel Function ──────────────────────────────
//
// Thin adapter: it reads SERVER-ONLY environment variables, wires a
// service-role Supabase client and the Anthropic API key, and delegates all
// authorization and business logic to the pure, mock-tested core
// (src/lib/serverCoaExtraction.ts).
//
// UNBUNDLED ESM: Vercel's api/ directory is unbundled Node ESM. Relative
// imports MUST have the .js extension or they ship a dead endpoint.

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

function buildDeps(): CoaExtractionDeps | null {
  const url = process.env.SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const anthropicKey = process.env.ANTHROPIC_API_KEY

  if (!url || !serviceRoleKey || !anthropicKey) return null

  const admin: SupabaseClient = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const provider = createCoaExtractionProvider({
    apiKey: anthropicKey,
    model: 'claude-opus-5',
  })

  return {
    authenticate: async (token) => {
      const { data, error } = await admin.auth.getUser(token)
      if (error || !data.user) return null
      return { userId: data.user.id }
    },

    getProfileRole: async (userId) => {
      const { data, error } = await admin
        .from('profiles')
        .select('role')
        .eq('id', userId)
        .maybeSingle()
      if (error || !data) return null
      return typeof data.role === 'string' ? data.role : null
    },

    getDocument: async (documentId) => {
      const { data, error } = await admin
        .from('documents')
        .select('id, fileName, storagePath, sha256Hex')
        .eq('id', documentId)
        .maybeSingle()
      if (error || !data) return null
      return {
        id: data.id,
        fileName: data.fileName,
        storagePath: data.storagePath,
        sha256Hex: data.sha256Hex,
      }
    },

    fetchDocumentBytes: async (storagePath) => {
      const { data, error } = await admin.storage.from('documents').download(storagePath)
      if (error || !data) throw error
      return new Uint8Array(await data.arrayBuffer())
    },

    extract: provider,

    // NOT IMPLEMENTED — both of these fail closed on purpose.
    //
    // A stub that returns success is worse than no stub at all. `allowed: true`
    // silently disables the spend ceiling that serverCoaExtraction.ts's 17 tests
    // cover, and a persist that returns without writing makes the endpoint
    // report success while saving nothing — the same defect that discarded
    // farmer photos until PR #97. Neither is safe the moment a key is
    // configured, so neither may pretend to work.
    reserveExtractionSlot: async () => {
      throw new Error('coa_extract_not_implemented_spend_ceiling')
    },

    persistExtractions: async () => {
      throw new Error('coa_extract_not_implemented_persistence')
    },

    countExistingExtractions: async (documentId) => {
      const { count, error } = await admin
        .from('document_field_extractions')
        .select('id', { count: 'exact', head: true })
        .eq('document_id', documentId)
      if (error) throw error
      return count ?? 0
    },
  }
}

export default async function handler(req: VercelRequestLike, res: VercelResponseLike): Promise<void> {
  const deps = buildDeps()
  if (!deps) {
    res.status(500).json({ ok: false, error: 'COA extraction endpoint is not configured.' })
    return
  }

  const outcome = await handleCoaExtractRequest(
    {
      method: req.method || 'GET',
      contentType: headerValue(req.headers['content-type'] ?? req.headers['Content-Type']),
      authorization: headerValue(req.headers['authorization'] ?? req.headers['Authorization']),
      body: req.body,
    },
    deps,
  )

  res.status(outcome.status).json(outcome.body)
}
