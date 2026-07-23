import { describe, it, expect } from 'vitest'

/**
 * Cross-feature safety audit for the evidence workflow (contract v1.5 §15.2
 * browser prohibitions, §15.7 safety language, §15.8 regression protection, and
 * the §17 stop conditions those map onto).
 *
 * These are SOURCE-LEVEL guards. They cannot prove runtime behaviour — that is
 * what the RLS behavioural VERIFY SQL and the authenticated browser journeys are
 * for — but they do prevent a future edit from reintroducing a whole class of
 * defect: a service-role key in browser code, a direct table write, a hardcoded
 * public URL, or an approval claim in user-facing copy.
 */

/**
 * The whole `src` tree as {path: text}, read through Vite's `?raw` glob rather
 * than node:fs — the repo convention (see operationsDeskRouting.test.ts), and
 * the reason `src` compiles without node type definitions. It is also immune to
 * the checkout path, so a directory containing a space cannot break it.
 */
const ALL_MODULES = import.meta.glob('../**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

/**
 * Glob keys are relative to THIS file (src/lib), and Vite emits two shapes:
 * `./x.ts` for a sibling in src/lib, and `../dir/x.ts` for anything else under
 * src. Both are normalised to a repo-relative path so the assertions below can
 * name files the way a reader would.
 */
const normalise = (key: string): string =>
  key.startsWith('./') ? `src/lib/${key.slice(2)}` : `src/${key.replace(/^\.\.\//, '')}`

const ALL_SOURCE = Object.keys(ALL_MODULES).map(normalise)

const isTest = (f: string) => f.endsWith('.test.ts') || f.endsWith('.test.tsx')

/**
 * Source that actually ships in the browser bundle. Test files are excluded
 * because a test legitimately CONTAINS a forbidden string in order to assert its
 * absence — scanning them would flag the very guards that protect us.
 */
const SHIPPED_SOURCE = ALL_SOURCE.filter(f => !isTest(f))

/** Every file this feature added or touched in the browser bundle. */
const EVIDENCE_SOURCE = SHIPPED_SOURCE.filter(f =>
  /evidenceRequest|EvidenceRequest|EvidenceThread|useEvidenceScopeReset/.test(f),
)

const BY_PATH = new Map(Object.entries(ALL_MODULES).map(([k, v]) => [normalise(k), v]))
const read = (f: string): string => BY_PATH.get(f) ?? ''

describe('the evidence feature has real source files (guards a broken glob)', () => {
  it('found the shared contracts, service, desk adapter and pages', () => {
    const names = EVIDENCE_SOURCE
    expect(names).toContain('src/domain/evidenceRequests.ts')
    expect(names).toContain('src/lib/evidenceRequests.ts')
    expect(names).toContain('src/lib/evidenceRequestRoutes.ts')
    expect(names).toContain('src/lib/evidenceRequestStorage.ts')
    expect(names).toContain('src/lib/evidenceRequestDesk.ts')
    expect(names).toContain('src/pages/admin/evidence/AdminEvidenceRequests.tsx')
    expect(names).toContain('src/pages/admin/evidence/AdminEvidenceRequestCreate.tsx')
    expect(names).toContain('src/pages/admin/evidence/AdminEvidenceRequestDetail.tsx')
    expect(names).toContain('src/pages/farmer/evidence/FarmerEvidenceRequestList.tsx')
    expect(names).toContain('src/pages/farmer/evidence/FarmerEvidenceRequestDetail.tsx')
    expect(EVIDENCE_SOURCE.length).toBeGreaterThanOrEqual(10)
  })
})

describe('browser prohibitions (§8.5, §15.2, §17.17)', () => {
  it('no shipped source file references a service-role key', () => {
    for (const file of SHIPPED_SOURCE) {
      const text = read(file)
      expect(text, file).not.toContain('SERVICE_ROLE')
      expect(text, file).not.toContain('service_role_key')
      expect(text, file).not.toContain('serviceRoleKey')
    }
  })

  it('the evidence bundle never mentions service_role at all', () => {
    for (const file of EVIDENCE_SOURCE) {
      expect(read(file), file).not.toContain('service_role')
    }
  })

  it('evidence pages perform no direct table writes — mutations go through RPCs (§6.7)', () => {
    const WORKFLOW_TABLES = [
      'evidence_requests',
      'evidence_request_responses',
      'evidence_request_attachments',
      'evidence_request_history',
    ]
    for (const file of EVIDENCE_SOURCE) {
      const text = read(file)
      for (const table of WORKFLOW_TABLES) {
        // `.from('<table>')` followed by insert/update/upsert/delete anywhere in
        // the same statement chain is the shape this forbids.
        const writes = new RegExp(
          `from\\(['"]${table}['"]\\)[\\s\\S]{0,200}?\\.(insert|update|upsert|delete)\\(`,
        )
        expect(writes.test(text), `${file} writes directly to ${table}`).toBe(false)
      }
    }
  })

  it('page components never call supabase directly — they go through the service', () => {
    const pages = EVIDENCE_SOURCE.filter(f => f.includes('/pages/'))
    expect(pages.length).toBeGreaterThan(0)
    for (const file of pages) {
      const text = read(file)
      expect(text, file).not.toMatch(/from ['"].*lib\/supabase['"]/)
      expect(text, file).not.toContain('supabase.from(')
      expect(text, file).not.toContain('supabase.rpc(')
    }
  })

  it('no evidence storage object is exposed through a public URL (§7.1, §19.14)', () => {
    for (const file of EVIDENCE_SOURCE) {
      expect(read(file), file).not.toContain('getPublicUrl')
    }
  })

  it('the service reads attachments only through short-lived signed URLs', () => {
    const service = read('src/lib/evidenceRequests.ts')
    expect(service).toContain('createSignedUrl')
    expect(service).not.toContain('getPublicUrl')
  })

  it('no evidence code trusts a client-supplied role claim', () => {
    for (const file of EVIDENCE_SOURCE) {
      const text = read(file)
      // A role is read to scope a LOAD (§9.7), never asserted as authorization.
      expect(text, file).not.toMatch(/role\s*===\s*['"]ddp_admin['"]\s*\)\s*\{[\s\S]{0,80}rpc\(/)
    }
  })
})

describe('safety language (§2.3, §15.7, §17.20)', () => {
  const PROHIBITED = [
    'fully compliant',
    'legally compliant',
    'approved for export',
    'export-ready',
    'export ready',
    'verified supplier',
    'verified batch',
    'pharmaceutical approved',
    'certified pharmaceutical',
    'ready to buy',
  ]

  it.each(PROHIBITED)('no evidence source contains the phrase %j', phrase => {
    for (const file of EVIDENCE_SOURCE) {
      expect(read(file).toLowerCase(), file).not.toContain(phrase)
    }
  })

  it('makes no automatic verification or approval claim about a farm or batch', () => {
    for (const file of EVIDENCE_SOURCE) {
      const text = read(file).toLowerCase()
      expect(text, file).not.toContain('farm is verified')
      expect(text, file).not.toContain('batch is verified')
      expect(text, file).not.toContain('coa approved')
      expect(text, file).not.toContain('evidence is compliant')
      expect(text, file).not.toContain('supplier approved')
    }
  })

  it('makes no malware or virus scanning claim (§7.3, §2.2)', () => {
    for (const file of EVIDENCE_SOURCE) {
      const text = read(file).toLowerCase()
      // "not a malware scan" is an explicit disclaimer and is permitted; a
      // positive claim is not.
      expect(text, file).not.toMatch(/\b(scanned for|virus[- ]checked|malware[- ]scanned)\b/)
    }
  })

  it('uses the contract status labels verbatim, so no page can invent softer wording', () => {
    const domain = read('src/domain/evidenceRequests.ts')
    for (const label of [
      'Awaiting farmer response',
      'Submitted for review',
      'Clarification requested',
      'Reviewed and resolved',
      'Evidence rejected',
      'Cancelled',
    ]) {
      expect(domain).toContain(label)
    }
  })
})

describe('Buyer Pack regression protection (§15.8, §17.18)', () => {
  const BUYER_PACK_SOURCE = SHIPPED_SOURCE.filter(f => /buyerPack|BuyerPreview/i.test(f))

  it('finds the Buyer Pack sources it is guarding', () => {
    expect(BUYER_PACK_SOURCE.length).toBeGreaterThan(0)
  })

  it('no Buyer Pack source references the evidence workflow', () => {
    for (const file of BUYER_PACK_SOURCE) {
      const text = read(file)
      expect(text, file).not.toContain('evidence_request')
      expect(text, file).not.toContain('evidenceRequest')
      expect(text, file).not.toContain('EvidenceRequest')
    }
  })

  it('no evidence source touches Buyer Pack code — nothing is auto-included', () => {
    for (const file of EVIDENCE_SOURCE) {
      const text = read(file)
      expect(text, file).not.toContain('buyerPack')
      expect(text, file).not.toContain('BuyerPack')
      expect(text, file).not.toContain('buyer_pack')
      expect(text, file).not.toContain('issue_buyer_pack_snapshot')
    }
  })
})

describe('Compliance Watchtower regression protection (§15.8, §17.19)', () => {
  const WATCHTOWER_SOURCE = SHIPPED_SOURCE.filter(f => /compliance|watchtower/i.test(f))

  it('finds the Watchtower sources it is guarding', () => {
    expect(WATCHTOWER_SOURCE.length).toBeGreaterThan(0)
  })

  it('no Watchtower source references the evidence workflow', () => {
    for (const file of WATCHTOWER_SOURCE) {
      const text = read(file)
      expect(text, file).not.toContain('evidence_request')
      expect(text, file).not.toContain('evidenceRequest')
    }
  })

  it('no evidence source creates a rule, resolves an alert, or scores compliance', () => {
    for (const file of EVIDENCE_SOURCE) {
      const text = read(file)
      expect(text, file).not.toContain('complianceRules')
      expect(text, file).not.toContain('complianceAlerts')
      expect(text, file).not.toContain('complianceScoring')
      expect(text, file).not.toContain('resolveAlert')
    }
  })
})

describe('failed loads never become empty or all-clear (§9.6, §17.14, §17.15)', () => {
  it('no evidence source coerces an error result into an empty array', () => {
    for (const file of EVIDENCE_SOURCE) {
      const text = read(file)
      // The shapes that silently turn a failure into "nothing to do".
      expect(text, file).not.toMatch(/catch\s*\([^)]*\)\s*\{\s*return\s*\[\]/)
      expect(text, file).not.toMatch(/\.catch\(\s*\(\)\s*=>\s*\[\]\s*\)/)
      expect(text, file).not.toMatch(/ok\s*\?\s*[^:]+:\s*\[\]/)
    }
  })

  it('the desk treats a null evidence source as a failure, not as empty', () => {
    const desk = read('src/lib/operationsDesk.ts')
    expect(desk).toContain("input.evidenceRequests === null")
    expect(desk).toContain("category: 'evidence-request'")
  })
})

describe('the Operations Desk stays read-only (§11.1, §17)', () => {
  it('the desk page issues no evidence mutation', () => {
    const deskPage = read('src/pages/admin/DDPOperationsDesk.tsx')
    for (const mutation of [
      'createEvidenceRequest',
      'resolveEvidenceRequest',
      'rejectEvidenceResponse',
      'requestEvidenceClarification',
      'cancelEvidenceRequest',
      'submitEvidenceResponse',
      'reserveEvidenceAttachment',
      'saveEvidenceResponseDraft',
    ]) {
      expect(deskPage, mutation).not.toContain(mutation)
    }
  })

  it('the desk adapter imports no mutation entry point', () => {
    const adapter = read('src/lib/evidenceRequestDesk.ts')
    expect(adapter).not.toContain("from './evidenceRequests'")
  })

  it('the create action lives on the administrator list, not the desk (§10.3)', () => {
    const deskPage = read('src/pages/admin/DDPOperationsDesk.tsx')
    expect(deskPage).not.toContain('Create request')
    const adminList = read('src/pages/admin/evidence/AdminEvidenceRequests.tsx')
    expect(adminList).toContain('Create request')
  })
})

describe('review pages delegate rather than write (§10.7, §10.8)', () => {
  it('Farm Review and Inventory Review create no evidence record themselves', () => {
    for (const page of ['pages/admin/DDPFarmReview.tsx', 'pages/admin/DDPInventoryReview.tsx']) {
      const text = read(`src/${page}`)
      expect(text, page).toContain('Request evidence')
      expect(text, page).not.toContain('createEvidenceRequest')
      expect(text, page).not.toContain('evidence_requests')
    }
  })
})
