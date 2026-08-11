import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import './App.css'
import {
  getFarmProfiles,
  getInventoryBatches,
  persistInventory,
  persistFarms,
  createFarmProfile,
  updateFarmProfileStatus,
  createInventoryBatch,
  updateInventoryStatus,
  patchInventoryBatch,
  saveBatchInternalNote,
  createReviewRequest,
  resolveReviewRequest,
  loadReviewRequestsFromDB,
  loadAllReviewRequestsFromDB,
  loadMarketBenchmarksFromDB,
  loadFarmsFromDB,
  loadInventoryFromDB,
  loadFarmerInventoryFromDB,
  loadFarmerFarmsFromDB,
  uploadCoaFile,
  hashFileHex,
  recordCoaDocument,
  uploadBatchPhoto,
  recordBatchPhoto,
  getPhotoSignedUrl,
  getCoaSignedUrl,
  resetDemoData,
  isSupabaseConfigured,
  getFarmerScope,
  loadFarmerDocuments,
  type FarmerScope,
} from './lib/db'
import { loadInventory, loadFarms, loadReviewRequests, saveReviewRequests, loadMarketBenchmarks } from './data'
import { T } from './translations'
import { reportDbError, reportAppMessage, type DbErrorReport } from './lib/clientErrorReport'
import {
  signOut,
  subscribeToAuthChanges,
  getCurrentProfile,
  type UserProfile,
} from './services/auth'
import { resolvePostLoginDecision, resolveAuthResolutionAction } from './lib/postLoginRouting'
import { reviewRequestScopeKey, reviewRequestScopeChanged, scopeReviewRequestsToFarmer, deskReviewRequestsView } from './lib/reviewRequestScope'
import { loadStoredComplianceAlerts, loadStoredComplianceRules } from './lib/complianceLocalAlerts'
import { runGuardedLoad } from './lib/asyncLoadGuard'
import { commitMutation } from './lib/mutationCommit'
import { resolveAdminDataApply, deskAdminDataView } from './lib/adminDataLoad'
import { resolveDeskComplianceAlerts } from './lib/operationsDeskComplianceAlerts'
import { complianceRefetchStarted } from './lib/complianceRefetch'
import { startAuthBootstrapGuard } from './lib/authBootstrapGuard'
import type { Page, Lang, InventoryItem, FarmProfile, FarmStatus, InventoryStatus, ReviewRequest, MarketBenchmark, CarbonProgrammeStatus, ComplianceRule, ComplianceAlert, StoredPhoto } from './types'
import { fetchRules as fetchComplianceRules, fetchAlerts as fetchComplianceAlerts } from './lib/complianceRepository'
import { DDPMonogramLogo } from './components/logos'
import LandingPage from './pages/public/LandingPage'
import AboutPage from './pages/public/AboutPage'
import ContactPage from './pages/public/ContactPage'
import PrivacyPage from './pages/public/PrivacyPage'
import TermsPage from './pages/public/TermsPage'
import LocalisedBuyerPage from './pages/public/LocalisedBuyerPage'
import ThaiSupplierPage from './pages/public/ThaiSupplierPage'
import { RegulatoryHubPage, RegulatoryEntryPage } from './pages/public/RegulatoryUpdatesPage'
import { entryForPath } from './content/regulatoryEntries'
import LoginPage from './pages/public/LoginPage'
import SetPasswordPage from './pages/public/SetPasswordPage'
import ForgotPasswordPage from './pages/public/ForgotPasswordPage'
import FarmerRegister from './pages/farmer/FarmerRegister'
import FarmerPortal from './pages/farmer/FarmerPortal'
import FarmerOnboarding from './pages/farmer/FarmerOnboarding'
import FarmerAdvancedProfile from './pages/farmer/FarmerAdvancedProfile'
import FarmerMyStock from './pages/farmer/FarmerMyStock'
import FarmerSubmitInventory from './pages/farmer/FarmerSubmitInventory'
import BuyerDashboard from './pages/buyer/BuyerDashboard'
import FarmerRequests from './pages/farmer/FarmerRequests'
import FarmerStatus from './pages/farmer/FarmerStatus'
import FarmerEvidence from './pages/farmer/FarmerEvidence'
import DDPOverview from './pages/admin/DDPOverview'
import DDPFarmProfiles from './pages/admin/DDPFarmProfiles'
import DDPFarmReview from './pages/admin/DDPFarmReview'
import DDPInventoryDashboard from './pages/admin/DDPInventoryDashboard'
import DDPInventoryReview from './pages/admin/DDPInventoryReview'
import DDPMasterInventory from './pages/admin/DDPMasterInventory'
import DDPBuyerPreview from './pages/admin/DDPBuyerPreview'
import DDPMissingDocuments from './pages/admin/DDPMissingDocuments'
import DDPCoaIntelligence from './pages/admin/DDPCoaIntelligence'
import DDPRiskRegister from './pages/admin/DDPRiskRegister'
import DDPComplianceWatchtower from './pages/admin/DDPComplianceWatchtower'
import DDPOperationsDeskOrganic, { type FarmChase } from './pages/admin/DDPOperationsDeskOrganic'
import OrganicConsoleShell from './components/admin/OrganicConsoleShell'
import './styles/organicScoped.css'
import LangToggle from './components/shared/LangToggle'
import UserBadge from './components/shared/UserBadge'
import AccessDenied from './components/shared/AccessDenied'
import FarmerNav from './components/farmer/FarmerNav'
import FarmerMobileNav from './components/farmer/FarmerMobileNav'
import AdminNav from './components/admin/AdminNav'
import AdminShell from './components/admin/AdminShell'
import DDPAccessRequests from './pages/admin/DDPAccessRequests'
import DDPBuyerProvisioning from './pages/admin/DDPBuyerProvisioning'
import DDPDocumentReview from './pages/admin/DDPDocumentReview'
import SupplyLedgerTabs from './components/admin/SupplyLedgerTabs'
import { FARMER_PAGES, PUBLIC_AUTH_PAGES, PUBLIC_CORPORATE_PAGES, PUBLIC_PAGES, resolveNavigationTarget } from './lib/navigationGuard'
import { FARMER_PORTAL_DEFAULT_LANGUAGE, initialLanguage, storeLanguage } from './lib/languagePreference'
import { clearAuthRedirect, getAuthRedirect } from './lib/authRedirect'
import { getInitialPageFromPath, syncUrlToPage } from './lib/urlRouting'
import { applyPublicPageMetadata, metadataForPage } from './lib/publicPageMetadata'

// FARMER_PAGES / PUBLIC_PAGES and the routing decision live in
// lib/navigationGuard.ts so they can be unit tested. PUBLIC_PAGES once omitted
// 'farmer-register', which silently made the "Supplier signup" button a no-op
// for every signed-out visitor; navigationGuard.test.ts now asserts that every
// target a public surface links to is actually reachable.
const DDP_PAGES: Page[] = ['ddp-overview', 'ddp-farms', 'ddp-farm-review', 'ddp-inventory', 'ddp-inventory-review', 'ddp-master', 'ddp-buyer', 'ddp-missing-documents', 'ddp-coa-intelligence', 'ddp-risk-register', 'ddp-compliance-watchtower', 'ddp-operations-desk', 'ddp-access-requests', 'ddp-buyer-provisioning', 'ddp-document-review']
const SUPPLY_LEDGER_PAGES: Page[] = ['ddp-inventory', 'ddp-inventory-review', 'ddp-master', 'ddp-buyer', 'ddp-missing-documents', 'ddp-coa-intelligence', 'ddp-risk-register']

// ─── Main App ────────────────────────────────────────────────────────────────

export default function App() {
  // The invite / password-recovery redirect this page load arrived with, if any.
  //
  // The authority is the module-scope capture in lib/authRedirect.ts, which ran
  // before supabase-js could strip the fragment from the URL. This state is a
  // render-visible mirror of it — held as state, not a ref, so that clearing it
  // when the flow completes actually re-renders. Code running OUTSIDE render
  // (the auth subscription) reads getAuthRedirect() directly instead, so it can
  // never act on a stale closure of this value.
  const [authRedirect, setAuthRedirect] = useState(() => getAuthRedirect())

  // A user arriving from an invite or recovery link starts ON the set-password
  // screen. Landing them anywhere else — even for a moment — is the defect:
  // their session is transient, and once it lapses the account has no password
  // and no way to obtain one.
  const [page, setPage] = useState<Page>(() => {
    if (getAuthRedirect()) return 'set-password'
    // Honour deep-link paths (e.g. /farmer) on a cold load so a bookmarked or
    // QR-scanned URL reaches the right screen without requiring the user to
    // navigate from the landing page first.
    return getInitialPageFromPath(window.location.pathname) ?? 'landing'
  })
  // Opens in the farmer's own language, and remembers the choice. This was a
  // hardcoded 'en' that was never persisted, so a Thai farm scanning the QR
  // code landed on an English form with no way to change it — see
  // lib/languagePreference.ts.
  // The farm portal has its own opening language, held at English until its
  // Thai has been proofread — see FARMER_PORTAL_DEFAULT_LANGUAGE. Only the LAST
  // RESORT differs; a stored choice and the handset's own preference both still
  // win, so nobody's explicit choice is overridden either way.
  const [lang, setLangState] = useState<Lang>(() => initialLanguage(
    undefined,
    undefined,
    FARMER_PAGES.includes(getInitialPageFromPath(window.location.pathname) ?? 'landing')
      ? FARMER_PORTAL_DEFAULT_LANGUAGE
      : undefined,
  ))
  const setLang = useCallback((next: Lang) => {
    setLangState(next)
    storeLanguage(next)
  }, [])
  const [inventory, setInventory] = useState<InventoryItem[]>(() => getInventoryBatches())
  const [farms, setFarms] = useState<FarmProfile[]>(() => getFarmProfiles())
  const [reviewFarmId, setReviewFarmId] = useState<string | null>(null)
  const [reviewItemId, setReviewItemId] = useState<string | null>(null)
  // Carries the operator-facing message AND its correlation reference, so the
  // banner can show a code the user can quote to support without the message
  // itself ever carrying schema detail.
  const [dbError, setDbError] = useState<DbErrorReport | null>(null)
  const [buildVersion, setBuildVersion] = useState<string | null>(null)

  // Build/version identifier for release traceability — static file regenerated
  // every build by scripts/generate-version.js, no git dependency.
  useEffect(() => {
    fetch('/version.json')
      .then(res => (res.ok ? res.json() : null))
      .then(data => {
        if (data?.version && data?.builtAt) {
          setBuildVersion(`v${data.version} · built ${new Date(data.builtAt).toISOString().slice(0, 16).replace('T', ' ')}`)
        }
      })
      .catch(() => {})
  }, [])

  // Auth state — only meaningful when isSupabaseConfigured is true
  const [authLoading, setAuthLoading] = useState<boolean>(isSupabaseConfigured)
  const [currentProfile, setCurrentProfile] = useState<UserProfile | null>(null)
  // Guards the one-time bootstrap route: a restored session (page reload) is routed
  // to its role page exactly once, so later auth events (token refresh, StrictMode
  // duplicate init) never yank the operator off a page they navigated to.
  const didBootstrapRoute = useRef(false)

  // Identity+role key of the scope the shared reviewRequests state was loaded
  // for. When it changes (sign-out, admin↔farmer, a different user), the state
  // is dropped so the next role cannot inherit it. A repeat auth event for the
  // same user+role leaves it untouched (no clear/refetch loop on token refresh).
  const reviewScopeKeyRef = useRef<string | null>(null)

  // Farmer data scope — null until loaded, empty Sets if farmer has no data
  const [farmerScope, setFarmerScope] = useState<FarmerScope | null>(null)
  // Distinguishes "this farmer has no stock" from "we could not find out".
  // The catch below sets an EMPTY scope on failure, which makes every derived
  // farmer list compute to [] — indistinguishable from a genuinely new farm,
  // so a farmer whose load failed was told they had nothing and invited to add
  // their first listing. The admin side already tracks this; the farmer side
  // did not.
  const [farmerLoadFailed, setFarmerLoadFailed] = useState(false)
  // Documents DDP has handed back to this farmer (clarification or rejection).
  // null = not known yet or the read failed — never rendered as "nothing waiting".
  // Populated by the effect below isFarmerRole; see the comment there.
  const [farmerEvidenceWaiting, setFarmerEvidenceWaiting] = useState<number | null>(null)

  // Review requests (owner → farmer messages) and stock edit tracking
  const [reviewRequests, setReviewRequests] = useState<ReviewRequest[]>(() => loadReviewRequests())
  const [marketBenchmarks, setMarketBenchmarks] = useState<MarketBenchmark[]>(() => loadMarketBenchmarks())
  const [complianceRules, setComplianceRules] = useState<ComplianceRule[]>([])
  const [complianceAlerts, setComplianceAlerts] = useState<ComplianceAlert[]>([])
  // Load outcome for the compliance fetch below. The Operations Desk must be
  // able to tell "loaded and empty" apart from "could not load" so it never
  // presents a failed source as an all-clear. 'idle' means the fetch has not
  // settled yet, which the desk reads as still loading rather than as empty.
  const [complianceLoadState, setComplianceLoadState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  // The {profile, page} the compliance fetch was last (re)started for. Compared
  // during render to mark an imminent refetch as loading (see below), since the
  // fetch effect cannot set a loading flag synchronously without tripping
  // set-state-in-effect. `profile` is compared by identity to mirror the effect's
  // currentProfile dependency (so a token refresh is treated as a fresh fetch).
  const [complianceFetchTrigger, setComplianceFetchTrigger] = useState<{ profile: unknown; page: string } | null>(null)
  // Load outcome for the admin farm/inventory source, which feeds most desk
  // queues (approvals, onboarding, documents, COA, inventory review, risk). The
  // loaders now throw on error, so 'failed' is a real failure (not an empty DB).
  // 'ready' only after BOTH settle successfully (including a legitimate empty
  // result); the desk must not show an all-clear while this is idle/loading/failed.
  const [adminDataLoadState, setAdminDataLoadState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  // Per-dataset freshness for the CURRENT admin load. Only data the current load
  // fulfilled reaches the desk (see deskAdminDataView), so a stale farmer-scoped
  // subset lingering in the shared farms/inventory (the farmer loader merges,
  // never clears) cannot build desk rows/alerts while loading, and a rejected
  // dataset never leaks its retained prior rows — while the fulfilled half of a
  // partial failure still shows.
  const [adminDataAvailability, setAdminDataAvailability] = useState<{ farms: boolean; inventory: boolean }>({ farms: false, inventory: false })
  // The admin profile the farm/inventory load reflects — compared by identity
  // during render to mark a fresh load as loading (mirrors the effect's
  // currentProfile dependency) without a synchronous set-state-in-effect.
  const [adminDataFetchProfile, setAdminDataFetchProfile] = useState<unknown>(null)
  // Load outcome for the admin review-request fetch. Same three-state contract
  // as compliance: 'idle' = not yet settled (the desk shows loading, never a
  // premature zero), 'ready' = loaded (possibly empty), 'failed' = the desk
  // reports the gap instead of an all-clear. Only meaningful in Supabase admin
  // sessions — demo review requests live in memory and never load from a source.
  const [reviewRequestsLoadState, setReviewRequestsLoadState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  // The admin profile the review-request load reflects — compared by identity
  // during render to mark a refetch (e.g. a same-admin token refresh, which
  // replaces currentProfile without changing the scope key) as loading, so a
  // stale/hung refetch is never shown as a settled queue.
  const [reviewRequestsFetchProfile, setReviewRequestsFetchProfile] = useState<unknown>(null)
  const [stockEditItemId, setStockEditItemId] = useState<string | null>(null)
  const [buyerPackItemId, setBuyerPackItemId] = useState<string | null>(null)

  // ── Persist to localStorage on every state change ────────────────────────
  useEffect(() => { persistInventory(inventory) }, [inventory])
  useEffect(() => { persistFarms(farms) }, [farms])
  useEffect(() => { saveReviewRequests(reviewRequests) }, [reviewRequests])

  // ── URL ↔ page sync (deep links) ─────────────────────────────────────────
  // Keep the address bar consistent with the in-memory page state so that:
  //   • a QR scan or shared link that lands on /farmer stays on /farmer, and
  //   • pressing the browser Back button after entering via /farmer returns to
  //     the referrer (or the app landing page) rather than /farmer again.
  // See lib/urlRouting.ts for the path↔page mapping.
  useEffect(() => {
    syncUrlToPage(page)
  }, [page])

  // Browser Back / Forward: when the user navigates via history, map the new
  // pathname back to a page (or fall back to 'landing').
  //
  // This calls setPage directly rather than goTo, so it does NOT run
  // resolveNavigationTarget. That is only safe because every path in
  // urlRouting's PATH_TO_PAGE maps to a PUBLIC page, which the guard would
  // admit for any visitor anyway. urlRouting.test.ts enforces that invariant —
  // if someone adds a farmer or admin route to the map, that test fails and
  // this handler must be routed through the guard before the route ships.
  useEffect(() => {
    function handlePopState() {
      const mapped = getInitialPageFromPath(window.location.pathname)
      setPage(mapped ?? 'landing')
      window.scrollTo(0, 0)
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  // ── Auth subscription ────────────────────────────────────────────────────
  // authLoading is initialised to false in demo mode via useState, so no
  // synchronous setState is needed in the early-return branch.
  // Bootstrap guard. `authLoading` was cleared ONLY by the callback below, with no
  // timeout and no error path, so a Supabase client that never emitted its first
  // auth event pinned the app on the "Loading…" screen indefinitely — a permanent
  // blue page on the public domain with no route to the landing page or sign-in.
  // The realistic trigger is a stale stored session whose refresh hangs.
  //
  // Timing out ends auth RESOLUTION, it does not grant anything: currentProfile
  // stays null, so this renders exactly the signed-out public app and every
  // downstream permission check still fails closed. A late event is still
  // honoured — bootstrap routing runs on first resolution either way.
  useEffect(() => {
    if (!isSupabaseConfigured) return
    const cancel = startAuthBootstrapGuard(() => {
      setAuthLoading((stillLoading) => {
        if (stillLoading) {
          console.warn(
            'Auth bootstrap timed out before any auth event arrived — rendering the ' +
            'signed-out app. No session was established.',
          )
        }
        return false
      })
    })
    return cancel
  }, [])

  useEffect(() => {
    if (!isSupabaseConfigured) return
    const unsubscribe = subscribeToAuthChanges((profile) => {
      setCurrentProfile(profile)
      setAuthLoading(false)
      // Clear scope on sign-out or when a non-farmer profile appears
      if (!profile || profile.role !== 'farmer') setFarmerScope(null)
      // Cross-role data isolation: drop review-request state loaded for a
      // previous authenticated scope so the next role can never inherit it.
      // Keyed on {userId, role}; a token refresh for the same user+role does
      // not match, so it neither clears the farmer's own data nor loops. Runs
      // only in Supabase mode (this effect early-returns in demo), so seeded
      // demo review requests are never cleared.
      const nextScopeKey = reviewRequestScopeKey(profile)
      if (reviewRequestScopeChanged(reviewScopeKeyRef.current, nextScopeKey)) {
        reviewScopeKeyRef.current = nextScopeKey
        setReviewRequests([])
        setReviewRequestsLoadState('idle')
        // Fail closed on a {userId, role} scope change (farmer↔admin, admin A→B,
        // sign-out): drop the shared farm/inventory arrays and their availability
        // and selected detail ids so NO admin page — not just the Operations Desk
        // — can render a previous scope's rows before this scope's load settles.
        // A same-admin token refresh keeps the same key, so it is not cleared here
        // (the loaders clear a rejected dataset themselves once it definitively
        // fails). Runs only in Supabase mode (this effect early-returns in demo).
        setFarms([])
        setInventory([])
        setAdminDataAvailability({ farms: false, inventory: false })
        setReviewFarmId(null)
        setReviewItemId(null)
      }
      // Bootstrap routing: on the FIRST auth resolution after a (re)load, route a
      // restored session to its role page (a reload resets `page` to the public
      // landing). Guarded to run once so later events cannot override navigation.
      //
      // The decision — including the revoke-session branch below and the
      // suppression that keeps an invited supplier on the set-password screen —
      // is pure and lives in lib/postLoginRouting.ts, where it is unit-tested.
      // This block keeps only the side effects.
      //
      // revoke-session is defence in depth: a FRESH login by an unresolved-role
      // (e.g. 'pending') account is denied AND its session revoked
      // (handleLoginSuccess's fail-closed branch), but a page reload restored
      // that same session intact — bootstrap correctly declined to route, yet
      // the session survived and isSignedIn became true. Nothing is reachable
      // through it (no nav affordance renders, DDP pages fail closed to
      // AccessDenied, RLS denies the reads); this closes the asymmetry so both
      // entry paths agree the session must not persist.
      const { routed, action } = resolveAuthResolutionAction({
        alreadyRouted: didBootstrapRoute.current,
        profile,
        passwordSetupPending: getAuthRedirect() !== null,
      })
      didBootstrapRoute.current = routed
      if (action.kind === 'route') {
        setPage(action.page)
        window.scrollTo(0, 0)
      } else if (action.kind === 'revoke-session') {
        void signOut()
        setCurrentProfile(null)
      }
    })
    return unsubscribe
  }, [])

  // ── Load farmer scope + actual inventory rows when a farmer signs in ────────
  useEffect(() => {
    if (!isSupabaseConfigured || !currentProfile || currentProfile.role !== 'farmer') return
    // Stale-load guard: flipped false in cleanup when the session changes. Every
    // continuation below checks it before touching shared state, so a farmer load
    // still in flight when the operator switches to admin (or signs out) can never
    // overwrite the now-active scope's reviewRequests — the account-switch race.
    let active = true
    getFarmerScope(currentProfile.id)
      .then(async scope => {
        if (!active) return
        const [dbFarms, dbInventory, dbRequests] = await Promise.all([
          loadFarmerFarmsFromDB(scope.farmIds),
          loadFarmerInventoryFromDB(scope.itemIds, scope.farmIds),
          loadReviewRequestsFromDB(currentProfile.id, scope.farmIds, scope.itemIds),
        ])
        // Superseded while loading → drop every result; do not touch state.
        if (!active) return
        setFarmerLoadFailed(false)
        setFarmerScope(scope)
        // Populate farmer's farm profiles so Add Stock can resolve selectedFarm
        // and write farm_id correctly on every new batch submission.
        if (dbFarms.length > 0) {
          setFarms(prev => {
            const sbIds = new Set(dbFarms.map(f => f.id))
            return [...dbFarms, ...prev.filter(f => !sbIds.has(f.id))]
          })
        }
        // Merge Supabase inventory rows into state, replacing any matching IDs.
        if (dbInventory.length > 0) {
          setInventory(prev => {
            const sbIds = new Set(dbInventory.map(i => i.id))
            return [...dbInventory, ...prev.filter(i => !sbIds.has(i.id))]
          })
        }
        // Replace unconditionally — INCLUDING with []. A farmer with zero
        // scoped requests must overwrite any prior state (e.g. an admin-wide
        // list from earlier in the same SPA session), never retain it.
        setReviewRequests(dbRequests)
      })
      .catch(err => {
        if (!active) return
        console.warn('getFarmerScope / data load failed:', err)
        setFarmerLoadFailed(true)
        setFarmerScope({ farmIds: new Set(), itemIds: new Set() })
        // Fail closed: a failed farmer load must not leave prior (possibly
        // admin-wide) requests visible.
        setReviewRequests([])
      })
    return () => { active = false }
  }, [currentProfile])

  // ── Load all farms + inventory from Supabase when admin signs in ────────────
  // Loaded with allSettled: the Operations Desk source is 'ready' only when BOTH
  // succeed, and 'failed' if either loader throws (partial failure included), so
  // the desk reports the gap rather than a false all-clear. The fulfilled half of
  // a partial failure is still applied. A REJECTED dataset is CLEARED (not
  // retained) once the load has definitively failed, and its selected detail id
  // is dropped, so no admin page — Farm/Inventory Review included — can reuse a
  // stale/prior-scope row. (A same-admin token refresh keeps prior rows only
  // WHILE pending; this runs after the load settles.) The imminent 'loading'
  // state is set during render (see the trigger below); the active guard drops a
  // superseded or hung load after an account switch so it cannot repopulate.
  useEffect(() => {
    if (!isSupabaseConfigured || !currentProfile || currentProfile.role !== 'ddp_admin') return
    let active = true
    runGuardedLoad(Promise.allSettled([loadFarmsFromDB(), loadInventoryFromDB()]), () => active, {
      onSuccess: ([farmsResult, inventoryResult]) => {
        const plan = resolveAdminDataApply(farmsResult, inventoryResult)
        if (plan.farms.kind === 'set') setFarms(plan.farms.value)
        else { console.warn('Admin farms load failed:', farmsResult.status === 'rejected' ? farmsResult.reason : ''); setFarms([]) }
        if (plan.inventory.kind === 'set') setInventory(plan.inventory.value)
        else { console.warn('Admin inventory load failed:', inventoryResult.status === 'rejected' ? inventoryResult.reason : ''); setInventory([]) }
        if (plan.clearFarmDetail) setReviewFarmId(null)
        if (plan.clearItemDetail) setReviewItemId(null)
        setAdminDataLoadState(plan.state)
        setAdminDataAvailability({ farms: plan.farmsAvailable, inventory: plan.inventoryAvailable })
      },
      onError: err => {
        // Promise.allSettled does not reject; defensive fallback only.
        console.warn('Admin Supabase data load failed:', err)
        setAdminDataLoadState('failed')
      },
    })
    return () => { active = false }
  }, [currentProfile])

  // ── Load all review requests from Supabase when admin signs in ──────────────
  // The farmer effect above populates reviewRequests only within a farmer's own
  // batch scope, and browser persistence is disabled outside demo mode — so
  // without this effect an administrator's Operations Desk follow-up queue would
  // be empty after a login or hard reload (or briefly reflect stale farmer-scoped
  // state). The `farmer_review_requests: admin all` RLS policy lets an admin read
  // every row; loadAllReviewRequestsFromDB performs no write. The result REPLACES
  // state unconditionally — including [] — so no stale farmer-scoped request can
  // survive into an admin view. A load failure is surfaced as an unavailable
  // source (below), never as a confirmed zero.
  // reviewRequestsLoadState starts 'idle' (its useState default), so the fetch
  // for a fresh admin login or reload begins in the loading state without a
  // synchronous reset here. Only this admin effect ever changes it, and it
  // settles to 'ready'/'failed' in the async callbacks below.
  useEffect(() => {
    if (!isSupabaseConfigured || !currentProfile || currentProfile.role !== 'ddp_admin') return
    // Symmetric stale-load guard: a stale admin load must not overwrite the new
    // farmer-scoped state after a switch, nor repopulate anything after sign-out.
    let active = true
    runGuardedLoad(loadAllReviewRequestsFromDB(), () => active, {
      onSuccess: requests => {
        setReviewRequests(requests)
        setReviewRequestsLoadState('ready')
      },
      onError: err => {
        console.warn('Admin review requests load failed:', err)
        setReviewRequestsLoadState('failed')
      },
    })
    return () => { active = false }
  }, [currentProfile])

  // ── Load market benchmarks from Supabase once a farmer session exists ────
  // (RLS restricts this table to authenticated farmers — querying it before
  // login just produces an anonymous-read 401 with no farmer-facing benefit.)
  useEffect(() => {
    if (!isSupabaseConfigured || !currentProfile) return
    loadMarketBenchmarksFromDB()
      .then(benchmarks => { if (benchmarks.length > 0) setMarketBenchmarks(benchmarks) })
      .catch(err => console.warn('loadMarketBenchmarksFromDB failed:', err))
  }, [currentProfile])

  // ── Load compliance rules + alerts for admin so approved/active rules can
  // surface a read-only "Compliance Rule Check" signal on Supply Ledger
  // pages. Fails quietly — Supply Ledger pages already work fully without
  // this data, and no impact is ever shown if the fetch doesn't succeed.
  //
  // Refetches on every Supply Ledger page entry (not just on login) — this
  // state is a read-only snapshot separate from Compliance Watchtower's own
  // local rule/alert state, and a rule approved/paused or an alert resolved
  // in the Watchtower would otherwise not be reflected here until the whole
  // app reloaded. Re-running on page navigation is the minimal fix that
  // closes that staleness window without merging the two states.
  useEffect(() => {
    if (!isSupabaseConfigured || !currentProfile || currentProfile.role !== 'ddp_admin') return
    // The Operations Desk reads the same alert snapshot, so it refetches on
    // entry for the same staleness reason the Supply Ledger pages do. The
    // imminent 'loading' state is set during render (see the fetch-trigger block
    // below), because it cannot be set synchronously here. The active guard drops
    // a superseded or hung refetch so a stale result cannot overwrite a newer one.
    if (!SUPPLY_LEDGER_PAGES.includes(page) && page !== 'ddp-operations-desk') return
    let active = true
    runGuardedLoad(Promise.all([fetchComplianceRules(), fetchComplianceAlerts()]), () => active, {
      onSuccess: ([rules, alerts]) => {
        setComplianceRules(rules)
        setComplianceAlerts(alerts)
        setComplianceLoadState('ready')
      },
      onError: err => {
        console.warn('Compliance rule impact data load failed:', err)
        setComplianceLoadState('failed')
      },
    })
    return () => { active = false }
  }, [currentProfile, page])

  // ── Role helpers ─────────────────────────────────────────────────────────
  // In demo mode (no Supabase), everything is open — preserve existing behaviour.
  const isDemo = !isSupabaseConfigured
  const isSignedIn = isDemo || currentProfile !== null
  const isAdminRole = isDemo || currentProfile?.role === 'ddp_admin'
  const isFarmerRole = !isDemo && currentProfile?.role === 'farmer'

  // ── How many of the farmer's documents DDP has handed back to them ───────
  //
  // Loaded HERE rather than inside FarmerEvidence because the NAVBAR needs the
  // number: a farmer working in My Stock — which is where they would go to fix a
  // document — must be able to see that DDP is waiting without first visiting the
  // page that would tell them. FarmerEvidence still loads its own rows; this is a
  // count, not a shared row cache, so it introduces no window in which one farm's
  // documents could be rendered to another.
  //
  // null means "not known yet, or the read failed", and is deliberately NOT 0.
  // A failed read must render no badge rather than an absent one, because "DDP is
  // waiting on nothing" is the one thing this must never say wrongly — the same
  // rule FarmerEvidence and FarmerMyStock already follow for their empty states.
  //
  // Re-read on navigation (`page`) so acting on a document updates the badge
  // without a reload, matching how the Operations Desk refreshes on entry.
  useEffect(() => {
    if (isDemo || !isSupabaseConfigured || !isFarmerRole) return
    let active = true
    runGuardedLoad(loadFarmerDocuments(), () => active, {
      onSuccess: docs => setFarmerEvidenceWaiting(
        docs.filter(d => d.reviewStatus === 'awaiting_clarification' || d.reviewStatus === 'rejected').length,
      ),
      // Silent by design: a badge is an affordance, not a report. FarmerEvidence
      // itself states the failure loudly when the farmer opens it.
      onError: () => setFarmerEvidenceWaiting(null),
    }).catch(() => undefined)
    return () => { active = false }
  }, [isDemo, isFarmerRole, page])

  /**
   * Fail-closed projection of that count, and the reason it is derived rather
   * than cleared inside the effect above.
   *
   * Outside a real farmer session this is null whatever a previous session left
   * in state, so a number belonging to a farmer who has signed out — or to the
   * farmer an admin just switched away from — can never reach the navbar. Same
   * shape and same reason as the scopeReviewRequestsToFarmer projection below:
   * farmer surfaces consume the guarded value, never the raw state.
   *
   * Clearing it with a setState in the effect body would have achieved this too,
   * and would have cost a second render pass on every navigation to say nothing
   * new. The lint rule that rejects that is right.
   */
  const farmerEvidenceWaitingSafe = isDemo || !isFarmerRole ? null : farmerEvidenceWaiting

  const isBuyerRole = !isDemo && currentProfile?.role === 'buyer'
  const isFarmerPage = FARMER_PAGES.includes(page)
  // Derived — true while a farmer's scope is being fetched from Supabase
  const scopeLoading = isFarmerRole && farmerScope === null

  // Mark the compliance queue as loading the moment a refetch becomes imminent.
  // The fetch effect above re-runs whenever {currentProfile, page} changes onto
  // the Operations Desk, but it cannot flip a loading flag synchronously (that is
  // set-state-in-effect). We detect the same change here during render — React's
  // supported "adjust state while rendering" — and move the load state to
  // 'loading', so the desk never presents a stale 'ready' snapshot as an
  // all-clear while a refetch (including a slow or hung one) is in flight.
  // `profile` is compared by identity to mirror the effect's currentProfile dep,
  // so a token-refresh refetch is also shown as loading; the trigger clears on
  // leaving so a return to the desk is detected as a fresh entry.
  const onOperationsDeskAsAdmin =
    !isDemo && currentProfile?.role === 'ddp_admin' && page === 'ddp-operations-desk'
  if (onOperationsDeskAsAdmin) {
    if (complianceRefetchStarted(complianceFetchTrigger, { profile: currentProfile, page })) {
      setComplianceFetchTrigger({ profile: currentProfile, page })
      if (complianceLoadState !== 'loading') setComplianceLoadState('loading')
    }
  } else if (complianceFetchTrigger !== null) {
    setComplianceFetchTrigger(null)
  }

  // Mark the admin farm/inventory source as loading the moment its load becomes
  // imminent. The effect above keys on currentProfile, so the same render-time
  // "adjust state" approach is used (a synchronous setState in that effect would
  // trip set-state-in-effect). Keyed on the admin profile by identity, so a fresh
  // admin login or a token refresh starts a new pending load; cleared on
  // sign-out / farmer so a later admin re-login is detected as a fresh load.
  const adminDataProfile = !isDemo && currentProfile?.role === 'ddp_admin' ? currentProfile : null
  if (adminDataProfile !== null) {
    if (adminDataFetchProfile !== adminDataProfile) {
      setAdminDataFetchProfile(adminDataProfile)
      if (adminDataLoadState !== 'loading') setAdminDataLoadState('loading')
      // A new admin load starts with neither dataset fresh, so no stale array
      // reaches the desk until this load fulfils each one.
      if (adminDataAvailability.farms || adminDataAvailability.inventory) {
        setAdminDataAvailability({ farms: false, inventory: false })
      }
    }
  } else if (adminDataFetchProfile !== null) {
    setAdminDataFetchProfile(null)
  }

  // Mark the admin review-request load pending the moment a (re)fetch becomes
  // imminent — the effect keys on currentProfile, so a same-admin token refresh
  // re-runs it while the scope-key guard leaves the state 'ready'. Detect the
  // profile-identity change during render (like the compliance and farm/inventory
  // loaders) and move to 'loading', so a slow/hung refetch is never presented as
  // a settled queue and no all-clear is shown. Cleared on sign-out / farmer so an
  // admin re-login is a fresh load.
  if (adminDataProfile !== null) {
    if (reviewRequestsFetchProfile !== adminDataProfile) {
      setReviewRequestsFetchProfile(adminDataProfile)
      if (reviewRequestsLoadState !== 'loading') setReviewRequestsLoadState('loading')
    }
  } else if (reviewRequestsFetchProfile !== null) {
    setReviewRequestsFetchProfile(null)
  }

  // ── Scoped data for farmer pages ─────────────────────────────────────────
  // In demo mode or for admin, pass everything through unchanged.
  // For a signed-in farmer in Supabase mode, filter to only their owned records.
  // While the scope is loading (farmerScope === null), use empty arrays so the
  // farmer never sees other users' data.
  const farmerFarms: FarmProfile[] = isDemo || !isFarmerRole
    ? farms
    : farmerScope !== null
      ? farms.filter(f => farmerScope.farmIds.has(f.id))
      : []

  const farmerInventory: InventoryItem[] = isDemo || !isFarmerRole
    ? inventory
    : farmerScope !== null
      ? inventory.filter(i =>
          farmerScope.itemIds.has(i.id) ||
          (i.farmId != null && farmerScope.farmIds.has(i.farmId))
        )
      : []

  // Review requests, scoped for farmer pages the same way. The shared
  // reviewRequests array also feeds the admin Operations Desk (all requests),
  // so farmer pages must consume this fail-closed projection — never the raw
  // state — to guarantee no admin-wide request is shown to a farmer before,
  // during, or after their own scope loads (scopeReviewRequestsToFarmer returns
  // [] while farmerScope is null).
  const farmerReviewRequests: ReviewRequest[] = isDemo || !isFarmerRole
    ? reviewRequests
    : scopeReviewRequestsToFarmer(reviewRequests, farmerScope)

  // What the admin Operations Desk receives for review requests: null on a
  // failed fetch; [] + loading while still settling (first load or a refetch —
  // including a same-admin token refresh — so a stale/empty queue is never shown
  // as current and no all-clear appears); the loaded rows once ready.
  const deskReviewRequests = useMemo(
    () => deskReviewRequestsView(isDemo, reviewRequestsLoadState, reviewRequests),
    [isDemo, reviewRequestsLoadState, reviewRequests],
  )

  // Demo-only compliance alerts for the Operations Desk. In demo mode the App's
  // fetched `complianceAlerts` stays [] (the Supabase fetch effect early-returns),
  // but the Compliance Watchtower persists manual alerts to a shared local store.
  // Reading it here — recomputed on navigation (`page` dep) — lets a manual alert
  // created in the Watchtower appear on the desk on entry without a full reload.
  // Supabase mode is untouched: the desk keeps using the fetched `complianceAlerts`.
  const demoComplianceAlerts = useMemo<ComplianceAlert[] | null>(
    () => (isDemo && page === 'ddp-operations-desk' ? loadStoredComplianceAlerts() : null),
    [isDemo, page],
  )

  // Demo rules for the desk's alert derivation: the SAME mutable store the
  // Watchtower reads/writes (ddp_compliance_rules, baseline as fallback), read
  // on desk entry (`page` dep) so a rule an operator approved/activated in the
  // Watchtower is honoured in the same tab without a reload. Supabase mode uses
  // the fetched rules instead.
  const demoComplianceRules = useMemo<ComplianceRule[] | null>(
    () => (isDemo && page === 'ddp-operations-desk' ? loadStoredComplianceRules() : null),
    [isDemo, page],
  )

  // Farm/inventory the Operations Desk may safely consume: only data the CURRENT
  // admin load fulfilled (demo passes its settled seeded data through). So a
  // stale farmer-scoped subset lingering in the shared arrays, or a rejected
  // dataset's retained rows, never build desk queue rows or rule-derived alerts —
  // while the fulfilled half of a partial failure still shows. The shared arrays
  // are untouched, so other admin pages keep any retained rows.
  const deskData = useMemo(
    () => deskAdminDataView(isDemo, farms, inventory, adminDataAvailability.farms, adminDataAvailability.inventory),
    [isDemo, farms, inventory, adminDataAvailability],
  )

  // The compliance alerts the Operations Desk sees must match the Watchtower:
  // rule-derived alerts (from ENFORCED rules) merged with the persisted/stored
  // alerts, deduplicated by id — otherwise an enforced rule generating an
  // unresolved auto alert (e.g. BATCH_COA_REQUIRED) is invisible and the queue
  // shows a false all-clear. Rules: the demo store in demo mode, the fetched
  // rules in Supabase mode. Rule-derived alerts use only the fresh desk farms/
  // inventory (never stale), while persisted/manual alerts stay visible even when
  // farm/inventory data is unavailable. Auto alerts are derived here for display,
  // never persisted. Failure still passes null so the desk reports the gap.
  const deskComplianceAlerts = useMemo<ComplianceAlert[] | null>(
    () => resolveDeskComplianceAlerts(
      !isDemo && complianceLoadState === 'failed',
      deskData.farms,
      // Unavailable inventory (null) derives no batch rule-alerts — rule-derived
      // alerts use only current-load-fresh data; farm-rule alerts still derive.
      deskData.inventory ?? [],
      isDemo ? (demoComplianceRules ?? []) : complianceRules,
      (isDemo ? demoComplianceAlerts : complianceAlerts) ?? [],
    ),
    [isDemo, complianceLoadState, deskData, demoComplianceRules, complianceRules, demoComplianceAlerts, complianceAlerts],
  )

  // ── Error handler ────────────────────────────────────────────────────────
  // The raw Postgres/PostgREST message used to be stored here and rendered
  // verbatim by the banner — routinely naming policies, tables, columns and
  // constraints to end users, farmers included. reportDbError maps it to a
  // stable operator-facing message plus a correlation id, keeps the raw text in
  // console.error where it already went, and emits one schema-free structured
  // log line carrying the same id. Same pattern as api/compliance/ai-summary.ts.
  function onDbError(err: unknown) {
    setDbError(reportDbError(err, page))
  }

  // Passed as onBegin to commitMutation: clears any stale error banner the
  // instant an action is attempted, so the banner survives any navigation that
  // action triggers while still being cleared before the new attempt's outcome
  // is known.
  function onBeginAction() { setDbError(null) }

  // ── Navigation ───────────────────────────────────────────────────────────
  // The public pages are cream; the app shell is navy. .public-auth-shell only
  // covers <main>, so body kept painting navy behind it — visible during route
  // transitions and on overscroll. Tag the document instead, and let CSS own it.
  useEffect(() => {
    // Derived from PUBLIC_AUTH_PAGES rather than an inline page !== chain, so a
    // new auth screen cannot be added without picking up the cream treatment.
    //
    // The corporate pages need the same body paint for the same reason: their
    // .corp-shell covers the layout, not the document, so on a rubber-band
    // overscroll the navy body shows behind a cream page. The class name says
    // "auth" for historical reasons — what it actually does is paint the
    // document cream, which both families of public page want.
    const isPublicAuthPage = PUBLIC_AUTH_PAGES.includes(page) || PUBLIC_CORPORATE_PAGES.includes(page)
    document.body.classList.toggle('public-auth-page', isPublicAuthPage)
    return () => document.body.classList.remove('public-auth-page')
  }, [page])

  // Sync the HTML lang attribute so CSS :lang(th) selectors work and
  // screen readers announce the correct language.
  //
  // A PAGE THAT DECLARES ITS OWN LANGUAGE OUTRANKS THE EN/TH TOGGLE. /de is
  // written in German and is not a translation of the app — 'de' is not a Lang
  // — so before this, the prerendered document arrived correctly as
  // <html lang="de"> and this effect immediately overwrote it with 'en'. The
  // served bytes and the rendered DOM then disagreed about what language the
  // page was in, which is precisely the disagreement a rendering crawler
  // resolves against the DOM.
  useEffect(() => {
    document.documentElement.lang = metadataForPage(page).lang ?? lang
  }, [lang, page])

  // Keep the document head describing the page actually on screen.
  //
  // index.html carries one title and one description, and vercel.json serves
  // that one document for every path — so without this, /about, /privacy and
  // /terms would all present a crawler with the landing page's metadata and no
  // canonical of their own. Every value comes from the static register in
  // lib/publicPageMetadata.ts, keyed only by `page`: no caller can pass a title
  // in, so no farm name, batch id or buyer identity can reach the head, where a
  // crawler and the browser history would both pick it up.
  //
  // It runs on EVERY page change, not only for the corporate pages. That is the
  // "stale metadata must not survive navigation" rule: pages outside the
  // register resolve to a fail-closed noindex entry, so navigating from a public
  // page into the application replaces the indexable metadata rather than
  // leaving it in place.
  useEffect(() => {
    applyPublicPageMetadata(document, page)
  }, [page])

  function goTo(p: Page) {
    // The decision itself is pure and lives in lib/navigationGuard.ts; this
    // function keeps only the side effects.
    const target = resolveNavigationTarget(p, { isDemo, isSignedIn, isAdminRole, isBuyerRole })
    // DO NOT CLEAR dbError HERE. An earlier revision of this fix did, and it was
    // wrong in a way worth recording.
    //
    // The banner is genuinely too sticky — setDbError(null) appears only on the
    // ✕ button, so one failed write pins an error to every screen until somebody
    // dismisses it. But clearing on NAVIGATION breaks a worse case:
    // handleInventorySubmit commits a batch, then uploads the COA as a SEPARATE
    // commitMutation. If that upload fails it raises the error and still returns
    // true, so the caller navigates — and a clear here would wipe the error on
    // the way out. The farmer would leave believing the COA was attached when the
    // batch has none. That is the exact silent-failure this codebase exists to
    // avoid, traded for a cosmetic improvement.
    //
    // The right fix is to clear when an ACTION BEGINS, not when a page changes,
    // so an error raised by the action survives the navigation that action causes.
    // commitMutation is a pure lib function with no access to this state, so that
    // means threading a new handler through every call site — a design change,
    // and its own PR. Deliberately not bundled here with an urgent data-loss fix.
    setPage(target)
    window.scrollTo(0, 0)
  }

  async function handleSignOut() {
    await signOut()
    setCurrentProfile(null)
    setPage('landing')
    window.scrollTo(0, 0)
  }

  // After a successful sign-in, route the user by their resolved role. The
  // redesigned public homepage no longer exposes the farmer/admin entry buttons,
  // so this is the only path into the operator portals — it must land signed-in
  // users on their dashboard, and fail closed if the role cannot be resolved.
  async function handleLoginSuccess() {
    const profile = await getCurrentProfile()
    const decision = resolvePostLoginDecision(profile)
    if (decision.kind === 'route') {
      // Set the profile before navigating so goTo's auth guards see a signed-in
      // user (the async auth subscription may not have fired yet).
      setCurrentProfile(profile)
      setPage(decision.page)
      window.scrollTo(0, 0)
      return
    }
    // Fail closed: authenticated but no known operator role — revoke the session
    // and send the user back to login with a clear message.
    await signOut()
    setCurrentProfile(null)
    setDbError(reportAppMessage('Your account does not have an assigned DDP role. Please contact DDP support.'))
    setPage('login')
    window.scrollTo(0, 0)
  }

  // Called once the password has actually been saved. Ends the redirect flow —
  // clearing the capture also scrubs the spent token from the address bar, so a
  // reload cannot re-enter the screen — then routes by role through the SAME
  // decision a normal sign-in uses, including its fail-closed branch for an
  // account with no operator role.
  async function handleSetPasswordComplete() {
    clearAuthRedirect()
    setAuthRedirect(null)
    await handleLoginSuccess()
  }

  // Leaving the set-password screen to request a fresh link. The redirect is
  // cleared because the token it carried is spent or expired — keeping it would
  // send the user straight back to the dead screen on the next auth event.
  function goToForgotPassword() {
    clearAuthRedirect()
    setAuthRedirect(null)
    goTo('forgot-password')
  }

  // ── Data handlers ─────────────────────────────────────────────────────────
  // Returns true only when the batch itself was accepted by the database. The
  // caller navigates on that return value, never unconditionally: awaiting a
  // handler that resolves identically on success and failure told the caller
  // nothing, so a rejected insert still sent the farmer to a stock list that
  // did not contain their submission.
  async function handleInventorySubmit(
    item: InventoryItem,
    coaFile?: File | null,
    photoFiles?: File[],
  ): Promise<boolean> {
    // The batch must exist in the database before the farmer is shown it, and
    // before their scope is widened to include it. The previous ordering showed
    // a submitted batch — and granted scope over it — even when the insert was
    // rejected, so a failed submission looked identical to a successful one.
    const created = await commitMutation(
      () => createInventoryBatch(item, currentProfile?.id),
      {
        onBegin: onBeginAction,
        onCommitted: () => {
          setInventory(prev => {
            const exists = prev.some(i => i.id === item.id)
            return exists ? prev.map(i => i.id === item.id ? item : i) : [item, ...prev]
          })
          if (isFarmerRole) {
            setFarmerScope(prev => {
              const base = prev ?? { farmIds: new Set<string>(), itemIds: new Set<string>() }
              const newFarmIds = item.farmId
                ? new Set([...base.farmIds, item.farmId])
                : base.farmIds
              return { farmIds: newFarmIds, itemIds: new Set([...base.itemIds, item.id]) }
            })
          }
        },
        onError: onDbError,
      },
    )
    if (!created) return false

    // COA attachment is a separate step with its own failure path: the batch is
    // already committed, so a failed upload must surface as a missing-document
    // error rather than discarding the submission. The file is uploaded before
    // the metadata is written, so the row never advertises a COA that is absent.
    if (coaFile && isSupabaseConfigured && isFarmerRole && currentProfile && item.id) {
      await commitMutation(
        async () => {
          // Hash BEFORE the upload, from the same File the uploader receives, so
          // the digest describes exactly the bytes that were sent. Hashing after
          // a round trip would only prove two reads agreed.
          //
          // Deliberately not tolerant of a hashing failure. The register exists
          // to support one claim — that a document is unchanged since upload —
          // and a row without a digest cannot support it. An unhashed entry
          // would be worse than a loud failure, because it would look complete.
          const digest = await hashFileHex(coaFile)

          const { storagePath } = await uploadCoaFile(
            coaFile,
            currentProfile.id,
            item.farmId ?? '',
            item.id,
          )
          await patchInventoryBatch(item.id, {
            coa_file_name: coaFile.name,
            coa_available: true,
            coa_storage_path: storagePath,
          })
          // The evidence register. Written last, after the bytes exist and the
          // batch points at them, so the register can never name a document
          // that is absent. Before this call the platform stored certificates
          // it had no record of: files in the bucket, zero rows in the register
          // those files were meant to be catalogued by.
          await recordCoaDocument({
            farmId: item.farmId,
            batchId: item.id,
            fileName: coaFile.name,
            storagePath,
            sha256Hex: digest,
          })
          return storagePath
        },
        {
          onBegin: onBeginAction,
          onCommitted: (storagePath) => {
            setInventory(prev => prev.map(i =>
              i.id === item.id
                ? { ...i, certFileName: coaFile.name, coaAvailable: true, coaStoragePath: storagePath }
                : i
            ))
          },
          onError: onDbError,
        },
      )
    }
    // Photos, same shape as the COA attachment above and for the same reasons:
    // the batch is already committed, so a failed photo upload must surface as an
    // error rather than discard the submission.
    //
    // Each photo is uploaded THEN recorded, never the reverse — a farmer_photos
    // row written before its bytes would point at nothing. Photos are uploaded
    // one at a time and independently: one rejected image (a HEIC the browser
    // mislabels, a file that grew past the cap) must not throw away the others.
    //
    // Before this existed, every attached photo was silently dropped on save with
    // no warning, so a farmer believed photos were on file when none were.
    if (photoFiles?.length && isSupabaseConfigured && isFarmerRole && currentProfile && item.id) {
      await commitMutation(
        async () => {
          const stored: StoredPhoto[] = []
          const failures: string[] = []
          for (const file of photoFiles) {
            try {
              const { storagePath } = await uploadBatchPhoto(
                file,
                currentProfile.id,
                item.farmId ?? '',
                item.id,
              )
              stored.push(await recordBatchPhoto({
                farmId: item.farmId,
                batchId: item.id,
                storagePath,
              }))
            } catch (err) {
              failures.push(file.name)
              console.error('Photo attachment failed', file.name, err)
            }
          }
          // Report a partial failure loudly. Returning quietly here would tell the
          // farmer every photo was saved when some were not — the exact deception
          // this whole change exists to remove.
          if (failures.length > 0) {
            const err = new Error(
              `${failures.length} of ${photoFiles.length} photo(s) failed to attach: ${failures.join(', ')}`,
            )
            ;(err as Error & { partial?: StoredPhoto[] }).partial = stored
            throw err
          }
          return stored
        },
        {
          onBegin: onBeginAction,
          onCommitted: (stored) => {
            setInventory(prev => prev.map(i =>
              i.id === item.id
                ? { ...i, storedPhotos: [...(i.storedPhotos ?? []), ...stored] }
                : i
            ))
          },
          onError: (err) => {
            // Whatever DID upload is still on file and must show as such, even
            // though the overall step failed.
            const partial = (err as Error & { partial?: StoredPhoto[] }).partial ?? []
            if (partial.length > 0) {
              setInventory(prev => prev.map(i =>
                i.id === item.id
                  ? { ...i, storedPhotos: [...(i.storedPhotos ?? []), ...partial] }
                  : i
              ))
            }
            onDbError(err)
          },
        },
      )
    }
    // The batch landed. A failed COA attachment does not undo that — the row
    // exists and is simply missing its document — so the submission is still
    // reported as committed and the error banner carries the upload failure.
    return true
  }

  async function handleCoaUpload(batchId: string, file: File) {
    const item = inventory.find(i => i.id === batchId)
    if (!item || !currentProfile) return
    const { storagePath } = await uploadCoaFile(
      file,
      currentProfile.id,
      item.farmId ?? '',
      batchId,
    )
    await patchInventoryBatch(batchId, {
      coa_file_name: file.name,
      coa_available: true,
      coa_storage_path: storagePath,
    })
    setInventory(prev => prev.map(i =>
      i.id === batchId
        ? { ...i, certFileName: file.name, coaAvailable: true, coaStoragePath: storagePath }
        : i
    ))
  }

  /**
   * The Operations Desk's own frame.
   *
   * The Organic design system brings a console shell with it, so this screen
   * REPLACES AdminShell rather than nesting inside it — two sidebars is not a
   * layout. Sign-out moves with the frame, because AdminShell is where sign-out
   * otherwise lives.
   *
   * A named function rather than an inline branch: the routing function it came
   * out of is already the largest in this file, and this branch is
   * self-contained.
   */
  function operationsDeskFrame() {
      // The Operations Desk is the first screen rebuilt on the Organic design
      // system, and that system brings its own console frame. It therefore
      // REPLACES AdminShell here rather than nesting inside it — two sidebars
      // is not a layout. Sign-out moves with it, because AdminShell is where
      // sign-out otherwise lives.
      //
      // The console is visibly two styles while this is the only screen
      // rebuilt. That is the accepted cost of piloting a design system on a
      // real screen instead of a mock.
  return (
          <OrganicConsoleShell
            page={page}
            goTo={goTo}
            onSignOut={handleSignOut}
            signedInAs={
              currentProfile
                ? `Signed in as ${currentProfile.displayName || currentProfile.email}`
                : 'Demo mode'
            }
            items={[
              { page: 'ddp-overview', label: 'Overview' },
              { page: 'ddp-operations-desk', label: 'Operations Desk' },
              { page: 'ddp-access-requests', label: 'Supplier Enquiries' },
              { page: 'ddp-buyer-provisioning', label: 'Buyers' },
              { page: 'ddp-document-review', label: 'Evidence' },
              { page: 'ddp-farms', label: 'Compliance' },
              { page: 'ddp-master', label: 'Supply Ledger' },
              { page: 'ddp-compliance-watchtower', label: 'Compliance Watchtower' },
            ]}
          >
            <DDPOperationsDeskOrganic
              // The same guarded admin view the old desk used: never a stale
              // farmer-scoped subset, and null where a source failed so the
              // screen can report the gap rather than imply an empty queue.
              farms={deskData.farms}
              inventory={deskData.inventory}
              reviewRequests={deskReviewRequests.requests}
              complianceAlerts={deskComplianceAlerts}
              reviewRequestsLoading={deskReviewRequests.loading}
              complianceLoading={!isDemo && (complianceLoadState === 'idle' || complianceLoadState === 'loading')}
              farmInventoryLoading={!isDemo && (adminDataLoadState === 'idle' || adminDataLoadState === 'loading')}
              farmInventoryFailed={!isDemo && adminDataLoadState === 'failed'}
              onOpen={item => {
                if (item.destinationParams?.farmId) handleReviewFarm(item.destinationParams.farmId)
                else if (item.destinationParams?.itemId) handleReviewItem(item.destinationParams.itemId)
                else goTo(item.destinationPage)
              }}
              onChaseFarms={chases => { handleChaseFarms(chases).catch(() => undefined) }}
            />
          </OrganicConsoleShell>
        )
  }

  /**
   * Chase several farms at once from the Operations Desk.
   *
   * ONE request per farm, listing that farm's outstanding matters — not one per
   * matter. A farm owing six documents gets one message; six would train it to
   * ignore them.
   *
   * Deliberately NOT handleSendReviewRequest in a loop. That function's second
   * write flips the batch to `needs_changes`, which is right when an operator
   * is asking about one specific batch and wrong here: a farm-level chase must
   * not silently re-open every batch it touches. So `stockItemId` is left unset
   * and no batch is patched.
   *
   * DB first, then local state, per the mutation-truthfulness convention: a
   * chase that failed to persist must not appear in the queue as though it had.
   */
  async function handleChaseFarms(chases: FarmChase[]) {
    for (const chase of chases) {
      const req: Omit<ReviewRequest, 'id' | 'createdAt'> = {
        farmProfileId: chase.farmProfileId,
        requestType: 'general',
        message: chase.missing.length === 1
          ? chase.missing[0]
          : `DDP is waiting on ${chase.missing.length} items:\n${chase.missing.map(m => `\u2022 ${m}`).join('\n')}`,
        status: 'open',
        createdBy: currentProfile?.id ?? '',
        farmName: chase.farmName,
      }
      const newReq: ReviewRequest = {
        ...req, id: crypto.randomUUID(), createdAt: new Date().toISOString(),
      }
      await commitMutation(
        () => createReviewRequest(req, currentProfile?.id),
        {
          onBegin: onBeginAction,
          onCommitted: () => { setReviewRequests(prev => [newReq, ...prev]) },
          onError: onDbError,
        },
      )
    }
  }

  async function handleSendReviewRequest(req: Omit<ReviewRequest, 'id' | 'createdAt'>) {
    const newReq: ReviewRequest = { ...req, id: crypto.randomUUID(), createdAt: new Date().toISOString() }
    // Two independent writes. The request is created FIRST so the ordering can
    // only fail towards a request with no needs_changes flag — recoverable, and
    // visible in the queue. The reverse order would leave a batch flagged
    // needs_changes with no request stating what the farmer must change.
    const created = await commitMutation(
      () => createReviewRequest(req, currentProfile?.id),
      {
        onBegin: onBeginAction,
        onCommitted: () => { setReviewRequests(prev => [newReq, ...prev]) },
        onError: onDbError,
      },
    )
    if (!created) return

    // Local const: narrowing on a property access is not preserved inside the
    // persist closure, and the flag write must not run for a request with no item.
    const stockItemId = req.stockItemId
    if (!stockItemId) return
    await commitMutation(
      () => patchInventoryBatch(stockItemId, { stock_status: 'needs_changes' }),
      {
        onBegin: onBeginAction,
        onCommitted: () => {
          setInventory(prev => prev.map(i =>
            i.id === stockItemId ? { ...i, stockStatus: 'needs_changes' as const } : i
          ))
        },
        onError: onDbError,
      },
    )
  }

  async function handleResolveRequest(requestId: string) {
    await commitMutation(
      () => resolveReviewRequest(requestId),
      {
        onBegin: onBeginAction,
        onCommitted: () => {
          setReviewRequests(prev => prev.map(r =>
            r.id === requestId ? { ...r, status: 'resolved' as const, resolvedAt: new Date().toISOString() } : r
          ))
        },
        onError: onDbError,
      },
    )
  }

  async function handleMarkClientVisible(itemId: string, visible: boolean) {
    const newStockStatus = visible ? 'client_visible' as const : 'approved_internal' as const
    // Client visibility is a disclosure boundary: a batch must never be shown as
    // client-visible on the strength of a write the database did not accept.
    await commitMutation(
      () => patchInventoryBatch(itemId, {
        client_visible: visible,
        stock_status: newStockStatus,
      }),
      {
        onBegin: onBeginAction,
        onCommitted: () => {
          setInventory(prev => prev.map(i =>
            i.id === itemId ? { ...i, clientVisible: visible, stockStatus: newStockStatus } : i
          ))
        },
        onError: onDbError,
      },
    )
  }

  async function handleSaveOwnerNote(itemId: string, note: string) {
    await commitMutation(
      () => saveBatchInternalNote(itemId, note),
      {
        onBegin: onBeginAction,
        onCommitted: () => {
          setInventory(prev => prev.map(i =>
            i.id === itemId ? { ...i, ownerNotes: note.trim() || undefined } : i
          ))
        },
        onError: onDbError,
      },
    )
  }

  function handleEditStock(itemId: string) {
    setStockEditItemId(itemId)
    goTo('farmer-stock-form')
  }

  async function handleFarmSubmit(farm: FarmProfile) {
    // A farm the database rejected must not be listed, must not widen the
    // farmer's scope, and must not send them to the status page as though the
    // application had been filed — the form stays put with the error shown.
    await commitMutation(
      () => createFarmProfile(farm, currentProfile?.id),
      {
        onBegin: onBeginAction,
        onCommitted: () => {
          setFarms(prev => {
            // If a farm with this ID already exists (e.g. advanced profile update), replace it
            const exists = prev.some(f => f.id === farm.id)
            return exists ? prev.map(f => f.id === farm.id ? farm : f) : [farm, ...prev]
          })
          if (isFarmerRole) {
            setFarmerScope(prev => {
              const base = prev ?? { farmIds: new Set<string>(), itemIds: new Set<string>() }
              return { farmIds: new Set([...base.farmIds, farm.id]), itemIds: base.itemIds }
            })
          }
          goTo('farmer-status')
        },
        onError: onDbError,
      },
    )
  }

  async function handleFarmAction(farmId: string, action: string) {
    const statusMap: Record<string, FarmStatus> = {
      'approve': 'Approved',
      'request-info': 'More Information Required',
      'watchlist': 'Watchlist',
      'strategic': 'Strategic Partner',
      'reject': 'Rejected',
    }
    const newStatus = statusMap[action]
    // Unrecognised action: nothing to persist, so leaving the review is safe.
    if (!newStatus) { goTo('ddp-farms'); return }
    const oldStatus = farms.find(f => f.id === farmId)?.status
    // Status and navigation are applied only once the write has landed — a
    // rejected update leaves the operator on the review with the error shown,
    // rather than on a farm list that claims a decision the database refused.
    await commitMutation(
      () => updateFarmProfileStatus(farmId, newStatus, oldStatus, currentProfile?.id),
      {
        onBegin: onBeginAction,
        onCommitted: () => {
          setFarms(prev => prev.map(f => f.id === farmId ? { ...f, status: newStatus } : f))
          goTo('ddp-farms')
        },
        onError: onDbError,
      },
    )
  }

  function handleFarmerCarbonExclude(farmId: string, newStatus: 'excluded_by_farmer' | 'withdrawn_by_farmer') {
    setFarms(prev => prev.map(f => f.id === farmId ? { ...f, carbonProgrammeStatus: newStatus } : f))
    if (isSupabaseConfigured) {
      console.warn('Carbon exclusion: Production persistence requires approved SQL/RLS migration. Local state updated only.')
    }
  }

  function handleAdminCarbonAction(farmId: string, newStatus: CarbonProgrammeStatus) {
    setFarms(prev => prev.map(f => f.id === farmId ? { ...f, carbonProgrammeStatus: newStatus } : f))
    if (isSupabaseConfigured) {
      console.warn('Carbon programme status: Production persistence requires approved SQL/RLS migration. Local state updated only.')
    }
  }

  async function handleInventoryAction(itemId: string, action: string) {
    const statusMap: Record<string, InventoryStatus> = {
      'approve': 'Approved',
      'missing': 'Missing Document',
      'reject': 'Rejected',
    }
    const newStatus = statusMap[action]
    // Unrecognised action: nothing to persist, so leaving the review is safe.
    if (!newStatus) { goTo('ddp-inventory'); return }
    const oldStatus = inventory.find(i => i.id === itemId)?.status
    // Same contract as handleFarmAction: an approval the database rejected must
    // never be shown as approved, nor navigated away from as if it had landed.
    await commitMutation(
      () => updateInventoryStatus(itemId, newStatus, oldStatus, currentProfile?.id),
      {
        onBegin: onBeginAction,
        onCommitted: () => {
          setInventory(prev => prev.map(i => i.id === itemId ? { ...i, status: newStatus } : i))
          goTo('ddp-inventory')
        },
        onError: onDbError,
      },
    )
  }

  function handleReviewFarm(farmId: string) {
    setReviewFarmId(farmId)
    goTo('ddp-farm-review')
  }

  function handleReviewItem(itemId: string) {
    setReviewItemId(itemId)
    goTo('ddp-inventory-review')
  }

  function handleOpenBuyerPack(itemId: string) {
    setBuyerPackItemId(itemId)
    goTo('ddp-buyer')
  }

  function handleReset() {
    resetDemoData()
    setInventory(loadInventory())
    setFarms(loadFarms())
    goTo('landing')
  }

  const reviewFarm = farms.find(f => f.id === reviewFarmId)
  const reviewItem = inventory.find(i => i.id === reviewItemId)
  const reviewItemFarm = reviewItem
    ? farms.find(f => f.id === reviewItem.farmId || f.tradingName === reviewItem.farmName)
    : undefined
  const buyerPackItem = inventory.find(i => i.id === buyerPackItemId) ?? null

  // ── Auth loading screen ───────────────────────────────────────────────────
  if (authLoading) {
    return (
      <div className="app auth-loading">
        <span>Loading…</span>
      </div>
    )
  }

  // ── Render ────────────────────────────────────────────────────────────────
  const showFarmerNav = isDemo || isFarmerRole
  const showDDPNav = isAdminRole

  // Which chrome to draw around the routed page. Presentation only: it reads the
  // existing values and decides nothing about roles, routes or data. A session
  // showing the farmer navigation keeps the existing top navbar, so the farmer
  // portal and demo mode are visually untouched.
  const useEditorialShell = showDDPNav && !showFarmerNav

  return (
    <div className="app">

      {/* ── Navbar (all non-landing pages; the editorial shell draws its own) ── */}
      {/* The farm portal draws its own lockup — the one that REPLACES the
          collided "BROKERAGEFARMER" wordmark and the seven wrapping nav labels
          (both still live at desk width today, verified signed in as a farm).
          Rendering this navbar above it would stack two headers, which is what
          looking at the real screen caught before it shipped. */}
      {!useEditorialShell && page !== 'farmer-dashboard' && !PUBLIC_PAGES.includes(page) && (
        <nav className="navbar">
          <div
            className="navbar-brand"
            onClick={() => goTo('landing')}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goTo('landing') } }}
            role="button"
            tabIndex={0}
            aria-label="Go to home"
            style={{ cursor: 'pointer' }}
          >
            <DDPMonogramLogo height={48} />
            <span className="brand-name">Brokerage</span>
          </div>

          <div className="navbar-links">
            {showFarmerNav && (
              <div className="farmer-nav-topbar">
                <FarmerNav lang={lang} page={page} goTo={goTo} evidenceWaiting={farmerEvidenceWaitingSafe} />
              </div>
            )}

            {showFarmerNav && showDDPNav && <div className="nav-sep" />}

            {/* Compact markup: this navbar is 56px and may also hold FarmerNav.
                The editorial sidebar renders only inside AdminShell. */}
            {showDDPNav && <AdminNav page={page} goTo={goTo} variant="topbar" />}
          </div>

          <div className="navbar-right">
            {/* The toggle used to live inside the `isDemo` branch, so in
                production — the only place a real farmer ever is — it did not
                render at all. It is not a demo affordance. */}
            {isFarmerPage && <LangToggle lang={lang} setLang={setLang} />}
            {!isDemo && (
              currentProfile
                ? <UserBadge profile={currentProfile} onSignOut={handleSignOut} />
                : <button className="btn btn-primary" style={{ fontSize: 13, padding: '6px 14px' }} onClick={() => goTo('login')}>Sign in</button>
            )}
          </div>
        </nav>
      )}

      {/* ── Landing page (approved LandPage.png redesign — owns its own nav) ── */}
      {page === 'landing' && (
        <LandingPage
          lang={lang}
          setLang={setLang}
          onSecureLogin={() => goTo('login')}
          onSupplierSignup={() => goTo('farmer-register')}
          onNavigate={goTo}
        />
      )}

      {/* ── Public corporate pages ──
          The only pages besides the landing page approved for public search
          indexing (lib/publicPageMetadata.ts is the register). They draw their
          own full-width chrome via CorporatePageShell rather than the cream
          auth card, which is why they are in PUBLIC_CORPORATE_PAGES and not in
          PUBLIC_AUTH_PAGES.

          `goTo` is passed whole as onNavigate: these pages link to each other,
          to the landing page, to login and to supplier registration, and every
          one of those links must still go through the navigation guard. */}
      {page === 'about' && (
        <AboutPage lang={lang} setLang={setLang} onNavigate={goTo} />
      )}
      {page === 'contact' && (
        <ContactPage lang={lang} setLang={setLang} onNavigate={goTo} />
      )}
      {page === 'privacy' && (
        <PrivacyPage lang={lang} setLang={setLang} onNavigate={goTo} />
      )}
      {page === 'terms' && (
        <TermsPage lang={lang} setLang={setLang} onNavigate={goTo} />
      )}

      {page === 'de-buyer' && <LocalisedBuyerPage page="de-buyer" onNavigate={goTo} />}

      {page === 'cs-buyer' && <LocalisedBuyerPage page="cs-buyer" onNavigate={goTo} />}

      {page === 'th-supplier' && <ThaiSupplierPage onNavigate={goTo} />}

      {page === 'regulatory-hub' && <RegulatoryHubPage onNavigate={goTo} />}

      {/* The slug comes from the address bar, not from state: there is no enum
          member per entry. An unknown slug falls back to the hub, which is the
          honest answer — though vercel.json keeps /regulatory-updates/ out of
          the SPA rewrite, so a wrong URL 404s before reaching this. */}
      {page === 'regulatory-entry' && (() => {
        const entry = typeof window === 'undefined' ? undefined : entryForPath(window.location.pathname)
        return entry
          ? <RegulatoryEntryPage entry={entry} onNavigate={goTo} />
          : <RegulatoryHubPage onNavigate={goTo} />
      })()}

      {/* ── Error banner ── */}
      {dbError && (
        <div className="db-error-banner" role="alert">
          <strong>Error:</strong> {dbError.message}
          {/* The correlation id, quotable to support. It maps to the console
              line holding the raw text — which never reaches this banner. */}
          <span className="db-error-ref"> Reference: <code>{dbError.reference}</code></span>
          <button className="db-error-dismiss" onClick={() => setDbError(null)} aria-label="Dismiss">✕</button>
        </div>
      )}

      {/* ── Auth pages (no navbar) ──
          Wrapped in the public shell so a visitor arriving from the landing
          page stays inside the same brand rather than dropping into the
          internal navy app theme. */}
      {page === 'login' && (
        <main className="main-content public-auth-shell">
          <LoginPage
            lang={lang}
            onSuccess={handleLoginSuccess}
            onSupplierSignup={() => goTo('farmer-register')}
            onForgotPassword={() => goTo('forgot-password')}
          />
        </main>
      )}

      {/* ── Set password (invite / recovery landing) ──
          Reached from the captured auth redirect, not from a nav affordance.
          `authRedirect` may be null if a user navigates here by other
          means; treating that as an expired link is the correct fail-closed
          reading, since without a redirect there is no session to update. */}
      {page === 'set-password' && (
        <main className="main-content public-auth-shell">
          <SetPasswordPage
            lang={lang}
            redirect={authRedirect ?? { kind: 'error', code: null }}
            onDone={handleSetPasswordComplete}
            onRequestNewLink={goToForgotPassword}
          />
        </main>
      )}

      {/* ── Forgot password (no navbar) ── */}
      {page === 'forgot-password' && (
        <main className="main-content public-auth-shell">
          <ForgotPasswordPage
            lang={lang}
            onBackToLogin={() => goTo('login')}
          />
        </main>
      )}

      {/* ── Supplier access request (no navbar) ── */}
      {page === 'buyer-dashboard' && (
        <main className="main-content">
          <BuyerDashboard lang={lang} profile={currentProfile} onSignOut={handleSignOut} />
        </main>
      )}

      {page === 'farmer-register' && (
        <main className="main-content public-auth-shell">
          <FarmerRegister
            lang={lang}
            setLang={setLang}
            /* Returns to the landing page. It previously routed to
               farmer-dashboard, which requires a session the request flow
               never creates — the dead end this replaced. */
            onComplete={() => goTo('landing')}
          />
        </main>
      )}

      {/* ── App pages ── */}
      {!PUBLIC_PAGES.includes(page) && (() => {
        const appPages = (
          <>

          {/* scopeLoading gates every farmer surface that consumes a scoped
              array. While farmerScope is null those arrays are [] (App.tsx
              scoped-data block), so the surface would render its empty state —
              telling a farmer who has stock "No stock yet", and showing 0 open
              requests on the dashboard. This is the same failure the Operations
              Desk work eliminated on the admin side; the farmer portal now
              holds the same standard. Only farmer-status was guarded before. */}
          {page === 'farmer-dashboard' && (
            scopeLoading
              ? <div className="scope-loading">{T[lang].scopeLoadingDashboard}</div>
              : <FarmerPortal
                  lang={lang}
                  onLang={setLang}
                  farms={farmerFarms}
                  inventory={farmerInventory}
                  reviewRequests={farmerReviewRequests}
                  currentProfile={isDemo ? null : currentProfile}
                  evidenceWaitingCount={farmerEvidenceWaitingSafe}
                  openRequestsCount={farmerReviewRequests.filter(r => r.status === 'open').length}
                  onPrimary={task => goTo(
                    task === 'evidence' ? 'farmer-evidence'
                      : task === 'requests' ? 'farmer-requests'
                        : task === 'documents' ? 'farmer-advanced-profile'
                          : 'farmer-onboarding',
                  )}
                  onContact={() => goTo('farmer-requests')}
                  onAddBatch={() => goTo('farmer-stock-form')}
                  onSignOut={handleSignOut}
                  onGoTo={task => goTo(
                    task === 'documents' ? 'farmer-advanced-profile' : 'farmer-onboarding',
                  )}
                />
          )}

          {page === 'farmer-my-stock' && (
            scopeLoading
              ? <div className="scope-loading">{T[lang].scopeLoadingStock}</div>
              : <FarmerMyStock
                  lang={lang}
                  inventory={farmerInventory}
                  onAddNew={() => { setStockEditItemId(null); goTo('farmer-stock-form') }}
                  onEdit={handleEditStock}
                  openRequestCount={farmerReviewRequests.filter(r => r.status === 'open').length}
                  onGoRequests={() => goTo('farmer-requests')}
                  onCoaUpload={isFarmerRole && isSupabaseConfigured ? handleCoaUpload : undefined}
                  loadFailed={farmerLoadFailed}
              />
          )}

          {page === 'farmer-stock-form' && (
            <FarmerSubmitInventory
              lang={lang}
              farms={farmerFarms}
              initialItem={stockEditItemId ? farmerInventory.find(i => i.id === stockEditItemId) : null}
              onSubmit={async (item, coaFile, photoFiles) => {
                // photoFiles IS load-bearing. This lambda used to take only
                // (item, coaFile), so the form's third argument was dropped on
                // the floor and handleInventorySubmit's photo block — which is
                // guarded by `if (photoFiles?.length …)` — could never run. The
                // result was farmer_photos with n_tup_ins = 0 in production:
                // not one insert ever ATTEMPTED, against a durable upload path
                // that was built, tested and correct.
                //
                // TypeScript cannot catch this and never will: a function of
                // fewer parameters is assignable to a type of more, by design.
                // The guard is the forwarding test in
                // src/lib/mutationNavigationOrdering.test.ts.
                //
                // Navigate only on a committed submission. Leaving the form in
                // place on failure keeps the farmer's input recoverable and puts
                // them where the error banner is actionable.
                const committed = await handleInventorySubmit(item, coaFile, photoFiles)
                if (committed && item.stockStatus !== 'draft') goTo('farmer-my-stock')
                // Returned, not swallowed: the form decides whether to show a
                // success screen, and it can only do that if it is told.
                return committed
              }}
              onBack={() => goTo('farmer-my-stock')}
              marketBenchmarks={marketBenchmarks}
              openRequests={farmerReviewRequests}
            />
          )}

          {page === 'farmer-requests' && (
            scopeLoading
              ? <div className="scope-loading">{T[lang].scopeLoadingRequests}</div>
              : <FarmerRequests
                  lang={lang}
                  requests={farmerReviewRequests}
                  inventory={farmerInventory}
                  onResolve={handleResolveRequest}
                  onEditStock={handleEditStock}
                  onGoMyStock={() => goTo('farmer-my-stock')}
                />
          )}

          {/* No scopeLoading gate, and deliberately not one: FarmerEvidence
              consumes no scoped array. It reads farmer_documents directly and
              the RLS policy scopes the rows, so there is no window in which it
              could render another farm's evidence — and gating it on
              farmerScope would make it show a loading state waiting on data it
              never uses. */}
          {page === 'farmer-evidence' && (
            <FarmerEvidence
              lang={lang}
              onGoMyStock={() => goTo('farmer-my-stock')}
            />
          )}

          {page === 'farmer-onboarding' && (
            <FarmerOnboarding
              lang={lang}
              currentProfile={currentProfile}
              onSubmit={handleFarmSubmit}
              onBack={() => goTo('farmer-dashboard')}
            />
          )}

          {page === 'farmer-advanced-profile' && (
            <FarmerAdvancedProfile
              lang={lang}
              farms={farmerFarms}
              onSave={handleFarmSubmit}
              onBack={() => goTo('farmer-dashboard')}
            />
          )}

          {page === 'farmer-status' && (
            // `scopeLoading` already implies isFarmerRole (it is derived as
            // isFarmerRole && farmerScope === null), so the redundant conjunct
            // is dropped; the string moves to translations with the other three.
            scopeLoading
              ? <div className="scope-loading">{T[lang].scopeLoadingSubmissions}</div>
              : <FarmerStatus
                  lang={lang}
                  inventory={farmerInventory}
                  farms={farmerFarms}
                  onCarbonExclude={handleFarmerCarbonExclude}
                  carbonPersistenceAvailable={isDemo}
                />
          )}

          {/* DDP pages — AccessDenied for non-admin in Supabase mode */}
          {DDP_PAGES.includes(page) && !isAdminRole && (
            <AccessDenied onBack={() => goTo(isFarmerRole ? 'farmer-status' : 'landing')} />
          )}

          {page === 'ddp-overview' && isAdminRole && (
            <DDPOverview
              farms={farms}
              inventory={inventory}
              onReviewFarm={handleReviewFarm}
              onReviewItem={handleReviewItem}
            />
          )}

          {page === 'ddp-farms' && isAdminRole && (
            <DDPFarmProfiles
              farms={farms}
              inventory={inventory}
              onReview={handleReviewFarm}
            />
          )}

          {page === 'ddp-farm-review' && isAdminRole && reviewFarm && (
            <DDPFarmReview
              key={reviewFarm.id}
              farm={reviewFarm}
              inventory={inventory}
              onBack={() => goTo('ddp-farms')}
              onAction={handleFarmAction}
              onCarbonAction={handleAdminCarbonAction}
              carbonPersistenceAvailable={isDemo}
            />
          )}

          {isAdminRole && SUPPLY_LEDGER_PAGES.includes(page) && (
            <div className="page-wrap ddp-wrap" style={{ paddingBottom: 0 }}>
              <SupplyLedgerTabs page={page} goTo={goTo} />
            </div>
          )}

          {page === 'ddp-inventory' && isAdminRole && (
            <DDPInventoryDashboard
              inventory={inventory}
              onReview={handleReviewItem}
            />
          )}

          {page === 'ddp-inventory-review' && isAdminRole && reviewItem && (
            <DDPInventoryReview
              item={reviewItem}
              farm={reviewItemFarm}
              onBack={() => goTo('ddp-inventory')}
              onAction={(itemId, action) => {
                if (action === 'client-visible') { handleMarkClientVisible(itemId, true); return }
                if (action === 'client-hide') { handleMarkClientVisible(itemId, false); return }
                handleInventoryAction(itemId, action)
              }}
              onSendRequest={handleSendReviewRequest}
              onGetCoaUrl={isSupabaseConfigured ? getCoaSignedUrl : undefined}
              // Photos are wired to the batch-review screen ONLY. Deliberately NOT
              // passed to DDPBuyerPreview: farmer_photos includes 'facility' and
              // 'batch_label' types, which identify the farm in image form — a leak
              // no column-level control can catch. See the double-blind requirement.
              onGetPhotoUrl={isSupabaseConfigured ? getPhotoSignedUrl : undefined}
              onSaveNote={handleSaveOwnerNote}
            />
          )}

          {page === 'ddp-master' && isAdminRole && (
            <DDPMasterInventory
              inventory={inventory}
              farms={farms}
              onGetCoaUrl={isSupabaseConfigured ? getCoaSignedUrl : undefined}
              onBuyerPack={handleOpenBuyerPack}
              complianceRules={complianceRules}
              complianceAlerts={complianceAlerts}
            />
          )}

          {page === 'ddp-missing-documents' && isAdminRole && (
            <DDPMissingDocuments
              farms={farms}
              inventory={inventory}
              complianceRules={complianceRules}
              complianceAlerts={complianceAlerts}
            />
          )}

          {page === 'ddp-coa-intelligence' && isAdminRole && (
            <DDPCoaIntelligence inventory={inventory} farms={farms} />
          )}

          {page === 'ddp-risk-register' && isAdminRole && (
            <DDPRiskRegister
              farms={farms}
              inventory={inventory}
              onReviewFarm={handleReviewFarm}
              onReviewItem={handleReviewItem}
              complianceRules={complianceRules}
              complianceAlerts={complianceAlerts}
            />
          )}

          {page === 'ddp-buyer' && isAdminRole && (
            <DDPBuyerPreview
              inventory={inventory}
              farms={farms}
              selectedItem={buyerPackItem}
              onBack={() => { setBuyerPackItemId(null); goTo('ddp-master') }}
              onGetCoaUrl={isSupabaseConfigured ? getCoaSignedUrl : undefined}
              approverName={currentProfile?.displayName || currentProfile?.email || undefined}
            />
          )}

          {/* Operations Desk — read-only index over existing records. The
              `&& isAdminRole` conjunction is the guard, exactly as on every
              other DDP page; the database's RLS remains the real boundary. */}
          {/* Supplier enquiries — the administrator's view of the public intake
              queue, and the only in-app way to disposition spam. Same
              `&& isAdminRole` guard as every other DDP page; RLS remains the
              real boundary (migration 34 `admin read` / `admin triage`). */}
          {page === 'ddp-access-requests' && isAdminRole && <DDPAccessRequests />}
          {page === 'ddp-buyer-provisioning' && isAdminRole && <DDPBuyerProvisioning />}
          {page === 'ddp-document-review' && isAdminRole && <DDPDocumentReview />}

          {/* The Operations Desk renders in its own frame below, outside
              AdminShell, because it brings the Organic console shell with it.
              DDPOperationsDesk.tsx is kept on disk, unrouted, for one release
              as the reference for what this replaced. */}

          {page === 'ddp-compliance-watchtower' && isAdminRole && (
            <DDPComplianceWatchtower
              farms={farms}
              inventory={inventory}
              currentUser={isDemo ? null : currentProfile}
            />
          )}
          </>
        )

        // The Operations Desk renders in its own frame — see operationsDeskFrame
        // below for why it replaces AdminShell rather than nesting inside it.
        if (page === 'ddp-operations-desk' && isAdminRole) return operationsDeskFrame()

        // Identical routed content in both frames — only the surrounding chrome
        // differs, so no page's behaviour depends on which one is drawn.
        return useEditorialShell ? (
          <AdminShell page={page} goTo={goTo} profile={currentProfile} onSignOut={handleSignOut}>
            {appPages}
          </AdminShell>
        ) : (
          // eo-farmer applies the editorial appearance to the farmer screens.
          // Class only — isFarmerPage is the app's existing value, and the
          // public login screen renders through its own <main>.
          <main className={`main-content${isFarmerPage ? ' eo-farmer' : ''}`}>{appPages}</main>
        )
      })()}

      {/* ── Farmer mobile bottom navigation (visible only on mobile ≤768px) ──
          The PUBLIC_PAGES exclusion is load-bearing, not belt-and-braces.
          FARMER_PAGES spreads PUBLIC_PAGES, so isFarmerPage is TRUE on landing,
          login and the register screens — and showFarmerNav is true for any
          signed-in farmer and for all of demo mode. Without this clause a farmer
          who taps the brand logo lands on the cream public landing page with a
          dark five-tab farmer bar pinned across the bottom. That is the same
          defect the diagnostic strip below was already fixed for; the top navbar
          guards itself the same way (`!PUBLIC_PAGES.includes(page)`). */}
      {showFarmerNav && isFarmerPage && !PUBLIC_PAGES.includes(page) && (
        <FarmerMobileNav
          lang={lang}
          page={page}
          goTo={goTo}
          openRequestsCount={farmerReviewRequests.filter(r => r.status === 'open').length}
        />
      )}

      {/* Internal diagnostic chrome. Hidden on every PUBLIC page, not just the
          landing: it is position:fixed with z-index 200, so on sign-in and the
          supplier access request it painted a navy bar with the build id across
          the bottom of an otherwise cream, branded page — internal build detail
          shown to prospects, and the last of the "blue screen" on the public
          funnel. It remains visible throughout the signed-in app. */}
      {!PUBLIC_PAGES.includes(page) && (isDemo || buildVersion) && (
        <div className="demo-utility-strip">
          {isDemo && <span className="db-mode-badge">○ Demo mode: localStorage</span>}
          {buildVersion && <span className="build-id-badge">{buildVersion}</span>}
          {isDemo && (
            <button className="demo-reset-btn" onClick={handleReset} title="Reset all demo data">
              ↺ Reset Demo
            </button>
          )}
        </div>
      )}
    </div>
  )
}
