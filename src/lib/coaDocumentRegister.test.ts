import { describe, expect, it, vi, beforeEach } from 'vitest'

// The register write is a thin, high-consequence function: it is the only thing
// that turns "bytes in a bucket" into "a document DDP has a record of". These
// tests pin the properties that make that record trustworthy, and the source
// ordering that keeps it from ever describing a file that is not there.

const insertSpy = vi.fn<(table: string, row: Record<string, unknown>) => void>()

vi.mock('./supabase', () => {
  const from = (table: string) => ({
    insert: (row: Record<string, unknown>) => {
      insertSpy(table, row)
      return Promise.resolve({ error: null })
    },
  })
  return { supabase: { from }, isSupabaseConfigured: true }
})

const { recordCoaDocument, hashFileHex } = await import('./db')

const BATCH = 'a1164a3c-afad-4bc4-b06b-899eb71414dd'
const FARM = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
/** SHA-256 of "abc" — a real digest, so the shape under test is the real shape. */
const DIGEST = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'

beforeEach(() => insertSpy.mockClear())

describe('recordCoaDocument — what the register row must say', () => {
  it('writes to farmer_documents, the register the migrations built', async () => {
    await recordCoaDocument({ farmId: FARM, batchId: BATCH, fileName: 'coa.pdf', storagePath: 'u/f/b/1-coa.pdf', sha256Hex: DIGEST })
    expect(insertSpy).toHaveBeenCalledTimes(1)
    expect(insertSpy.mock.calls[0][0]).toBe('farmer_documents')
  })

  it('stores the storage PATH in file_url, never a signed URL', async () => {
    // A signed URL expires. Persisting one stores a reference that resolves
    // today and silently stops resolving later — the failure would surface as a
    // missing document long after the cause.
    await recordCoaDocument({ farmId: FARM, batchId: BATCH, fileName: 'coa.pdf', storagePath: 'u/f/b/1-coa.pdf', sha256Hex: DIGEST })
    const row = insertSpy.mock.calls[0][1]
    expect(row.file_url).toBe('u/f/b/1-coa.pdf')
    expect(String(row.file_url)).not.toContain('http')
    expect(String(row.file_url)).not.toContain('token')
  })

  it('records the digest and its timestamp together', async () => {
    // The table's sha256_pairing_check is `(hex IS NULL) = (recorded_at IS NULL)`.
    // Writing one without the other is refused by the database; asserting it
    // here names the reason rather than leaving a 23514 to explain itself.
    await recordCoaDocument({ farmId: FARM, batchId: BATCH, fileName: 'coa.pdf', storagePath: 'p', sha256Hex: DIGEST })
    const row = insertSpy.mock.calls[0][1]
    expect(row.sha256_hex).toBe(DIGEST)
    expect(typeof row.sha256_recorded_at).toBe('string')
  })

  it('marks the document as a COA and leaves review status to its default', async () => {
    // A document is not reviewed by being uploaded. Setting review_status here
    // would manufacture a review no person performed.
    await recordCoaDocument({ farmId: FARM, batchId: BATCH, fileName: 'coa.pdf', storagePath: 'p', sha256Hex: DIGEST })
    const row = insertSpy.mock.calls[0][1]
    expect(row.document_type).toBe('coa')
    expect(row).not.toHaveProperty('review_status')
    expect(row.inventory_batch_id).toBe(BATCH)
  })

  it('nulls a farm id that is not a UUID rather than sending it to a foreign key', async () => {
    await recordCoaDocument({ farmId: 'not-a-uuid', batchId: BATCH, fileName: 'c.pdf', storagePath: 'p', sha256Hex: DIGEST })
    expect(insertSpy.mock.calls[0][1].farm_id).toBeNull()
  })
})

describe('recordCoaDocument — refusing a digest the register cannot stand behind', () => {
  // The CHECK is `sha256_hex ~ '^[0-9a-f]{64}$'`. Each of these would be
  // refused by the database as an opaque 23514; refusing them here names the
  // problem while it is still a programming error rather than a farmer's.
  for (const [label, bad] of [
    ['too short', 'abc123'],
    ['upper case', DIGEST.toUpperCase()],
    ['non-hex characters', 'z'.repeat(64)],
    ['empty', ''],
    ['65 characters', DIGEST + 'a'],
  ] as const) {
    it(`refuses a digest that is ${label}`, async () => {
      await expect(
        recordCoaDocument({ farmId: FARM, batchId: BATCH, fileName: 'c.pdf', storagePath: 'p', sha256Hex: bad }),
      ).rejects.toThrow(/SHA-256/)
      expect(insertSpy).not.toHaveBeenCalled()
    })
  }
})

describe('hashFileHex — the fingerprint itself', () => {
  it('produces the known SHA-256 of a known input', async () => {
    // Literal expected value, not one derived from the same call. A digest test
    // that hashes twice and compares asserts only that the function is
    // deterministic — it would pass on a function returning a constant.
    const file = new File(['abc'], 'coa.pdf', { type: 'application/pdf' })
    await expect(hashFileHex(file)).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('produces the known SHA-256 of empty content', async () => {
    const file = new File([], 'empty.pdf', { type: 'application/pdf' })
    await expect(hashFileHex(file)).resolves.toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })

  it('gives different bytes different digests', async () => {
    const a = await hashFileHex(new File(['one'], 'a.pdf'))
    const b = await hashFileHex(new File(['two'], 'b.pdf'))
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(b).toMatch(/^[0-9a-f]{64}$/)
  })

  it('digests the content, not the file name', async () => {
    const a = await hashFileHex(new File(['same'], 'first.pdf'))
    const b = await hashFileHex(new File(['same'], 'second.pdf'))
    expect(a).toBe(b)
  })
})

// ── The ordering guard ──────────────────────────────────────────────────────
//
// The register must be written AFTER the bytes are up, and the hash must be
// taken BEFORE they go. Both are properties of the callsite in App.tsx, not of
// any function here, so they are asserted against the source.
//
// Neither is decorative. Register-then-upload leaves a row naming a document
// that does not exist — the register would assert the opposite of the truth on
// exactly the failure it should record. Upload-then-hash would fingerprint a
// re-read rather than the bytes sent.
const raw = (mods: Record<string, string>) => Object.values(mods)[0] ?? ''
const APP_SRC = raw(import.meta.glob('../App.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)

describe('the COA callsite orders its steps so the register cannot lie', () => {
  const block = (() => {
    const start = APP_SRC.indexOf('if (coaFile && isSupabaseConfigured')
    const end = APP_SRC.indexOf('// Photos, same shape as the COA attachment')
    return start === -1 || end === -1 || end < start ? '' : APP_SRC.slice(start, end)
  })()

  it('locates the COA attachment block', () => {
    expect(block).not.toBe('')
  })

  it('hashes before uploading, and registers after', () => {
    const hashAt = block.indexOf('hashFileHex(')
    const uploadAt = block.indexOf('uploadCoaFile(')
    const registerAt = block.indexOf('recordCoaDocument(')

    expect(hashAt, 'the COA is never hashed').toBeGreaterThan(-1)
    expect(uploadAt, 'the COA is never uploaded').toBeGreaterThan(-1)
    expect(registerAt, 'the COA is never written to the register').toBeGreaterThan(-1)

    expect(hashAt, 'hash must be taken from the file before it is uploaded').toBeLessThan(uploadAt)
    expect(registerAt, 'the register must be written only after the bytes exist').toBeGreaterThan(uploadAt)
  })

  it('awaits the register write, so a failed one is not swallowed', () => {
    // An unawaited promise here would let a submission report success while the
    // register write rejected in the background — the precise shape of the
    // silent-failure defects this codebase has shipped twice before.
    expect(block).toMatch(/await\s+recordCoaDocument\(/)
  })
})
