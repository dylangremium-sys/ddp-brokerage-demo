import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { InventoryItem } from '../types'

// ─── Regression: the scalar photo_url column must not persist a data: URL ────
//
// createInventoryBatch already strips data: URLs from the photo_urls ARRAY
// (they can be multi-MB and can exceed the API body limit, failing the whole
// batch insert). Before this fix the singular photo_url column was written
// unfiltered, so a mobile camera capture (a multi-MB data: URL) still bloated
// the row. These tests drive the real db.ts path with a captured upsert and
// assert what actually lands in the inventory_batches payload.

const VALID_UUID = '11111111-1111-4111-8111-111111111111'
let lastUpsert: Record<string, unknown> | null = null

beforeEach(() => {
  lastUpsert = null
  vi.resetModules()
  // Live-mode Supabase client mock that captures the upsert payload.
  vi.doMock('./supabase', () => ({
    isSupabaseConfigured: true,
    supabase: {
      from: () => ({
        upsert: (data: Record<string, unknown>) => {
          lastUpsert = data
          return Promise.resolve({ error: null })
        },
      }),
    },
  }))
})

function makeItem(photoUrl: string): InventoryItem {
  return {
    id: VALID_UUID,
    productName: 'Test Product',
    photoUrl,
    photoUrls: [photoUrl],
    status: 'Pending Review',
  } as unknown as InventoryItem
}

describe('createInventoryBatch — photo_url data: URL filtering', () => {
  it('drops a data: URL from the scalar photo_url column', async () => {
    const { createInventoryBatch } = await import('./db')
    await createInventoryBatch(makeItem('data:image/jpeg;base64,AAAABBBBCCCC'))
    expect(lastUpsert).not.toBeNull()
    expect(lastUpsert!.photo_url).toBeNull()
    // and the array is filtered too (existing behaviour preserved)
    expect(lastUpsert!.photo_urls).toBeNull()
  })

  it('preserves an already-hosted https photo_url', async () => {
    const { createInventoryBatch } = await import('./db')
    const url = 'https://cdn.example.com/photo.jpg'
    await createInventoryBatch(makeItem(url))
    expect(lastUpsert!.photo_url).toBe(url)
    expect(lastUpsert!.photo_urls).toEqual([url])
  })
})
