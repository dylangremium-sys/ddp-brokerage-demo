import { createHash } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createCoaExtractionProvider } from '../../src/lib/serverCoaProvider.js'
import {
  handleCoaExtractRequest,
  type CoaExtractionDeps,
} from '../../src/lib/serverCoaExtraction.js'
import {
  COA_EXTRACTION_GLOBAL_BUCKET_KEY,
  COA_EXTRACTION_THROTTLE_RULES,
  coaExtractionClientBucketKey,
} from '../../src/lib/serverCoaExtractionThrottle.js'

// ─── DDP admin COA extraction Vercel Function ──────────────────────────────
//
// Thin adapter: it reads SERVER-ONLY environment variables, wires the Supabase
// clients and the Anthropic API key, and delegates all authorization and
// business logic to the pure, mock-tested core
// (src/lib/serverCoaExtraction.ts).
//
// UNBUNDLED ESM: Vercel's api/ directory is unbundled Node ESM. Relative
// imports MUST have the .js extension or they ship a dead endpoint.
//
// ─── THE SURFACE THIS ENDPOINT READS, AND WHY IT CHANGED ────────────────────
//
// This adapter previously read `public.documents` and downloaded from a storage
// bucket called `documents`. The columns it selected were wrong and the bucket
// does not exist:
//
//   • `public.documents` is (id, farm_id, inventory_batch_id, document_type,
//     file_name, file_url, expiry_date, review_status, reviewer_note,
//     created_at, updated_at). The adapter asked for `fileName`, `storagePath`
//     and `sha256Hex` — camelCase against a snake_case table, and the last two
//     do not exist under any spelling.
//   • The storage buckets that exist are `farmer-documents`, `farmer-photos`
//     and `evidence-request-files` (migrations 8, 24 and 37). There has never
//     been a `documents` bucket, so every download would have failed.
//   • `sha256Hex` has no column on `public.documents`, which is what left the
//     digest de-duplication with no backing store.
//
// It now reads `public.farmer_documents`, which is where a farmer's uploaded COA
// actually lands, and which migration 28 gave `sha256_hex` and
// `sha256_recorded_at` precisely so a document could be recognised as one
// already seen. The matching bucket is `farmer-documents`, created and forced
// private by migration 37. Extraction rows are written against migration 28's
// `farmer_document` surface, whose foreign key points at this table.

interface VercelRequestLike {
  method?: string
  headers: Record<string, string | string[] | undefined>
  body?: unknown
}
interface VercelResponseLike {
  status(code: number): VercelResponseLike
  json(body: unknown): void
}

/** The private bucket holding farmer uploads. Migration 37 forces public=false. */
const FARMER_DOCUMENTS_BUCKET = 'farmer-documents'

function headerValue(v: string | string[] | undefined): string | null {
  if (Array.isArray(v)) return v[0] ?? null
  return v ?? null
}

function bearerToken(authorization: string | null): string | null {
  if (!authorization) return null
  const m = /^Bearer\s+(.+)$/i.exec(authorization.trim())
  const t = m?.[1]?.trim()
  return t ? t : null
}

/**
 * The per-admin throttle bucket key.
 *
 * The user id is hashed rather than stored: `public_intake_attempts` is a
 * throttle ledger, not an audit trail, and it should not become a second record
 * of which administrator did what and when. The salt reuses the intake's;
 * falling back to the project URL keeps the hash salted rather than raw if the
 * dedicated variable was never set.
 */
function coaBucketKeyFor(userId: string, salt: string): string {
  return coaExtractionClientBucketKey(createHash('sha256').update(`${userId}:${salt}`).digest('hex'))
}

function buildDeps(accessToken: string | null): CoaExtractionDeps | null {
  const url = process.env.SUPABASE_URL
  const anonKey = process.env.SUPABASE_ANON_KEY
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const anthropicKey = process.env.ANTHROPIC_API_KEY

  if (!url || !anonKey || !serviceRoleKey || !anthropicKey) return null
  if (!accessToken) return null

  // ── The caller-bound client ───────────────────────────────────────────────
  //
  // Carries the caller's JWT, so every read runs under the caller's own RLS and
  // — decisively — `auth.uid()` resolves to the caller inside SECURITY DEFINER
  // functions. Migration 28's `record_document_field_extraction` gates on
  // `is_ddp_admin()`, which is `EXISTS (SELECT 1 FROM profiles WHERE id =
  // auth.uid() AND role = 'ddp_admin')`. Under a service-role connection
  // `auth.uid()` is NULL, no row matches, and the write is refused with
  // `insufficient_privilege`. The write CANNOT be performed by a server
  // identity, by construction — that is the design working, not an obstacle to
  // route around.
  const session: SupabaseClient = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  })

  // ── The service-role client, used for exactly two things ──────────────────
  //
  // 1. The throttle reservation. Migration 36 revokes EXECUTE on
  //    `reserve_public_intake_slot` from `anon` and `authenticated` precisely so
  //    a client cannot reserve, inspect or exhaust slots itself. A spend ceiling
  //    the caller can bypass is not a ceiling.
  //
  // 2. Downloading the PDF bytes from the private bucket. `farmer-documents` is
  //    private (migration 37) and its object policies are written for the
  //    farmer-facing paths; an admin back-office read does not correspond to
  //    one of them.
  //
  // Widening this client beyond those two uses would silently convert an
  // RLS-enforced endpoint into an RLS-bypassing one. In particular the document
  // row itself is read through `session`, so a caller who cannot see a document
  // gets `document_not_found` rather than somebody else's certificate.
  const privileged: SupabaseClient = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const throttleSalt = process.env.PUBLIC_INTAKE_IP_SALT || url

  const provider = createCoaExtractionProvider({
    apiKey: anthropicKey,
    model: process.env.COA_EXTRACTION_MODEL || 'claude-opus-5',
  })

  return {
    authenticate: async (token) => {
      const { data, error } = await session.auth.getUser(token)
      if (error || !data.user) return null
      return { userId: data.user.id }
    },

    getProfileRole: async (userId) => {
      const { data, error } = await session
        .from('profiles')
        .select('role')
        .eq('id', userId)
        .maybeSingle()
      if (error || !data) return null
      return typeof data.role === 'string' ? data.role : null
    },

    // Read under the CALLER's RLS, snake_case, and only columns that exist.
    //
    // `file_url` holds the storage path. It is nullable on this table ("NULL
    // until Supabase Storage is configured", FARMER_MVP_MIGRATION.sql), and a
    // row without one has no bytes to read — so it is reported as not-found
    // rather than passed to storage as the string "null", which the bucket
    // would 404 on with a far less obvious message.
    getDocument: async (documentId) => {
      const { data, error } = await session
        .from('farmer_documents')
        .select('id, file_name, file_url, sha256_hex')
        .eq('id', documentId)
        .maybeSingle()
      if (error || !data) return null
      if (typeof data.file_url !== 'string' || data.file_url.trim() === '') return null
      return {
        id: String(data.id),
        surface: 'farmer_document' as const,
        fileName: String(data.file_name ?? ''),
        storagePath: data.file_url,
        sha256Hex: typeof data.sha256_hex === 'string' ? data.sha256_hex : null,
      }
    },

    fetchDocumentBytes: async (storagePath) => {
      const { data, error } = await privileged.storage
        .from(FARMER_DOCUMENTS_BUCKET)
        .download(storagePath)
      if (error || !data) throw error ?? new Error('coa_extract_document_unreadable')
      return new Uint8Array(await data.arrayBuffer())
    },

    extract: provider,

    // One round trip; the reservation and the limit check happen inside a single
    // SQL function under an advisory transaction lock, so concurrent invocations
    // on separate serverless instances cannot all pass the check before any of
    // them writes. The rules are passed in because the application owns the
    // policy and the function owns only the atomicity.
    reserveExtractionSlot: async (userId) => {
      const { data, error } = await privileged.rpc('reserve_public_intake_slot', {
        p_client_key: coaBucketKeyFor(userId, throttleSalt),
        p_global_key: COA_EXTRACTION_GLOBAL_BUCKET_KEY,
        p_rules: COA_EXTRACTION_THROTTLE_RULES,
      })
      // THROW, never return allowed:true. The core turns a throw into a
      // fail-closed 503; returning "allowed" here would make an unreachable
      // ledger indistinguishable from an empty one, which is the single failure
      // mode that would restore unbounded spending.
      if (error || !data) throw new Error('throttle_unavailable')
      const result = data as { allowed: boolean; windowSeconds?: number }
      return { allowed: result.allowed, windowSeconds: result.windowSeconds }
    },

    // ── The write ────────────────────────────────────────────────────────────
    //
    // ONE call, on the caller's own connection, through migration 53's batch
    // RPC. Direct DML is not a shortcut being declined — it is unavailable:
    // migration 28 §3.8 does `REVOKE ALL ON public.document_field_extractions
    // FROM PUBLIC, anon, authenticated, service_role` and grants only SELECT, so
    // an `.insert()` fails for every role this endpoint could use.
    //
    // WHY NOT THE SINGLE-ROW FUNCTION IN A LOOP, WHICH IS WHAT THIS WAS.
    // PostgREST gives every `rpc()` call its own transaction. A per-row loop
    // therefore had two faults with one cause:
    //
    //   • A pack failing on its fourteenth row left thirteen rows committed
    //     while this endpoint answered 503 and told the caller nothing had been
    //     recorded — false, and false in the direction that matters.
    //   • A five-report pack is up to ~95 rows and so was up to ~95 sequential
    //     round trips. Extraction alone has been measured at 70-95 seconds
    //     against a 90-second function limit, so the write was pushing an
    //     already-intermittent timeout over the edge — and a timeout mid-pack
    //     produced exactly the partial write above.
    //
    // One call fixes both. The function validates every element before
    // inserting any, so a malformed pack is refused whole, and the insert is a
    // single statement, so PostgreSQL's own transaction boundary guarantees
    // all-or-nothing. Proven by 53_COA_BATCH_EXTRACTION_WRITE_VERIFY section C,
    // which fails a pack on its LAST element and asserts zero rows survive.
    persistExtractions: async (document, rows) => {
      const { data, error } = await session.rpc('record_document_field_extractions_batch', {
        p_document_surface: document.surface,
        p_document_id: document.id,
        p_rows: rows.map(({ reportOrdinal, reportLabel, row }) => ({
          field_name: row.field_name,
          field_value_text: row.field_value_text,
          provenance: row.provenance,
          confidence: row.confidence,
          extraction_warning: row.extraction_warning,
          report_ordinal: reportOrdinal,
          report_label: reportLabel,
        })),
      })

      if (error) {
        // Not returned to the caller — the core catches this and answers with a
        // fixed string. It names the document so a server log can find the pack.
        throw new Error(
          `coa_extract_persist_failed: document=${document.id} rows=${rows.length}: ${error.message}`,
        )
      }

      // The function returns the number of rows it wrote and raises rather than
      // reporting a partial write, so a mismatch here should be unreachable.
      // Checked anyway: this is the last point at which "the endpoint said it
      // saved the extraction" can still be made false, and an unreachable branch
      // costs nothing next to repeating the PR #97 failure in a new place.
      if (typeof data !== 'number' || data !== rows.length) {
        throw new Error(
          `coa_extract_persist_count_mismatch: document=${document.id} ` +
            `wrote=${String(data)} expected=${rows.length}`,
        )
      }
    },

    countExistingExtractions: async (documentId) => {
      const { count, error } = await session
        .from('document_field_extractions')
        .select('id', { count: 'exact', head: true })
        .eq('farmer_document_id', documentId)
      if (error) throw error
      return count ?? 0
    },
  }
}

export default async function handler(req: VercelRequestLike, res: VercelResponseLike): Promise<void> {
  // The token is needed to BUILD the deps, because the caller-bound client is
  // what makes the write attributable. The core still performs the real
  // authentication and authorisation gates; this only shapes the clients.
  const authorization = headerValue(req.headers['authorization'] ?? req.headers['Authorization'])
  const deps = buildDeps(bearerToken(authorization))

  if (!deps) {
    // Covers both a missing environment variable and a request with no bearer
    // token. The core would answer 401 for the latter, so the distinction is
    // preserved here rather than collapsing both into a 500 that blames the
    // server for a client's missing header.
    if (!bearerToken(authorization)) {
      res.status(401).json({
        ok: false,
        error: 'unauthenticated',
        message: 'A bearer access token is required.',
      })
      return
    }
    res.status(500).json({ ok: false, error: 'COA extraction endpoint is not configured.' })
    return
  }

  const outcome = await handleCoaExtractRequest(
    {
      method: req.method || 'GET',
      contentType: headerValue(req.headers['content-type'] ?? req.headers['Content-Type']),
      authorization,
      body: req.body,
    },
    deps,
  )

  res.status(outcome.status).json(outcome.body)
}
