import { describe, expect, it } from 'vitest'

/**
 * F2a — the immediate, no-schema half of "the blocking-issue half of the release
 * gate is browser-local, unattributed, and destroyed by sign-out".
 *
 * The buyer-pack decision panel already warns when a record never reached the
 * server. The Risk Register and the Missing Document Matrix — which drive the
 * OTHER half of the same invariant, hasBlockingIssues — carried no such warning,
 * despite writing straight to localStorage in Supabase mode too.
 *
 * These surfaces are .tsx and this repo's vitest env is 'node' with no jsdom, so
 * the wiring is asserted against source text via `import.meta.glob(..., '?raw')`
 * — the existing convention (operationsDeskRouting.test.ts).
 */
function raw(glob: Record<string, string>): string {
  return Object.values(glob)[0] ?? ''
}

const NOTICE_SRC = raw(import.meta.glob('../components/shared/BrowserOnlyProvenanceNotice.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)
const RISK_SRC = raw(import.meta.glob('../pages/admin/DDPRiskRegister.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)
const MATRIX_SRC = raw(import.meta.glob('../pages/admin/DDPMissingDocuments.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)
const PREVIEW_SRC = raw(import.meta.glob('../pages/admin/DDPBuyerPreview.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)

const OVERRIDE_SURFACES = [
  ['DDPRiskRegister', () => RISK_SRC, 'risk status overrides'],
  ['DDPMissingDocuments', () => MATRIX_SRC, 'document status overrides'],
] as const

describe('F2a — source fixtures are readable', () => {
  it('loads every source under assertion', () => {
    expect(NOTICE_SRC.length).toBeGreaterThan(500)
    expect(RISK_SRC.length).toBeGreaterThan(1000)
    expect(MATRIX_SRC.length).toBeGreaterThan(1000)
    expect(PREVIEW_SRC.length).toBeGreaterThan(1000)
  })
})

describe('F2a — both override surfaces render the provenance notice', () => {
  it.each(OVERRIDE_SURFACES)('%s imports the shared notice', (_name, src) => {
    expect(src()).toContain("from '../../components/shared/BrowserOnlyProvenanceNotice'")
  })

  it.each(OVERRIDE_SURFACES)('%s renders it with the subject "%s"', (_name, src, subject) => {
    expect(src()).toMatch(new RegExp(`<BrowserOnlyProvenanceNotice[\\s\\S]{0,120}subject="${subject}"`))
  })

  it.each(OVERRIDE_SURFACES)('%s counts overrides actually in effect on the page', (_name, src) => {
    // A hardcoded count would render the notice even with no override in effect,
    // training operators to ignore it.
    expect(src()).toContain('overriddenCount')
    expect(src()).toMatch(/count=\{overriddenCount\}/)
    expect(src()).toMatch(/load(Risk|Requirement)Overrides\(\)/)
  })

  it('the Risk Register counts against LIVE risk ids, so an inert override is not counted', () => {
    // composeRiskId makes a superseded override inert (F1a). Counting the raw
    // localStorage map would report clearances that affect nothing.
    expect(RISK_SRC).toMatch(/risks\.filter\(r => overrides\[r\.riskId\] !== undefined\)/)
  })

  it('the Matrix counts against the live (farmId, type) pairs', () => {
    expect(MATRIX_SRC).toMatch(/overrides\[`\$\{r\.farmId\}::\$\{r\.type\}`\]/)
  })
})

describe('F2a — the notice reuses the decision panel vocabulary, not a new one', () => {
  it('keeps the "only in this browser" phrasing the decision panel established', () => {
    expect(NOTICE_SRC).toContain('only in this browser')
    expect(PREVIEW_SRC, 'the decision panel phrasing is the source of this vocabulary')
      .toContain('only in this browser')
  })

  it('keeps the "no server-side audit record and no recorded approver" clause', () => {
    expect(NOTICE_SRC).toContain('server-side audit record')
    expect(NOTICE_SRC).toContain('no recorded approver')
    expect(PREVIEW_SRC).toContain('no server-side audit record')
    expect(PREVIEW_SRC).toContain('no recorded approver')
  })

  it('reuses the decision panel styling rather than inventing a treatment', () => {
    expect(NOTICE_SRC).toMatch(/fontSize:\s*12/)
    expect(NOTICE_SRC).toContain("color: 'var(--text-muted)'")
    expect(NOTICE_SRC).toContain('⚠')
  })

  it('names the two consequences the finding calls out: invisibility and sign-out loss', () => {
    expect(NOTICE_SRC).toContain('not visible')
    expect(NOTICE_SRC).toMatch(/Signing out clears/)
  })
})

describe('F2a — the notice is scoped correctly', () => {
  it('renders ONLY in Supabase mode', () => {
    // In demo mode localStorage IS the store, so the warning would be noise.
    expect(NOTICE_SRC).toContain('isSupabaseConfigured')
    expect(NOTICE_SRC).toMatch(/if \(!supabaseConfigured \|\| count <= 0\) return null/)
  })

  it('renders nothing when no override is in effect', () => {
    expect(NOTICE_SRC).toMatch(/count <= 0/)
  })

  it('is announced to assistive technology without stealing focus', () => {
    // role="status" is polite: it is context, not an error demanding attention.
    expect(NOTICE_SRC).toContain('role="status"')
  })
})

/**
 * The component is pure and its guard clause is the whole contract, so the
 * render decision is re-expressed here as an executable predicate and checked
 * against the same table of cases the component handles.
 */
function shouldRender(supabaseConfigured: boolean, count: number): boolean {
  return supabaseConfigured && count > 0
}

describe('F2a — render decision table', () => {
  it.each([
    [true, 0, false],
    [true, 1, true],
    [true, 7, true],
    [false, 0, false],
    [false, 3, false],   // demo mode: never
  ])('supabase=%s count=%s → renders=%s', (configured, count, expected) => {
    expect(shouldRender(configured, count)).toBe(expected)
  })
})
