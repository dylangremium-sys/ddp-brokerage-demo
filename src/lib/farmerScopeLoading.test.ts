import { describe, expect, it } from 'vitest'
import { T } from '../translations'

/**
 * F7 — farmer pages reported "no data" while the farmer's scope was still
 * loading.
 *
 * `scopeLoading` (App.tsx:395) was consumed at exactly one place: farmer-status.
 * farmer-my-stock, farmer-requests and farmer-dashboard received arrays that are
 * [] while farmerScope === null, so a farmer WITH stock read "No stock yet. Add
 * your first listing above." (FarmerMyStock.tsx:182-183) and a dashboard showing
 * 0 open requests. This is the exact failure the Operations Desk work eliminated
 * on the admin side.
 *
 * The surfaces are .tsx and this repo's vitest env is 'node' with no jsdom, so
 * the guard is asserted against source text via `import.meta.glob(..., '?raw')`
 * — the existing convention (operationsDeskRouting.test.ts).
 */
function raw(glob: Record<string, string>): string {
  return Object.values(glob)[0] ?? ''
}

const APP_SRC = raw(import.meta.glob('../App.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)
const MY_STOCK_SRC = raw(import.meta.glob('../pages/farmer/FarmerMyStock.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)

/** The JSX block that renders one page, from its `page === '<id>'` guard to the next. */
function pageBlock(src: string, pageId: string): string {
  const start = src.indexOf(`{page === '${pageId}' &&`)
  if (start === -1) return ''
  const next = src.indexOf('{page === ', start + 10)
  return src.slice(start, next === -1 ? undefined : next)
}

const GUARDED_PAGES = [
  ['farmer-dashboard', 'scopeLoadingDashboard'],
  ['farmer-my-stock', 'scopeLoadingStock'],
  ['farmer-requests', 'scopeLoadingRequests'],
  ['farmer-status', 'scopeLoadingSubmissions'],
] as const

describe('F7 — source fixtures are readable', () => {
  it('loads App.tsx and FarmerMyStock.tsx', () => {
    expect(APP_SRC.length).toBeGreaterThan(1000)
    expect(MY_STOCK_SRC.length).toBeGreaterThan(1000)
  })

  it('finds a render block for every guarded farmer page', () => {
    for (const [pageId] of GUARDED_PAGES) {
      expect(pageBlock(APP_SRC, pageId), pageId).not.toBe('')
    }
  })
})

describe('F7 — every scoped farmer surface renders a loading state, never an empty state', () => {
  it.each(GUARDED_PAGES)('%s is gated on scopeLoading', (pageId) => {
    const block = pageBlock(APP_SRC, pageId)
    expect(block).toContain('scopeLoading')
    expect(block).toContain('className="scope-loading"')
    // The guard must short-circuit the page component, not merely sit beside it.
    expect(block).toMatch(/scopeLoading\s*\n?\s*\?\s*<div className="scope-loading">/)
  })

  it.each(GUARDED_PAGES)('%s uses the bilingual string %s', (pageId, key) => {
    expect(pageBlock(APP_SRC, pageId)).toContain(`T[lang].${key}`)
  })

  it('no longer hardcodes the English loading string that farmer-status used', () => {
    expect(APP_SRC).not.toContain('>Loading your submissions…<')
  })

  it('derives scopeLoading from the farmer role and an unresolved scope', () => {
    // If this weakened, the guards above would fire for admins too (or never).
    expect(APP_SRC).toContain('const scopeLoading = isFarmerRole && farmerScope === null')
  })
})

describe('F7 — the empty state the guard now protects against still exists', () => {
  it('FarmerMyStock still shows "No stock yet" for a settled empty list', () => {
    // The guard is only meaningful because this message is genuinely reachable;
    // if it were removed the test above would pass vacuously.
    expect(MY_STOCK_SRC).toContain('No stock yet. Add your first listing above.')
  })
})

describe('F7 — bilingual strings exist for every guard', () => {
  it.each(GUARDED_PAGES)('%s: en and th are both present and non-empty', (_pageId, key) => {
    expect(T.en[key]).toBeTruthy()
    expect(T.th[key]).toBeTruthy()
  })

  it.each(GUARDED_PAGES)('%s: th is an actual translation, not the English string', (_pageId, key) => {
    expect(T.th[key]).not.toBe(T.en[key])
    // Thai script range — guards against an untranslated placeholder.
    expect(T.th[key]).toMatch(/[฀-๿]/)
  })
})
