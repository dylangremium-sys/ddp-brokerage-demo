// ─── api/ adapter check over real HTTP (Gate P0 — issue #77) ────────────────
//
// The Vercel Functions in api/ are thin, but "thin" is not "correct": they own
// env wiring, header parsing, the JSON body, and the fail-closed
// misconfiguration path. Nothing else exercises them — api/ is outside the
// vitest include glob — so this test imports the ACTUAL handler modules, mounts
// them on a real node:http server, and drives them with real requests.
//
// Skipped unless DDP_STAGING_E2E=1 (it authenticates against staging).
//
//   set -a && . ./.env.staging && set +a
//   DDP_STAGING_E2E=1 DDP_COA_PDF_PATH="…/1_Mango.pdf" npm test -- coaApiHandler

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFile } from 'node:fs/promises'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { createClient } from '@supabase/supabase-js'
import coaExtractHandler from '../../api/compliance/coa-extract.js'
import sourceRetrieveHandler from '../../api/compliance/source-retrieve.js'

const enabled = process.env.DDP_STAGING_E2E === '1'
const pdfPath = process.env.DDP_COA_PDF_PATH
const supabaseUrl = process.env.STAGING_SUPABASE_URL ?? ''
const anonKey = process.env.STAGING_SUPABASE_ANON_KEY ?? ''
const adminEmail = process.env.STAGING_ADMIN_EMAIL ?? ''
const adminPassword = process.env.STAGING_ADMIN_PASSWORD ?? ''
const farmerEmail = process.env.STAGING_FARMER_A_EMAIL ?? ''
const farmerPassword = process.env.STAGING_FARMER_A_PASSWORD ?? ''

const ready = enabled && !!(pdfPath && supabaseUrl && anonKey && adminEmail && adminPassword)

type Handler = (req: unknown, res: unknown) => Promise<void>

/** Mount the Vercel-shaped handlers behind a real HTTP server. */
function mount(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: unknown = raw
      try { body = raw ? JSON.parse(raw) : undefined } catch { /* leave as text */ }

      const handler: Handler = req.url?.includes('source-retrieve')
        ? (sourceRetrieveHandler as unknown as Handler)
        : (coaExtractHandler as unknown as Handler)

      const vercelRes = {
        status(code: number) {
          res.statusCode = code
          return vercelRes
        },
        json(payload: unknown) {
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify(payload))
        },
      }

      void handler({ method: req.method, headers: req.headers, body }, vercelRes).catch(() => {
        res.statusCode = 500
        res.end('{"ok":false,"error":"harness_failure"}')
      })
    })
  })
}

async function signIn(email: string, password: string): Promise<string> {
  const anon = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await anon.auth.signInWithPassword({ email, password })
  if (error || !data.session) throw new Error(`sign-in failed: ${error?.message}`)
  return data.session.access_token
}

describe.skipIf(!ready)('api/ handlers over HTTP', () => {
  let server: Server
  let base = ''
  let adminToken = ''

  beforeAll(async () => {
    // The functions read server-only env vars, exactly as on Vercel.
    process.env.SUPABASE_URL = supabaseUrl
    process.env.SUPABASE_ANON_KEY = anonKey

    server = mount()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server did not bind')
    base = `http://127.0.0.1:${address.port}`

    adminToken = await signIn(adminEmail, adminPassword)
  }, 60_000)

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  async function post(path: string, body: unknown, token?: string, contentType = 'application/json') {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': contentType,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    })
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }

  it('rejects an unauthenticated request', async () => {
    const result = await post('/api/compliance/coa-extract', { filename: 'x.pdf', pdfBase64: 'AA==' })
    expect(result.status).toBe(401)
    expect(result.body.requestId).toBeTruthy()
  })

  it('rejects a non-admin caller', async () => {
    if (!farmerEmail || !farmerPassword) throw new Error('farmer credentials required')
    const farmerToken = await signIn(farmerEmail, farmerPassword)
    const result = await post('/api/compliance/coa-extract', { filename: 'x.pdf', pdfBase64: 'AA==' }, farmerToken)
    expect(result.status).toBe(403)
    expect(result.body.error).toBe('forbidden')
  }, 60_000)

  it('rejects a non-JSON content type', async () => {
    const result = await post('/api/compliance/coa-extract', {}, adminToken, 'text/plain')
    expect(result.status).toBe(415)
  })

  it('extracts a real COA end-to-end over HTTP', async () => {
    const bytes = await readFile(pdfPath as string)
    const result = await post(
      '/api/compliance/coa-extract',
      { filename: 'api-http-e2e.pdf', pdfBase64: bytes.toString('base64') },
      adminToken,
    )

    expect(result.status, JSON.stringify(result.body)).toBe(200)
    const document = result.body.document as { supported: boolean; pageCount: number; coaDocumentId: string }
    expect(document.supported).toBe(true)
    expect(document.pageCount).toBe(3)

    // And the source route works against the same document.
    const source = await post('/api/compliance/source-retrieve', { coaDocumentId: document.coaDocumentId }, adminToken)
    expect(source.status, JSON.stringify(source.body)).toBe(200)
    expect((source.body.sourceVersion as { retrievalStatus: string }).retrievalStatus).toBe('retrieved')
    expect(source.body.suggestionState).toBe('bound')
  }, 180_000)

  it('never leaks document bytes or driver detail in an error response', async () => {
    const result = await post(
      '/api/compliance/coa-extract',
      { filename: 'not-a-pdf.pdf', pdfBase64: Buffer.from('SENSITIVE-DOCUMENT-CONTENT').toString('base64') },
      adminToken,
    )
    expect(result.status).toBe(422)
    const serialized = JSON.stringify(result.body)
    expect(serialized).not.toContain('SENSITIVE-DOCUMENT-CONTENT')
    expect(serialized).toContain('not_a_pdf')
  }, 60_000)
})
