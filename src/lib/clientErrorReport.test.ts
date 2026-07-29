import { afterEach, describe, expect, it, vi } from 'vitest'
import { reportDbError, reportAppMessage } from './clientErrorReport'

/**
 * F8 — raw PostgREST error text was rendered verbatim to end users, farmers
 * included.
 *
 * onDbError stored err.message (App.tsx:549-553) and the banner rendered it
 * unmodified (:876-881). Those messages come from src/lib/db.ts:28-55, which
 * rethrows the Postgres/PostgREST message directly — routinely naming policies,
 * columns, functions and constraints.
 */

afterEach(() => {
  vi.restoreAllMocks()
})

function capture() {
  const lines: string[] = []
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
  })
  return lines
}

/**
 * Representative real PostgREST/Postgres errors, with the schema identifiers
 * that must never reach a user.
 */
const REPRESENTATIVE = [
  {
    name: 'RLS refusal',
    err: new Error('new row violates row-level security policy for table "inventory_batches"'),
    leaks: ['row-level security', 'inventory_batches', 'policy'],
    expectCategory: 'permission_denied',
  },
  {
    name: 'unique violation',
    err: Object.assign(new Error('duplicate key value violates unique constraint "buyer_pack_snapshots_pack_id_version_key"'), { code: '23505' }),
    leaks: ['duplicate key', 'buyer_pack_snapshots_pack_id_version_key', 'constraint'],
    expectCategory: 'duplicate_record',
  },
  {
    name: 'missing column (schema drift)',
    err: Object.assign(new Error('column "coa_storage_path" of relation "inventory_batches" does not exist'), { code: '42703' }),
    leaks: ['coa_storage_path', 'inventory_batches', 'relation'],
    expectCategory: 'internal_error',
  },
  {
    name: 'foreign key violation',
    err: Object.assign(new Error('insert or update on table "review_requests" violates foreign key constraint "review_requests_stock_item_id_fkey"'), { code: '23503' }),
    leaks: ['review_requests_stock_item_id_fkey', 'foreign key', 'review_requests'],
    expectCategory: 'related_record_missing',
  },
  {
    name: 'check violation',
    err: Object.assign(new Error('new row for relation "procurement_decisions" violates check constraint "procurement_decisions_reason_check"'), { code: '23514' }),
    leaks: ['procurement_decisions_reason_check', 'procurement_decisions', 'check constraint'],
    expectCategory: 'invalid_value',
  },
  {
    name: 'permission denied on a function',
    err: Object.assign(new Error('permission denied for function issue_buyer_pack_snapshot'), { code: '42501' }),
    leaks: ['issue_buyer_pack_snapshot', 'permission denied for function'],
    expectCategory: 'permission_denied',
  },
  {
    name: 'RAISE EXCEPTION from the issuance gate',
    err: new Error('issue_buyer_pack_snapshot: current procurement decision for pack batch-1 is "hold", not "progress" — cannot issue'),
    leaks: ['issue_buyer_pack_snapshot', 'procurement decision'],
    expectCategory: 'internal_error',
  },
] as const

describe('F8 — no schema detail reaches the rendered banner text', () => {
  it.each(REPRESENTATIVE)('$name: the message names no policy, table, column, constraint or function', ({ err, leaks }) => {
    capture()
    const { message } = reportDbError(err)
    for (const leak of leaks) {
      expect(message.toLowerCase(), leak).not.toContain(leak.toLowerCase())
    }
  })

  it.each(REPRESENTATIVE)('$name: the message is not the raw error text', ({ err }) => {
    capture()
    const { message } = reportDbError(err)
    expect(message).not.toBe((err as Error).message)
    expect(message).not.toContain((err as Error).message)
  })

  it.each(REPRESENTATIVE)('$name: classified as $expectCategory', ({ err, expectCategory }) => {
    capture()
    expect(reportDbError(err).category).toBe(expectCategory)
  })

  it('never emits a message outside the closed set, whatever it is handed', () => {
    capture()
    const weird: unknown[] = [
      null,
      undefined,
      42,
      { code: '99999', message: 'relation "secret_table" does not exist' },
      new Error('function public.some_internal_fn(uuid) does not exist'),
      'raw string error naming column "x" of relation "y"',
      Symbol('nope'),
    ]
    const seen = new Set<string>()
    for (const w of weird) seen.add(reportDbError(w).message)
    for (const m of seen) {
      expect(m).not.toMatch(/relation|constraint|policy|column "|secret_table|some_internal_fn/i)
    }
  })
})

describe('F8 — a correlation id is present in both the banner and the console line', () => {
  it('returns a reference and puts the same one on the raw console line', () => {
    const lines = capture()
    const { reference } = reportDbError(new Error('new row violates row-level security policy for table "farms"'))

    expect(reference).toMatch(/^[0-9a-f-]{16,}$/i)
    const rawLine = lines.find(l => l.includes('Supabase error'))
    expect(rawLine, 'the raw console line is missing').toBeDefined()
    expect(rawLine).toContain(reference)
  })

  it('keeps the RAW text in console.error — a developer loses nothing', () => {
    const lines = capture()
    reportDbError(new Error('column "coa_storage_path" of relation "inventory_batches" does not exist'))
    expect(lines.some(l => l.includes('coa_storage_path'))).toBe(true)
  })

  it('emits a structured safe log line carrying the same reference and no message', () => {
    const lines = capture()
    const { reference } = reportDbError(new Error('duplicate key value violates unique constraint "x_key"'), 'ddp-buyer')
    const structured = lines.find(l => l.includes('"event":"db_error"'))
    expect(structured, 'the structured log line is missing').toBeDefined()
    expect(structured).toContain(reference)
    expect(structured).toContain('"route":"ddp-buyer"')
    // The safe line must not carry the schema identifier.
    expect(structured).not.toContain('x_key')
    expect(structured).not.toContain('duplicate key')
  })

  it('issues a distinct reference per report, so two failures are separable', () => {
    capture()
    const a = reportDbError(new Error('fetch failed'))
    const b = reportDbError(new Error('fetch failed'))
    expect(a.reference).not.toBe(b.reference)
  })
})

describe('F8 — classification is useful, not merely safe', () => {
  it('maps a network failure to a connection message rather than an internal error', () => {
    capture()
    expect(reportDbError(new Error('Failed to fetch')).category).toBe('connection_failed')
    expect(reportDbError(new Error('TypeError: NetworkError when attempting to fetch resource.')).category).toBe('connection_failed')
  })

  it('prefers the SQLSTATE code over message sniffing when both are present', () => {
    capture()
    // Code says unique violation; the text would sniff as permission_denied.
    const err = Object.assign(new Error('row-level security policy'), { code: '23505' })
    expect(reportDbError(err).category).toBe('duplicate_record')
  })

  it('still classifies RLS refusals that arrive with the code stripped by db.ts', () => {
    capture()
    // db.ts rethrows `new Error(error.message)`, discarding the code.
    expect(reportDbError(new Error('new row violates row-level security policy for table "farms"')).category)
      .toBe('permission_denied')
  })
})

describe('F8 — app-authored messages still get a reference', () => {
  it('passes the message through and attaches a reference', () => {
    capture()
    const text = 'Your account does not have an assigned DDP role. Please contact DDP support.'
    const report = reportAppMessage(text)
    expect(report.message).toBe(text)
    expect(report.reference).toMatch(/^[0-9a-f-]{16,}$/i)
  })
})

/**
 * The banner is .tsx and this repo's vitest env is 'node' with no jsdom, so the
 * wiring is asserted against source text via `import.meta.glob(..., '?raw')`.
 */
function raw(glob: Record<string, string>): string {
  return Object.values(glob)[0] ?? ''
}
const APP_SRC = raw(import.meta.glob('../App.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)

describe('F8 — the banner renders the mapped message, not the raw one', () => {
  it('loads the source under assertion', () => {
    expect(APP_SRC.length).toBeGreaterThan(1000)
  })

  it('onDbError no longer stores err.message', () => {
    const handler = APP_SRC.slice(APP_SRC.indexOf('function onDbError('), APP_SRC.indexOf('function onDbError(') + 600)
    expect(handler).toContain('reportDbError(err')
    expect(handler).not.toContain('err instanceof Error ? err.message : String(err)')
    expect(handler).not.toContain('setDbError(msg)')
  })

  it('the banner renders the mapped message and the reference', () => {
    const banner = APP_SRC.slice(APP_SRC.indexOf('db-error-banner'), APP_SRC.indexOf('db-error-banner') + 500)
    expect(banner).toContain('{dbError.message}')
    expect(banner).toContain('{dbError.reference}')
    // The raw-string render is gone.
    expect(banner).not.toMatch(/<strong>Error:<\/strong> \{dbError\}/)
  })
})
