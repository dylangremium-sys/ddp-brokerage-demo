import { describe, expect, it } from 'vitest'
import { resolvePostLoginDecision } from './postLoginRouting'
import type { UserProfile } from '../services/auth'

/**
 * Operations Desk routing, access and read-only guarantees.
 *
 * This repo's vitest environment is 'node' and the include glob covers only
 * `src/**‍/*.test.ts` — there is no jsdom and .tsx is never rendered under
 * test. Route wiring and the absence of mutation controls are therefore
 * asserted against source text via `import.meta.glob(..., '?raw')`, the
 * existing convention here (see statusPendingClassMapping.test.ts and
 * watchtowerAiSummaryIntegration.test.ts).
 */
function raw(glob: Record<string, string>): string {
  return Object.values(glob)[0] ?? ''
}

const APP_SRC = raw(import.meta.glob('../App.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)
const TYPES_SRC = raw(import.meta.glob('../types.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)
const NAV_SRC = raw(import.meta.glob('../components/admin/AdminNav.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)
const SHELL_SRC = raw(import.meta.glob('../components/admin/AdminShell.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)
const PAGE_SRC = raw(import.meta.glob('../pages/admin/DDPOperationsDesk.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)
const DB_SRC = raw(import.meta.glob('./db.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)

/** Extract a single top-level function body by name, for scoped source assertions. */
function fnBody(src: string, signature: string): string {
  const start = src.indexOf(signature)
  if (start === -1) return ''
  const nextExport = src.indexOf('\nexport ', start + signature.length)
  return src.slice(start, nextExport === -1 ? undefined : nextExport)
}

const PAGE_ID = 'ddp-operations-desk'

describe('Operations Desk — source fixtures are readable', () => {
  it('loads every source under assertion', () => {
    expect(APP_SRC.length).toBeGreaterThan(1000)
    expect(TYPES_SRC.length).toBeGreaterThan(1000)
    expect(NAV_SRC.length).toBeGreaterThan(500)
    expect(SHELL_SRC.length).toBeGreaterThan(500)
    expect(PAGE_SRC.length).toBeGreaterThan(1000)
  })
})

describe('Operations Desk — routing registration', () => {
  it('declares the page in the Page union', () => {
    expect(TYPES_SRC).toContain(`| '${PAGE_ID}'`)
  })

  it('registers the page in DDP_PAGES so a non-admin gets AccessDenied, not a blank frame', () => {
    const ddpPages = APP_SRC.match(/const DDP_PAGES: Page\[\] = \[[^\]]*\]/)?.[0] ?? ''
    expect(ddpPages).toContain(`'${PAGE_ID}'`)
  })

  it('is NOT registered as a farmer or public page', () => {
    const farmerPages = APP_SRC.match(/const FARMER_PAGES: Page\[\] = \[[\s\S]*?\]/)?.[0] ?? ''
    const publicPages = APP_SRC.match(/const PUBLIC_PAGES: Page\[\] = \[[^\]]*\]/)?.[0] ?? ''
    expect(farmerPages).not.toContain(PAGE_ID)
    expect(publicPages).not.toContain(PAGE_ID)
  })

  it('guards its render block with the same isAdminRole conjunction as every other DDP page', () => {
    // This conjunction — not DDP_PAGES membership — is the actual client guard.
    expect(APP_SRC).toContain(`page === '${PAGE_ID}' && isAdminRole`)
  })

  it('fails closed: the page is never rendered without the admin conjunction', () => {
    // Match RENDER guards specifically — `page === '...' && …` — not a ternary
    // data read like `isDemo && page === '...' ? …` (demo-only, where admin is
    // already implied). Every render site must still carry isAdminRole.
    const renders = [...APP_SRC.matchAll(new RegExp(`page === '${PAGE_ID}' &&[^)\\n]*`, 'g'))].map(m => m[0])
    expect(renders.length).toBeGreaterThan(0)
    for (const render of renders) expect(render).toContain('isAdminRole')
  })

  it('adds exactly one admin navigation entry, in both nav variants', () => {
    const occurrences = NAV_SRC.split(`goTo('${PAGE_ID}')`).length - 1
    expect(occurrences).toBe(2) // topbar + sidebar
    expect(NAV_SRC).toContain('Operations Desk')
  })

  it('marks the nav entry as the current page for screen readers', () => {
    expect(NAV_SRC).toContain('isOpsDesk')
    expect(NAV_SRC).toContain(`aria-current={isOpsDesk ? 'page' : undefined}`)
  })

  it('labels the page in the admin shell breadcrumb', () => {
    expect(SHELL_SRC).toContain(`'${PAGE_ID}': 'Operations Desk'`)
  })

  it('leaves existing admin and farmer routes intact', () => {
    for (const page of [
      'ddp-overview', 'ddp-farms', 'ddp-farm-review', 'ddp-inventory', 'ddp-inventory-review',
      'ddp-master', 'ddp-buyer', 'ddp-missing-documents', 'ddp-coa-intelligence',
      'ddp-risk-register', 'ddp-compliance-watchtower',
      'farmer-dashboard', 'farmer-onboarding', 'farmer-my-stock', 'farmer-status',
      'landing', 'login',
    ]) {
      expect(TYPES_SRC).toContain(`| '${page}'`)
      expect(APP_SRC).toContain(`'${page}'`)
    }
  })

  it('does not change the post-login routing policy', () => {
    // Role resolution and its fail-closed default are untouched by this feature.
    expect(resolvePostLoginDecision({ role: 'ddp_admin' } as UserProfile))
      .toEqual({ kind: 'route', page: 'ddp-overview' })
    expect(resolvePostLoginDecision({ role: 'farmer' } as UserProfile))
      .toEqual({ kind: 'route', page: 'farmer-dashboard' })
    expect(resolvePostLoginDecision(null)).toEqual({ kind: 'denied', reason: 'unresolved-role' })
    expect(resolvePostLoginDecision({ role: 'pending' } as unknown as UserProfile))
      .toEqual({ kind: 'denied', reason: 'unresolved-role' })
  })

  it('never routes the operator to the desk automatically — it is opt-in navigation', () => {
    expect(APP_SRC).not.toContain(`setPage('${PAGE_ID}')`)
  })
})

describe('Operations Desk — read-only guarantees', () => {
  it('exposes no mutation or persistence path', () => {
    for (const forbidden of [
      'updateFarmProfileStatus',
      'updateInventoryStatus',
      'patchInventoryBatch',
      'saveProcurementDecision',
      'recordDecision',
      'saveRequirementOverride',
      'saveRiskOverride',
      'createReviewRequest',
      'resolveReviewRequest',
      'localStorage',
      'supabase',
    ]) {
      expect(PAGE_SRC).not.toContain(forbidden)
    }
  })

  it('introduces no Buyer Pack issuance, print, download or copy path', () => {
    for (const forbidden of [
      'createBuyerPackSnapshot',
      'prepareBuyerPackSnapshotInput',
      'issue_buyer_pack_snapshot',
      'buyerPackDownloads',
      'window.print',
      'navigator.clipboard',
    ]) {
      expect(PAGE_SRC).not.toContain(forbidden)
    }
  })

  it('does not re-derive the Buyer Pack gate', () => {
    // The blocking half of that gate is private to DDPBuyerPreview; the desk
    // omits the queue rather than approximating it.
    const AGGREGATOR_SRC = raw(import.meta.glob('./operationsDesk.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)
    expect(AGGREGATOR_SRC).not.toContain('deriveBuyerApprovalGate')
    expect(AGGREGATOR_SRC).not.toContain('hasBlockingIssues')
    expect(AGGREGATOR_SRC).not.toContain('isHumanApproved')
    expect(PAGE_SRC).not.toContain('isHumanApproved')
  })

  it('derives navigation targets only — the aggregator performs no write or mutation', () => {
    // The follow-up routing maps records to destination pages/params; it must
    // never call a write, status transition, request closure, procurement or
    // Buyer Pack action.
    const AGGREGATOR_SRC = raw(import.meta.glob('./operationsDesk.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)
    for (const forbidden of [
      'sbInsert', 'sbUpdate', 'sbDelete', '.insert(', '.update(', '.delete(', '.upsert(',
      'updateFarmProfileStatus', 'updateInventoryStatus', 'resolveReviewRequest', 'createReviewRequest',
      'saveProcurementDecision', 'createBuyerPackSnapshot', 'window.print', 'navigator.clipboard',
    ]) {
      expect(AGGREGATOR_SRC).not.toContain(forbidden)
    }
  })

  it('introduces no compliance approval or rule-state mutation', () => {
    for (const forbidden of ['activateRule', 'approveRule', 'pauseRule', 'retireRule', 'rejectRule', 'saveRule']) {
      expect(PAGE_SRC).not.toContain(forbidden)
    }
  })

  it('introduces no AI call path', () => {
    // Matched against real AI module/provider markers. A bare 'summarise'
    // would collide with this feature's own summariseOperationsDeskItems,
    // which is a count, not a model call.
    for (const forbidden of [
      'complianceAiSummarisation',
      'complianceAiSummaryClient',
      'aiComplianceProvider',
      'watchtowerAiSummary',
      'serverAiSummary',
      'serverAiProvider',
      'anthropic',
      'openai',
    ]) {
      expect(PAGE_SRC.toLowerCase()).not.toContain(forbidden.toLowerCase())
    }
  })

  it('uses no prohibited compliance terminology', () => {
    const combined = `${PAGE_SRC} ${raw(import.meta.glob('./operationsDesk.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)}`.toLowerCase()
    for (const banned of [
      'fully compliant',
      'legally compliant',
      'approved for export',
      'export-ready',
      'verified supplier',
      'verified batch',
      'pharmaceutical approved',
      'certified pharmaceutical',
      'ready to buy',
    ]) {
      expect(combined).not.toContain(banned)
    }
  })

  it('keeps the page presentational — logic lives in the tested lib modules', () => {
    expect(PAGE_SRC).toContain("from '../../lib/operationsDesk'")
    expect(PAGE_SRC).toContain("from '../../lib/operationsDeskFilters'")
    expect(PAGE_SRC).toContain("from '../../lib/operationsDeskPriority'")
  })
})

describe('Operations Desk — accessibility and print contract', () => {
  it('uses a semantic page heading and real table semantics', () => {
    expect(PAGE_SRC).toContain('<h1')
    expect(PAGE_SRC).toContain('<table')
    expect(PAGE_SRC).toContain('scope="col"')
    expect(PAGE_SRC).toContain('<caption')
  })

  it('labels every control', () => {
    for (const id of ['ops-desk-search', 'ops-desk-category', 'ops-desk-priority']) {
      expect(PAGE_SRC).toContain(`htmlFor="${id}"`)
      expect(PAGE_SRC).toContain(`id="${id}"`)
    }
  })

  it('uses buttons rather than clickable divs for actions', () => {
    expect(PAGE_SRC).toContain('type="button"')
    expect(PAGE_SRC).not.toMatch(/<div[^>]*onClick/)
  })

  it('communicates priority with a text label, never colour alone', () => {
    expect(PAGE_SRC).toContain('PRIORITY_LABEL[item.priority]')
  })

  it('announces loading and incomplete states to screen readers', () => {
    expect(PAGE_SRC).toContain('role="status"')
  })

  it('exposes the expandable detail row state', () => {
    expect(PAGE_SRC).toContain('aria-expanded={expanded}')
    expect(PAGE_SRC).toContain('aria-controls={detailId}')
  })

  it('excludes filter chrome from print output', () => {
    expect(PAGE_SRC).toContain('ops-desk-controls no-print')
  })
})

describe('Operations Desk — admin review-request loading (Codex P2)', () => {
  // Regression guard for the review finding: in Supabase admin sessions the
  // follow-up queue was empty after login/reload because reviewRequests was
  // populated only by the farmer-scoped effect. This repo's vitest env is
  // 'node' (no DOM, no live Supabase), so the wiring is asserted from source;
  // the runtime data flow is exercised behaviourally in operationsDesk.test.ts
  // (null vs empty vs open review-request handling). What these source-contract
  // tests do NOT prove: that the live Supabase query returns rows — that
  // depends on data + RLS and is covered by the browser/RLS evidence in the PR.

  it('loads all review requests on admin sign-in via a scope-free read path', () => {
    expect(APP_SRC).toContain('loadAllReviewRequestsFromDB')
    // Called with NO farmer scope arguments — admin RLS scopes it server-side.
    expect(APP_SRC).toContain('loadAllReviewRequestsFromDB()')
    // The admin effect is gated to ddp_admin like the other admin loaders.
    expect(APP_SRC).toContain(`currentProfile.role !== 'ddp_admin'`)
  })

  it('replaces review-request state unconditionally so no stale farmer data survives', () => {
    // Unlike the farmer effect (which merges only when dbRequests.length > 0),
    // the admin effect must overwrite — including with [] — so a prior farmer
    // session cannot leak its scoped requests into an admin view.
    // Anchor on the call site (with parens), not the import line.
    const adminEffect = APP_SRC.slice(APP_SRC.indexOf('loadAllReviewRequestsFromDB()'))
    const effect = adminEffect.slice(0, adminEffect.indexOf('}, [currentProfile])'))
    expect(effect).toContain('setReviewRequests(requests)')
    expect(effect).not.toMatch(/if\s*\(\s*requests\.length/)
  })

  it('tracks a four-state load outcome and feeds the desk the sanitized view', () => {
    // Explicit 'loading' so a refetch (not just the initial idle) is pending.
    expect(APP_SRC).toContain("useState<'idle' | 'loading' | 'ready' | 'failed'>('idle')")
    expect(APP_SRC).toContain(`setReviewRequestsLoadState('ready')`)
    expect(APP_SRC).toContain(`setReviewRequestsLoadState('failed')`)
    // The desk consumes the pure projection: null on failure, [] + loading while
    // settling (idle/loading), rows once ready — never a stale array.
    expect(APP_SRC).toContain('deskReviewRequestsView(isDemo, reviewRequestsLoadState, reviewRequests)')
    expect(APP_SRC).toContain('reviewRequests={deskReviewRequests.requests}')
    expect(APP_SRC).toContain('reviewRequestsLoading={deskReviewRequests.loading}')
  })

  it('marks an admin review-request refetch loading on a profile-identity change', () => {
    // A same-admin token refresh replaces currentProfile without changing the
    // scope key, so the state is moved to 'loading' during render (like the
    // compliance / farm-inventory loaders) — never left 'ready' over a refetch.
    expect(APP_SRC).toContain('reviewRequestsFetchProfile')
    const trig = APP_SRC.slice(APP_SRC.indexOf('reviewRequestsFetchProfile !== adminDataProfile'))
    const block = trig.slice(0, trig.indexOf('}'))
    expect(block).toContain("setReviewRequestsLoadState('loading')")
  })

  it('leaves the farmer-scoped review-request path unchanged', () => {
    // Farmer isolation is not weakened: farmers still load only their own
    // batch-scoped requests through the original loader.
    expect(APP_SRC).toContain('loadReviewRequestsFromDB(currentProfile.id, scope.farmIds, scope.itemIds)')
  })

  it('the admin loader performs no write and applies no client-side scope filter', () => {
    const loader = fnBody(DB_SRC, 'export async function loadAllReviewRequestsFromDB')
    expect(loader.length).toBeGreaterThan(0)
    // Read-only: no insert/update/delete/upsert of any kind.
    for (const write of ['sbInsert', 'sbUpdate', 'sbDelete', '.insert(', '.update(', '.delete(', '.upsert(']) {
      expect(loader).not.toContain(write)
    }
    // Reads the review-request table, ordered — but is NOT batch- or user-scoped
    // on the client (admin RLS does the scoping), so it also returns null-batch
    // (farm-level) requests the batch-scoped farmer loader would miss.
    expect(loader).toContain("from('farmer_review_requests')")
    expect(loader).toContain('.select(')
    expect(loader).not.toContain(".in('inventory_batch_id'")
    expect(loader).not.toContain(".eq('created_by'")
  })
})

describe('Operations Desk — cross-role review-request isolation (Codex P1)', () => {
  // Regression guard for the follow-up finding: the admin loader fills the
  // shared reviewRequests state with every admin-visible request, and farmer
  // pages consume that state — so a farmer signing into the same SPA session
  // must not inherit it. The privacy guarantee itself is proven behaviourally
  // in reviewRequestScope.test.ts (pure projection + scope-change decision);
  // these source-contract tests only assert the wiring uses them.

  it('feeds farmer pages the scoped projection, never the raw shared state', () => {
    // Every farmer-facing review-request prop must read farmerReviewRequests
    // (the fail-closed projection), not the raw reviewRequests array.
    expect(APP_SRC).toContain('const farmerReviewRequests')
    expect(APP_SRC).toContain('scopeReviewRequestsToFarmer(reviewRequests, farmerScope)')
    for (const prop of [
      'openRequestsCount={farmerReviewRequests',
      'openRequestCount={farmerReviewRequests',
      'openRequests={farmerReviewRequests}',
      'requests={farmerReviewRequests}',
    ]) {
      expect(APP_SRC).toContain(prop)
    }
    // No farmer-facing prop may bind the raw array.
    expect(APP_SRC).not.toMatch(/open[Rr]equests?(Count)?=\{reviewRequests/)
    expect(APP_SRC).not.toContain('requests={reviewRequests}')
  })

  it('drops review-request state when the authenticated scope changes', () => {
    // Keyed clear in the auth subscription: sign-out / admin↔farmer / new user.
    expect(APP_SRC).toContain('reviewRequestScopeChanged')
    expect(APP_SRC).toContain('reviewScopeKeyRef')
    // Anchor on the call site (with args), not the import line.
    const authBlock = APP_SRC.slice(APP_SRC.indexOf('reviewRequestScopeChanged(reviewScopeKeyRef.current'))
    const guarded = authBlock.slice(0, authBlock.indexOf('}'))
    expect(guarded).toContain('setReviewRequests([])')
  })

  it('replaces farmer review-request state unconditionally (no length guard)', () => {
    // The farmer loader must overwrite even with [] so a zero-request farmer
    // cannot retain a prior admin-wide list.
    expect(APP_SRC).not.toContain('if (dbRequests.length > 0) setReviewRequests')
    const farmerEffect = APP_SRC.slice(APP_SRC.indexOf('getFarmerScope(currentProfile.id)'))
    const effect = farmerEffect.slice(0, farmerEffect.indexOf('}, [currentProfile])'))
    expect(effect).toContain('setReviewRequests(dbRequests)')
    // Fail closed on load failure.
    expect(effect).toContain('setReviewRequests([])')
  })
})

describe('Operations Desk — demo compliance alert source (Codex P2)', () => {
  // In demo mode the desk's compliance queue was always empty because the App's
  // fetched complianceAlerts stays [] without Supabase, even though the Watchtower
  // persists manual alerts locally. App now hydrates the desk from the same shared
  // local store. Behavioural read semantics (empty/stored/malformed) live in
  // complianceLocalAlerts.test.ts; same-tab refresh is confirmed in the browser.
  const WATCHTOWER_SRC = raw(import.meta.glob('../pages/admin/DDPComplianceWatchtower.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)

  it('reads the Watchtower’s shared local alert store in demo mode, re-read on entry', () => {
    expect(APP_SRC).toContain('loadStoredComplianceAlerts')
    // Gated on demo AND being on the desk page, so it re-reads on navigation
    // (the `page` dependency) and never runs in Supabase mode.
    expect(APP_SRC).toContain("isDemo && page === 'ddp-operations-desk' ? loadStoredComplianceAlerts()")
    expect(APP_SRC).toContain('demoComplianceAlerts')
  })

  it('feeds the demo store into the desk alerts and keeps failure → null', () => {
    // The demo store now flows through the merged deskComplianceAlerts (with the
    // rule-derived alerts); the Supabase failure path still yields null via the
    // `failed` flag passed into resolveDeskComplianceAlerts.
    expect(APP_SRC).toContain('(isDemo ? demoComplianceAlerts : complianceAlerts) ?? []')
    expect(APP_SRC).toContain("!isDemo && complianceLoadState === 'failed'")
  })

  it('shares ONE alert-store key between App and Watchtower — no duplicate literal', () => {
    // The Watchtower references the shared constant, not a second copy of the key.
    expect(WATCHTOWER_SRC).toContain('COMPLIANCE_ALERTS_STORAGE_KEY')
    expect(WATCHTOWER_SRC).toContain('loadStoredComplianceAlerts')
    expect(WATCHTOWER_SRC).not.toContain("alerts: 'ddp_compliance_alerts'")
  })

  it('the shared reader performs no write (Operations Desk stays read-only)', () => {
    const READER_SRC = raw(import.meta.glob('./complianceLocalAlerts.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)
    for (const write of ['setItem', 'removeItem', '.clear(', 'saveStored']) {
      expect(READER_SRC).not.toContain(write)
    }
  })
})

describe('Operations Desk — truthful loading + stale-load guard (Codex P2)', () => {
  // Behavioural coverage lives in operationsDeskEmptyState.test.ts (empty-state
  // decision) and asyncLoadGuard.test.ts (deferred-promise race). These assert
  // the page and the effects are wired to those guards.

  it('drives the empty state through the pure decision helper, not a bare visible check', () => {
    expect(PAGE_SRC).toContain('resolveOperationsDeskEmptyState')
    expect(PAGE_SRC).toContain('hasPendingSources')
    // The all-clear copy is gated behind the resolved state, not shown whenever
    // the derived list is empty.
    expect(PAGE_SRC).toContain("emptyState === 'loading'")
    expect(PAGE_SRC).toContain("emptyState === 'failed'")
  })

  it('guards the admin review-request load against a superseded session', () => {
    const adminEffect = APP_SRC.slice(APP_SRC.indexOf('runGuardedLoad(loadAllReviewRequestsFromDB()'))
    const effect = adminEffect.slice(0, adminEffect.indexOf('}, [currentProfile])'))
    expect(effect).toContain('() => active')
    expect(effect).toContain('return () => { active = false }')
  })

  it('guards the farmer load continuations symmetrically', () => {
    // Anchor on the farmer-effect guard clause so `let active` (declared above
    // getFarmerScope) is inside the slice.
    const farmerEffect = APP_SRC.slice(APP_SRC.indexOf("currentProfile.role !== 'farmer') return"))
    const effect = farmerEffect.slice(0, farmerEffect.indexOf('}, [currentProfile])'))
    // active flag declared, cleared in cleanup, and checked before touching state
    expect(effect).toContain('let active = true')
    expect(effect).toContain('return () => { active = false }')
    expect((effect.match(/if \(!active\) return/g) ?? []).length).toBeGreaterThanOrEqual(2)
    // both the success continuation and the failure continuation are guarded
    expect(effect).toContain('setReviewRequests(dbRequests)')
    expect(effect).toContain('setReviewRequests([])')
  })
})

describe('Operations Desk — compliance refetch is marked loading (Codex P2)', () => {
  // The compliance effect refetches on every desk entry; a refetch must be
  // represented as loading so a stale 'ready' snapshot cannot show an all-clear
  // while it is in flight. The pure trigger decision is tested in
  // complianceRefetch.test.ts; the guarded-load drop in asyncLoadGuard.test.ts.

  it('adds a loading state and counts it as pending on the desk', () => {
    // The load-state union includes an explicit in-flight value…
    expect(APP_SRC).toContain("useState<'idle' | 'loading' | 'ready' | 'failed'>('idle')")
    // …and complianceLoading treats it (and idle) as pending.
    expect(APP_SRC).toContain("complianceLoadState === 'idle' || complianceLoadState === 'loading'")
  })

  it('marks the refetch loading during render (not via set-state-in-effect)', () => {
    expect(APP_SRC).toContain('complianceRefetchStarted(complianceFetchTrigger')
    expect(APP_SRC).toContain("setComplianceLoadState('loading')")
    // The marker is derived during render, not inside the fetch effect.
    const effect = APP_SRC.slice(
      APP_SRC.indexOf('runGuardedLoad(Promise.all([fetchComplianceRules'),
      APP_SRC.indexOf('}, [currentProfile, page])'),
    )
    expect(effect).not.toContain("setComplianceLoadState('loading')")
  })

  it('guards the compliance refetch against a superseded or hung request', () => {
    const effect = APP_SRC.slice(APP_SRC.indexOf('runGuardedLoad(Promise.all([fetchComplianceRules'))
    const body = effect.slice(0, effect.indexOf('}, [currentProfile, page])'))
    expect(body).toContain('() => active')
    // cleanup flips the guard when the effect re-runs / unmounts
    expect(APP_SRC).toContain('return () => { active = false }')
  })
})

describe('Operations Desk — admin farm/inventory source tracking (Codex P2)', () => {
  // The farm/inventory source feeds most desk queues but had no loading/failure
  // state, so a pending or failed load could show a false all-clear. Loader
  // failure semantics are tested in adminOperationalLoaders.test.ts; the guarded
  // partial-failure in asyncLoadGuard.test.ts; the empty-state precedence in
  // operationsDeskEmptyState.test.ts. These assert the wiring.

  it('the desk folds farm/inventory loading and failure into pending/failure', () => {
    expect(PAGE_SRC).toContain('farmInventoryLoading')
    expect(PAGE_SRC).toContain('farmInventoryFailed')
    // loading joins hasPendingSources; failure joins the failure count.
    expect(PAGE_SRC).toContain('reviewRequestsLoading || complianceLoading || farmInventoryLoading')
    expect(PAGE_SRC).toContain('result.failures.length + (farmInventoryFailed ? 1 : 0)')
    // a restrained source-specific notice exists for each
    expect(PAGE_SRC).toContain('Loading farm and inventory matters')
    expect(PAGE_SRC).toContain('Farm and inventory data could not be loaded')
  })

  it('App marks the admin source loading (during render) and drives it from the guarded allSettled load', () => {
    expect(APP_SRC).toContain('adminDataLoadState')
    // rendered pending/failed props to the desk
    expect(APP_SRC).toContain("farmInventoryLoading={!isDemo && (adminDataLoadState === 'idle' || adminDataLoadState === 'loading')}")
    expect(APP_SRC).toContain("farmInventoryFailed={!isDemo && adminDataLoadState === 'failed'}")
    // loading is set during render (adjust-state), not synchronously in the effect
    expect(APP_SRC).toContain("setAdminDataLoadState('loading')")
    // allSettled + the pure outcome helper, so a partial failure keeps the good half
    expect(APP_SRC).toContain('runGuardedLoad(Promise.allSettled([loadFarmsFromDB(), loadInventoryFromDB()])')
    expect(APP_SRC).toContain('resolveAdminDataLoad(farmsResult, inventoryResult)')
    const effect = APP_SRC.slice(
      APP_SRC.indexOf('runGuardedLoad(Promise.allSettled([loadFarmsFromDB'),
      APP_SRC.indexOf('}, [currentProfile])', APP_SRC.indexOf('runGuardedLoad(Promise.allSettled([loadFarmsFromDB')),
    )
    expect(effect).not.toContain("setAdminDataLoadState('loading')")
    // only whichever dataset succeeded is applied (the good half is kept)
    expect(effect).toContain('if (outcome.farms !== undefined) setFarms(outcome.farms)')
    expect(effect).toContain('if (outcome.inventory !== undefined) setInventory(outcome.inventory)')
    // guarded against a superseded/hung load
    expect(effect).toContain('() => active')
  })

  it('the admin loaders throw on error (no silent [] that masks a failure)', () => {
    const farms = DB_SRC.slice(DB_SRC.indexOf('export async function loadFarmsFromDB'), DB_SRC.indexOf('export async function loadInventoryFromDB'))
    expect(farms).toContain('throw new Error(`loadFarmsFromDB')
    expect(farms).not.toContain("console.warn('loadFarmsFromDB'")
  })
})

describe('Operations Desk — no routing to missing detail records (Codex P2)', () => {
  // The enable/route decision is tested behaviourally in operationsDeskActions.test.ts.
  // Here we assert the page disables the action and cannot bypass it via the callback.
  it('renders a disabled "Record unavailable" action when the target is not loaded', () => {
    expect(PAGE_SRC).toContain('operationsDeskActionAvailable(item, loadedFarmIds, loadedItemIds)')
    expect(PAGE_SRC).toContain('Record unavailable')
    // the fallback branch is a genuinely disabled <button> (native click+keyboard block)
    const disabledBranch = PAGE_SRC.slice(PAGE_SRC.indexOf('Record unavailable') - 400, PAGE_SRC.indexOf('Record unavailable'))
    expect(disabledBranch).toContain('disabled')
  })

  it('routes only through the pure resolver, so a none-route makes no callback', () => {
    expect(PAGE_SRC).toContain('resolveOperationsDeskRoute(item, loadedFarmIds, loadedItemIds)')
    // openItem acts only on concrete routes — a 'none' does nothing.
    expect(PAGE_SRC).toContain("route.kind === 'open-farm'")
    expect(PAGE_SRC).toContain("route.kind === 'open-item'")
    expect(PAGE_SRC).toContain("route.kind === 'go'")
  })

  it('scopes availability to the currently loaded farm/inventory ids', () => {
    expect(PAGE_SRC).toContain('const loadedFarmIds = useMemo(() => new Set(farms.map(f => f.id))')
    expect(PAGE_SRC).toContain('const loadedItemIds = useMemo(() => new Set((inventory ?? []).map(i => i.id))')
  })
})

describe('Operations Desk — includes rule-derived compliance alerts (Codex P2)', () => {
  // The merge equivalence to the Watchtower is tested behaviourally in
  // operationsDeskComplianceAlerts.test.ts. Here we assert the wiring: the desk
  // is fed the merged view, with demo baseline rules vs fetched rules.
  it('feeds the desk the merged (rule-derived + persisted) alerts', () => {
    expect(APP_SRC).toContain('resolveDeskComplianceAlerts(')
    expect(APP_SRC).toContain('complianceAlerts={deskComplianceAlerts}')
    // never persists auto alerts — derived read-only in a memo
    expect(APP_SRC).toContain('const deskComplianceAlerts = useMemo')
  })

  it('uses the shared demo rule store (re-read on desk entry) and fetched rules in Supabase', () => {
    // demo rules come from the SAME mutable store the Watchtower uses, re-read on
    // entry (page dep) so an approved/activated rule is honoured without reload.
    expect(APP_SRC).toContain("isDemo && page === 'ddp-operations-desk' ? loadStoredComplianceRules()")
    expect(APP_SRC).toContain('isDemo ? (demoComplianceRules ?? []) : complianceRules')
    // stored/persisted alerts source: demo local store vs fetched rows
    expect(APP_SRC).toContain('(isDemo ? demoComplianceAlerts : complianceAlerts) ?? []')
    // App no longer freshly builds baseline rules — the reader owns the fallback.
    expect(APP_SRC).not.toContain('createBaselineComplianceRules()')
  })

  it('the Watchtower and desk share ONE demo rule store key/reader (no divergence)', () => {
    const WT_SRC = raw(import.meta.glob('../pages/admin/DDPComplianceWatchtower.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)
    expect(WT_SRC).toContain('COMPLIANCE_RULES_STORAGE_KEY')
    expect(WT_SRC).toContain('loadStoredComplianceRules()')
    expect(WT_SRC).not.toContain("rules: 'ddp_compliance_rules'") // no duplicate literal
  })

  it('the shared rule reader performs no write (derivation stays read-only)', () => {
    const READER_SRC = raw(import.meta.glob('./complianceLocalAlerts.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)
    for (const write of ['setItem', 'removeItem', 'saveStored', '.clear(']) {
      expect(READER_SRC).not.toContain(write)
    }
  })

  it('preserves failure truthfulness (failed → null to the merge)', () => {
    expect(APP_SRC).toContain("!isDemo && complianceLoadState === 'failed'")
  })
})

describe('Operations Desk — unavailable inventory ≠ empty (Codex P2)', () => {
  // The document-queue behaviour is covered in operationsDesk.test.ts; here we
  // assert the fail-closed wiring so a future requirement type is suppressed by
  // default while inventory is unavailable.
  it('distinguishes inventory-unavailable with a fail-closed farm-only whitelist', () => {
    const AGG = raw(import.meta.glob('./operationsDesk.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)
    expect(AGG).toContain('const inventoryAvailable = input.inventory !== null')
    expect(AGG).toContain('FARM_ONLY_REQUIREMENT_TYPES')
    // whitelist (allow-list), applied only when inventory is NOT available
    expect(AGG).toContain('inventoryAvailable\n        ? derived\n        : derived.filter(req => FARM_ONLY_REQUIREMENT_TYPES.has(req.type))')
    // the input type carries the availability distinction
    expect(AGG).toContain('inventory: InventoryItem[] | null')
  })

  it('App derives rule alerts from fresh inventory only (null → [])', () => {
    expect(APP_SRC).toContain('deskData.inventory ?? []')
    expect(APP_SRC).toContain('inventory={deskData.inventory}')
  })
})

describe('Operations Desk — only fresh admin data reaches the desk (Codex P2)', () => {
  // Per-dataset freshness (deskAdminDataView) is tested behaviourally in
  // adminDataLoad.test.ts; compliance behaviour in operationsDeskComplianceAlerts.
  // Here we assert the wiring: the desk and its alert derivation consume the
  // sanitized projection, and freshness is tracked from the allSettled result.
  it('feeds the desk (and its alert derivation) the sanitized deskData projection', () => {
    expect(APP_SRC).toContain('deskAdminDataView(isDemo, farms, inventory, adminDataAvailability.farms, adminDataAvailability.inventory)')
    expect(APP_SRC).toContain('farms={deskData.farms}')
    expect(APP_SRC).toContain('inventory={deskData.inventory}')
    // rule-derived alerts use the sanitized farms/inventory, never the raw arrays
    expect(APP_SRC).toContain('deskData.farms')
    expect(APP_SRC).toContain('deskData.inventory')
    expect(APP_SRC).not.toMatch(/resolveDeskComplianceAlerts\(\s*[^)]*\bfarms\b,\s*inventory,/)
  })

  it('tracks per-dataset freshness: reset on load start, set from allSettled result', () => {
    // reset when a new admin load starts (render-time trigger)
    expect(APP_SRC).toContain('setAdminDataAvailability({ farms: false, inventory: false })')
    // set from the actual fulfilled/rejected status of each dataset
    expect(APP_SRC).toContain("farms: farmsResult.status === 'fulfilled'")
    expect(APP_SRC).toContain("inventory: inventoryResult.status === 'fulfilled'")
  })
})

describe('Operations Desk — mobile layout containment', () => {
  // The wide matters table must scroll inside a bounded container so the page
  // root never scrolls sideways on narrow viewports. `.ops-desk-table-scroll`
  // is that container; App.css scopes `overflow-x: auto` + `contain: paint` to
  // it (paint containment stops the scroll container's clipped overflow from
  // leaking into documentElement.scrollWidth). This repo's vitest cannot read
  // .css — `import.meta.glob('../App.css', '?raw')` yields '' — so the CSS half
  // is verified by browser acceptance; the structural half (the wrapper exists
  // and encloses the table) is guarded here against regression.
  it('wraps the matters table in a single desk-scoped scroll container', () => {
    const wrapperMarker = 'className="ops-desk-table-scroll"'
    const tableOpen = '<table className="ops-desk-table"'
    // exactly one wrapper — no accidental duplication or removal
    expect(PAGE_SRC.split(wrapperMarker).length - 1).toBe(1)
    const wrapperIdx = PAGE_SRC.indexOf(wrapperMarker)
    const tableOpenIdx = PAGE_SRC.indexOf(tableOpen)
    const tableCloseIdx = PAGE_SRC.indexOf('</table>')
    expect(wrapperIdx).toBeGreaterThan(-1)
    // the wrapper opens before the table and the table closes after it opens:
    // the table is nested inside the bounded scroll container.
    expect(tableOpenIdx).toBeGreaterThan(wrapperIdx)
    expect(tableCloseIdx).toBeGreaterThan(tableOpenIdx)
  })
})
