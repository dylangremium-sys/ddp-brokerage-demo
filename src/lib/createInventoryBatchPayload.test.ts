import { describe, it, expect, beforeEach, vi } from 'vitest'
import { BATCH_PRICE_CURRENCIES } from '../types'
import type { InventoryItem } from '../types'

/**
 * P1 / W1 — every priced batch a farmer submitted was rejected by the database,
 * and the farmer was shown a success screen anyway.
 *
 * 3,001 tests passed while this shipped. They could not catch it, because not
 * one of them ran the client's own payload builder against production's actual
 * constraints — the suite tested the pieces on either side of the gap. This file
 * closes that gap: it captures the exact object `createInventoryBatch` sends to
 * PostgREST and evaluates production's live CHECK expressions against it.
 *
 * The constraints below are transcribed from production on 2026-08-06 and each
 * carries the definition it was taken from, so a reviewer can re-read them with:
 *
 *   psql "$PROD_RO_DATABASE_URL" -c "SELECT conname, pg_get_constraintdef(oid) \
 *     FROM pg_constraint WHERE conrelid='public.inventory_batches'::regclass \
 *     AND contype='c' ORDER BY conname"
 *
 * They are a copy, and a copy can drift. What makes that acceptable is that this
 * file asserts the *client's* obligation — send a currency, never send a blank
 * where the column refuses one — which is true regardless of how the constraint
 * is worded. A drift in the constraint is caught by the migration harness; a
 * drift in the client is caught here, and nothing was catching it before.
 *
 * The Supabase double records the table name as well as the payload. A double
 * that is blind to its table argument will happily endorse a write aimed at the
 * wrong one, and this repository already has five of those.
 */

const captured = vi.hoisted(() => ({
  upserts: [] as Array<{ table: string; data: Record<string, unknown> }>,
  /** Rows the mocked SELECT returns, keyed by table. */
  rows: {} as Record<string, Array<Record<string, unknown>>>,
}))

vi.mock('./supabase', () => {
  const selectResult = (table: string) => Promise.resolve({
    data: captured.rows[table] ?? [], error: null,
  })
  return {
    isSupabaseConfigured: true,
    supabase: {
      from: (table: string) => ({
        upsert: (data: Record<string, unknown>) => {
          captured.upserts.push({ table, data })
          return Promise.resolve({ error: null })
        },
        // Chainable, because the real queries are .select().order() AND
        // .select().in().order(). A double that answers only the shape the
        // test happens to hit is how a mock ends up endorsing a query it
        // never actually modelled.
        select: () => {
          const builder = {
            order: () => selectResult(table),
            in: () => builder,
            eq: () => builder,
          }
          return builder
        },
      }),
    },
  }
})

import { createInventoryBatch, loadInventoryFromDB } from './db'

const BATCH_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const FARM_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const USER_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc'

/**
 * A batch shaped exactly as the farmer form builds it, including the details
 * that made the real defect: `pricePerKg` comes from `parseFloat(x) || 0`, so
 * it is a number and never null; and the three string fields are '' whenever
 * the farmer left them untouched.
 */
function farmerSubmission(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: BATCH_ID,
    farmerName: 'Somchai',
    farmName: 'Green Valley',
    farmId: FARM_ID,
    location: 'Chiang Mai, Thailand',
    productName: 'Sativa Gold',
    quantityKg: 25,
    harvestDate: '',
    cureDate: '',
    batchNumber: '',
    thcPct: 18,
    cbdPct: 1,
    moisturePct: 11,
    waterActivity: '0.55',
    qualityGrade: 'A',
    pricePerKg: 45000,
    certFileName: '',
    photoUrl: '',
    storageConditions: 'Cool, dry',
    notes: '',
    status: 'Pending Review',
    submittedAt: '2026-08-06T00:00:00.000Z',
    stockStatus: 'submitted',
    ...overrides,
  }
}

async function capturePayload(item: InventoryItem): Promise<Record<string, unknown>> {
  await createInventoryBatch(item, USER_ID)
  const batchWrite = captured.upserts.find((u) => u.table === 'inventory_batches')
  if (!batchWrite) throw new Error('no write to inventory_batches was attempted')
  return batchWrite.data
}

// --- production's live CHECK expressions, as predicates -------------------

/** inventory_batches_price_requires_currency — the constraint that broke it. */
const priceRequiresCurrency = (r: Record<string, unknown>) =>
  (r.price_per_kg == null && r.asking_price == null) || r.price_currency != null

/** inventory_batches_price_currency_allowed */
const priceCurrencyAllowed = (r: Record<string, unknown>) =>
  r.price_currency == null || (BATCH_PRICE_CURRENCIES as readonly string[]).includes(r.price_currency as string)

/** inventory_batches_batch_number_not_blank */
const batchNumberNotBlank = (r: Record<string, unknown>) =>
  r.batch_number == null || String(r.batch_number).trim() !== ''

/** A `date` column rejects '' with 22007 before any CHECK is reached. */
const DATE_COLUMNS = ['harvest_date', 'cure_date', 'expiry_date', 'test_date'] as const
const datesAreNullOrParseable = (r: Record<string, unknown>) =>
  DATE_COLUMNS.every((c) => r[c] == null || !Number.isNaN(Date.parse(String(r[c]))))

beforeEach(() => {
  captured.upserts.length = 0
  captured.rows = {}
})

describe('createInventoryBatch — the payload production actually receives', () => {
  it('writes to inventory_batches, not some other table', async () => {
    await capturePayload(farmerSubmission())
    expect(captured.upserts.map((u) => u.table)).toContain('inventory_batches')
  })

  it('states a price currency — the row production refused for fifty-nine attempts', async () => {
    const payload = await capturePayload(farmerSubmission())
    expect(payload.price_currency).toBeDefined()
    expect(payload.price_currency).not.toBeNull()
    expect(priceRequiresCurrency(payload)).toBe(true)
  })

  it('states a currency production will accept', async () => {
    const payload = await capturePayload(farmerSubmission())
    expect(priceCurrencyAllowed(payload)).toBe(true)
    expect(BATCH_PRICE_CURRENCIES).toContain(payload.price_currency)
  })

  it('states a currency even when the farmer entered no price', async () => {
    // parseFloat('') || 0 yields 0, not null, so the constraint's both-null
    // escape hatch is unreachable from this form. The currency must be sent
    // regardless — this is the case that made the blocker unconditional.
    const payload = await capturePayload(farmerSubmission({ pricePerKg: 0 }))
    expect(priceRequiresCurrency(payload)).toBe(true)
  })

  it('sends NULL, not "", for fields the farmer left untouched', async () => {
    const payload = await capturePayload(farmerSubmission())
    expect(payload.harvest_date).toBeNull()
    expect(payload.cure_date).toBeNull()
    expect(payload.batch_number).toBeNull()
  })

  it('never sends a blank string to a column that refuses one', async () => {
    const payload = await capturePayload(farmerSubmission())
    expect(batchNumberNotBlank(payload)).toBe(true)
    expect(datesAreNullOrParseable(payload)).toBe(true)
  })

  it('treats whitespace as absence, not as a value', async () => {
    const payload = await capturePayload(
      farmerSubmission({ batchNumber: '   ', harvestDate: '  ', cureDate: '\t' }),
    )
    expect(payload.batch_number).toBeNull()
    expect(payload.harvest_date).toBeNull()
    expect(payload.cure_date).toBeNull()
  })

  it('passes real values through, trimmed', async () => {
    const payload = await capturePayload(
      farmerSubmission({ batchNumber: ' GV-2026-001 ', harvestDate: '2026-03-01', cureDate: '2026-03-20' }),
    )
    expect(payload.batch_number).toBe('GV-2026-001')
    expect(payload.harvest_date).toBe('2026-03-01')
    expect(payload.cure_date).toBe('2026-03-20')
  })

  it('preserves a stored non-THB currency when a batch is edited', async () => {
    // The fallback exists for NEW batches. Applying it to an edit would
    // redenominate the batch while leaving its number untouched: a 100 USD
    // listing saved back as 100 THB. Caught in review of this very change.
    const payload = await capturePayload(farmerSubmission({ priceCurrency: 'USD' }))
    expect(payload.price_currency).toBe('USD')
  })

  it('falls back to THB only when the batch carries no currency', async () => {
    const payload = await capturePayload(farmerSubmission())
    expect(payload.price_currency).toBe('THB')
  })

  it('a USD batch loaded from the database is still USD when written back', async () => {
    // The real defect this guards, found in review of this change: the row ->
    // item mapper dropped price_currency and the form did not preserve it, so
    // the write path's THB fallback applied to an EDIT. A 100 USD listing was
    // saved back as 100 THB — number untouched, denomination silently changed.
    // Load and save are exercised together because either half alone looks fine.
    captured.rows.inventory_batches = [{
      id: BATCH_ID,
      farm_id: FARM_ID,
      product_name: 'Sativa Gold',
      quantity_kg: 25,
      price_per_kg: 100,
      price_currency: 'USD',
      status: 'Pending Review',
    }]

    const [loaded] = await loadInventoryFromDB()
    expect(loaded.priceCurrency, 'the loader dropped the currency').toBe('USD')

    const payload = await capturePayload(loaded)
    expect(payload.price_currency, 'the write path redenominated the batch').toBe('USD')
  })

  it('satisfies every transcribed production CHECK at once', async () => {
    for (const item of [
      farmerSubmission(),
      farmerSubmission({ pricePerKg: 0 }),
      farmerSubmission({ batchNumber: 'GV-1', harvestDate: '2026-01-02', cureDate: '2026-02-03' }),
    ]) {
      captured.upserts.length = 0
      const payload = await capturePayload(item)
      const failed = [
        ['price_requires_currency', priceRequiresCurrency(payload)],
        ['price_currency_allowed', priceCurrencyAllowed(payload)],
        ['batch_number_not_blank', batchNumberNotBlank(payload)],
        ['dates_null_or_parseable', datesAreNullOrParseable(payload)],
      ].filter(([, ok]) => !ok).map(([name]) => name)
      expect(failed, `payload violates ${failed.join(', ')}`).toEqual([])
    }
  })
})
