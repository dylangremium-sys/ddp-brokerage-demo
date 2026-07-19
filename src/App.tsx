import { useState, useEffect, useRef } from 'react'
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
  getCoaSignedUrl,
  resetDemoData,
  isSupabaseConfigured,
  getFarmerScope,
  type FarmerScope,
} from './lib/db'
import { loadInventory, loadFarms, loadReviewRequests, saveReviewRequests, loadMarketBenchmarks } from './data'
import {
  signOut,
  subscribeToAuthChanges,
  getCurrentProfile,
  type UserProfile,
} from './services/auth'
import { resolvePostLoginDecision, nextBootstrapRouting } from './lib/postLoginRouting'
import { reviewRequestScopeKey, reviewRequestScopeChanged, scopeReviewRequestsToFarmer } from './lib/reviewRequestScope'
import type { Page, Lang, InventoryItem, FarmProfile, FarmStatus, InventoryStatus, ReviewRequest, MarketBenchmark, CarbonProgrammeStatus, ComplianceRule, ComplianceAlert } from './types'
import { fetchRules as fetchComplianceRules, fetchAlerts as fetchComplianceAlerts } from './lib/complianceRepository'
import { DDPMonogramLogo } from './components/logos'
import LandingPage from './pages/public/LandingPage'
import LoginPage from './pages/public/LoginPage'
import SignupPage from './pages/public/SignupPage'
import FarmerRegister from './pages/farmer/FarmerRegister'
import FarmerDashboard from './pages/farmer/FarmerDashboard'
import FarmerOnboarding from './pages/farmer/FarmerOnboarding'
import FarmerAdvancedProfile from './pages/farmer/FarmerAdvancedProfile'
import FarmerMyStock from './pages/farmer/FarmerMyStock'
import FarmerSubmitInventory from './pages/farmer/FarmerSubmitInventory'
import FarmerRequests from './pages/farmer/FarmerRequests'
import FarmerStatus from './pages/farmer/FarmerStatus'
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
import DDPOperationsDesk from './pages/admin/DDPOperationsDesk'
import LangToggle from './components/shared/LangToggle'
import UserBadge from './components/shared/UserBadge'
import AccessDenied from './components/shared/AccessDenied'
import FarmerNav from './components/farmer/FarmerNav'
import AdminNav from './components/admin/AdminNav'
import AdminShell from './components/admin/AdminShell'
import SupplyLedgerTabs from './components/admin/SupplyLedgerTabs'

const FARMER_PAGES: Page[] = [
  'landing', 'login', 'signup', 'farmer-register',
  'farmer-dashboard', 'farmer-onboarding', 'farmer-advanced-profile',
  'farmer-my-stock', 'farmer-stock-form', 'farmer-requests', 'farmer-status',
]
const DDP_PAGES: Page[] = ['ddp-overview', 'ddp-farms', 'ddp-farm-review', 'ddp-inventory', 'ddp-inventory-review', 'ddp-master', 'ddp-buyer', 'ddp-missing-documents', 'ddp-coa-intelligence', 'ddp-risk-register', 'ddp-compliance-watchtower', 'ddp-operations-desk']
const SUPPLY_LEDGER_PAGES: Page[] = ['ddp-inventory', 'ddp-inventory-review', 'ddp-master', 'ddp-buyer', 'ddp-missing-documents', 'ddp-coa-intelligence', 'ddp-risk-register']
const PUBLIC_PAGES: Page[] = ['landing', 'login', 'signup']

// ─── Main App ────────────────────────────────────────────────────────────────

export default function App() {
  const [page, setPage] = useState<Page>('landing')
  const [lang, setLang] = useState<Lang>('en')
  const [inventory, setInventory] = useState<InventoryItem[]>(() => getInventoryBatches())
  const [farms, setFarms] = useState<FarmProfile[]>(() => getFarmProfiles())
  const [reviewFarmId, setReviewFarmId] = useState<string | null>(null)
  const [reviewItemId, setReviewItemId] = useState<string | null>(null)
  const [dbError, setDbError] = useState<string | null>(null)
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

  // Review requests (owner → farmer messages) and stock edit tracking
  const [reviewRequests, setReviewRequests] = useState<ReviewRequest[]>(() => loadReviewRequests())
  const [marketBenchmarks, setMarketBenchmarks] = useState<MarketBenchmark[]>(() => loadMarketBenchmarks())
  const [complianceRules, setComplianceRules] = useState<ComplianceRule[]>([])
  const [complianceAlerts, setComplianceAlerts] = useState<ComplianceAlert[]>([])
  // Load outcome for the compliance fetch below. The Operations Desk must be
  // able to tell "loaded and empty" apart from "could not load" so it never
  // presents a failed source as an all-clear. 'idle' means the fetch has not
  // settled yet, which the desk reads as still loading rather than as empty.
  const [complianceLoadState, setComplianceLoadState] = useState<'idle' | 'ready' | 'failed'>('idle')
  // Load outcome for the admin review-request fetch. Same three-state contract
  // as compliance: 'idle' = not yet settled (the desk shows loading, never a
  // premature zero), 'ready' = loaded (possibly empty), 'failed' = the desk
  // reports the gap instead of an all-clear. Only meaningful in Supabase admin
  // sessions — demo review requests live in memory and never load from a source.
  const [reviewRequestsLoadState, setReviewRequestsLoadState] = useState<'idle' | 'ready' | 'failed'>('idle')
  const [stockEditItemId, setStockEditItemId] = useState<string | null>(null)
  const [buyerPackItemId, setBuyerPackItemId] = useState<string | null>(null)

  // ── Persist to localStorage on every state change ────────────────────────
  useEffect(() => { persistInventory(inventory) }, [inventory])
  useEffect(() => { persistFarms(farms) }, [farms])
  useEffect(() => { saveReviewRequests(reviewRequests) }, [reviewRequests])

  // ── Auth subscription ────────────────────────────────────────────────────
  // authLoading is initialised to false in demo mode via useState, so no
  // synchronous setState is needed in the early-return branch.
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
      }
      // Bootstrap routing: on the FIRST auth resolution after a (re)load, route a
      // restored session to its role page (a reload resets `page` to the public
      // landing). Guarded to run once so later events cannot override navigation.
      const routing = nextBootstrapRouting(didBootstrapRoute.current, profile)
      didBootstrapRoute.current = routing.routed
      if (routing.routeTo) {
        setPage(routing.routeTo)
        window.scrollTo(0, 0)
      }
    })
    return unsubscribe
  }, [])

  // ── Load farmer scope + actual inventory rows when a farmer signs in ────────
  useEffect(() => {
    if (!isSupabaseConfigured || !currentProfile || currentProfile.role !== 'farmer') return
    getFarmerScope(currentProfile.id)
      .then(async scope => {
        setFarmerScope(scope)
        const [dbFarms, dbInventory, dbRequests] = await Promise.all([
          loadFarmerFarmsFromDB(scope.farmIds),
          loadFarmerInventoryFromDB(scope.itemIds, scope.farmIds),
          loadReviewRequestsFromDB(currentProfile.id, scope.farmIds, scope.itemIds),
        ])
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
        console.warn('getFarmerScope / data load failed:', err)
        setFarmerScope({ farmIds: new Set(), itemIds: new Set() })
        // Fail closed: a failed farmer load must not leave prior (possibly
        // admin-wide) requests visible.
        setReviewRequests([])
      })
  }, [currentProfile])

  // ── Load all farms + inventory from Supabase when admin signs in ────────────
  useEffect(() => {
    if (!isSupabaseConfigured || !currentProfile || currentProfile.role !== 'ddp_admin') return
    Promise.all([loadFarmsFromDB(), loadInventoryFromDB()])
      .then(([dbFarms, dbInventory]) => {
        setFarms(dbFarms)
        setInventory(dbInventory)
      })
      .catch(err => console.warn('Admin Supabase data load failed:', err))
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
    loadAllReviewRequestsFromDB()
      .then(requests => {
        setReviewRequests(requests)
        setReviewRequestsLoadState('ready')
      })
      .catch(err => {
        console.warn('Admin review requests load failed:', err)
        setReviewRequestsLoadState('failed')
      })
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
    // entry for the same staleness reason the Supply Ledger pages do.
    if (!SUPPLY_LEDGER_PAGES.includes(page) && page !== 'ddp-operations-desk') return
    Promise.all([fetchComplianceRules(), fetchComplianceAlerts()])
      .then(([rules, alerts]) => {
        setComplianceRules(rules)
        setComplianceAlerts(alerts)
        setComplianceLoadState('ready')
      })
      .catch(err => {
        console.warn('Compliance rule impact data load failed:', err)
        setComplianceLoadState('failed')
      })
  }, [currentProfile, page])

  // ── Role helpers ─────────────────────────────────────────────────────────
  // In demo mode (no Supabase), everything is open — preserve existing behaviour.
  const isDemo = !isSupabaseConfigured
  const isSignedIn = isDemo || currentProfile !== null
  const isAdminRole = isDemo || currentProfile?.role === 'ddp_admin'
  const isFarmerRole = !isDemo && currentProfile?.role === 'farmer'
  const isFarmerPage = FARMER_PAGES.includes(page)
  // Derived — true while a farmer's scope is being fetched from Supabase
  const scopeLoading = isFarmerRole && farmerScope === null

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

  // ── Error handler ────────────────────────────────────────────────────────
  function onDbError(err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('Supabase error:', msg)
    setDbError(msg)
  }

  // ── Navigation ───────────────────────────────────────────────────────────
  function goTo(p: Page) {
    // In Supabase mode: redirect unauthenticated users to login
    if (!isDemo && !isSignedIn && !PUBLIC_PAGES.includes(p)) {
      setPage('login')
      window.scrollTo(0, 0)
      return
    }
    // In Supabase mode: redirect admins away from farmer-only pages
    if (!isDemo && isAdminRole && FARMER_PAGES.includes(p) && !PUBLIC_PAGES.includes(p)) {
      setPage('ddp-overview')
      window.scrollTo(0, 0)
      return
    }
    setPage(p)
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
    setDbError('Your account does not have an assigned DDP role. Please contact DDP support.')
    setPage('login')
    window.scrollTo(0, 0)
  }

  // ── Data handlers ─────────────────────────────────────────────────────────
  async function handleInventorySubmit(item: InventoryItem, coaFile?: File | null) {
    setInventory(prev => {
      const exists = prev.some(i => i.id === item.id)
      return exists ? prev.map(i => i.id === item.id ? item : i) : [item, ...prev]
    })
    // Optimistically expand scope so the farmer sees their new submission immediately
    if (isFarmerRole) {
      setFarmerScope(prev => {
        const base = prev ?? { farmIds: new Set<string>(), itemIds: new Set<string>() }
        const newFarmIds = item.farmId
          ? new Set([...base.farmIds, item.farmId])
          : base.farmIds
        return { farmIds: newFarmIds, itemIds: new Set([...base.itemIds, item.id]) }
      })
    }
    try {
      await createInventoryBatch(item, currentProfile?.id)
    } catch (err) {
      onDbError(err)
      return
    }
    if (coaFile && isSupabaseConfigured && isFarmerRole && currentProfile && item.id) {
      try {
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
        setInventory(prev => prev.map(i =>
          i.id === item.id
            ? { ...i, certFileName: coaFile.name, coaAvailable: true, coaStoragePath: storagePath }
            : i
        ))
      } catch (err) {
        onDbError(err)
      }
    }
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

  function handleSendReviewRequest(req: Omit<ReviewRequest, 'id' | 'createdAt'>) {
    const newReq: ReviewRequest = { ...req, id: crypto.randomUUID(), createdAt: new Date().toISOString() }
    setReviewRequests(prev => [newReq, ...prev])
    // Mark the item as needs_changes (both in state and Supabase)
    if (req.stockItemId) {
      setInventory(prev => prev.map(i =>
        i.id === req.stockItemId ? { ...i, stockStatus: 'needs_changes' as const } : i
      ))
      patchInventoryBatch(req.stockItemId, { stock_status: 'needs_changes' }).catch(onDbError)
    }
    createReviewRequest(req, currentProfile?.id).catch(onDbError)
  }

  function handleResolveRequest(requestId: string) {
    setReviewRequests(prev => prev.map(r =>
      r.id === requestId ? { ...r, status: 'resolved' as const, resolvedAt: new Date().toISOString() } : r
    ))
    resolveReviewRequest(requestId).catch(onDbError)
  }

  function handleMarkClientVisible(itemId: string, visible: boolean) {
    const newStockStatus = visible ? 'client_visible' as const : 'approved_internal' as const
    setInventory(prev => prev.map(i =>
      i.id === itemId ? { ...i, clientVisible: visible, stockStatus: newStockStatus } : i
    ))
    patchInventoryBatch(itemId, {
      client_visible: visible,
      stock_status: newStockStatus,
    }).catch(onDbError)
  }

  function handleSaveOwnerNote(itemId: string, note: string) {
    setInventory(prev => prev.map(i =>
      i.id === itemId ? { ...i, ownerNotes: note } : i
    ))
    patchInventoryBatch(itemId, { owner_notes: note }).catch(onDbError)
  }

  function handleEditStock(itemId: string) {
    setStockEditItemId(itemId)
    goTo('farmer-stock-form')
  }

  function handleFarmSubmit(farm: FarmProfile) {
    setFarms(prev => {
      // If a farm with this ID already exists (e.g. advanced profile update), replace it
      const exists = prev.some(f => f.id === farm.id)
      return exists ? prev.map(f => f.id === farm.id ? farm : f) : [farm, ...prev]
    })
    createFarmProfile(farm, currentProfile?.id).catch(onDbError)
    // Optimistically expand scope so the farmer sees their new farm immediately
    if (isFarmerRole) {
      setFarmerScope(prev => {
        const base = prev ?? { farmIds: new Set<string>(), itemIds: new Set<string>() }
        return { farmIds: new Set([...base.farmIds, farm.id]), itemIds: base.itemIds }
      })
    }
    goTo('farmer-status')
  }

  function handleFarmAction(farmId: string, action: string) {
    const statusMap: Record<string, FarmStatus> = {
      'approve': 'Approved',
      'request-info': 'More Information Required',
      'watchlist': 'Watchlist',
      'strategic': 'Strategic Partner',
      'reject': 'Rejected',
    }
    const newStatus = statusMap[action]
    if (newStatus) {
      const oldStatus = farms.find(f => f.id === farmId)?.status
      setFarms(prev => prev.map(f => f.id === farmId ? { ...f, status: newStatus } : f))
      updateFarmProfileStatus(farmId, newStatus, oldStatus, currentProfile?.id).catch(onDbError)
    }
    goTo('ddp-farms')
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

  function handleInventoryAction(itemId: string, action: string) {
    const statusMap: Record<string, InventoryStatus> = {
      'approve': 'Approved',
      'missing': 'Missing Document',
      'reject': 'Rejected',
    }
    const newStatus = statusMap[action]
    if (newStatus) {
      const oldStatus = inventory.find(i => i.id === itemId)?.status
      setInventory(prev => prev.map(i => i.id === itemId ? { ...i, status: newStatus } : i))
      updateInventoryStatus(itemId, newStatus, oldStatus, currentProfile?.id).catch(onDbError)
    }
    goTo('ddp-inventory')
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
      {!useEditorialShell && page !== 'landing' && page !== 'login' && page !== 'signup' && page !== 'farmer-register' && (
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
            {showFarmerNav && <FarmerNav lang={lang} page={page} goTo={goTo} />}

            {showFarmerNav && showDDPNav && <div className="nav-sep" />}

            {/* Compact markup: this navbar is 56px and may also hold FarmerNav.
                The editorial sidebar renders only inside AdminShell. */}
            {showDDPNav && <AdminNav page={page} goTo={goTo} variant="topbar" />}
          </div>

          <div className="navbar-right">
            {isDemo ? (
              isFarmerPage && <LangToggle lang={lang} setLang={setLang} />
            ) : (
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
        />
      )}

      {/* ── Error banner ── */}
      {dbError && (
        <div className="db-error-banner" role="alert">
          <strong>Error:</strong> {dbError}
          <button className="db-error-dismiss" onClick={() => setDbError(null)} aria-label="Dismiss">✕</button>
        </div>
      )}

      {/* ── Auth pages (no navbar) ── */}
      {page === 'login' && (
        <main className="main-content">
          <LoginPage
            lang={lang}
            onSuccess={handleLoginSuccess}
            onGoSignup={() => goTo('signup')}
          />
        </main>
      )}

      {page === 'signup' && (
        <main className="main-content">
          <SignupPage
            lang={lang}
            onSuccess={() => goTo('farmer-dashboard')}
            onGoLogin={() => goTo('login')}
          />
        </main>
      )}

      {/* ── Demo registration (no navbar) ── */}
      {page === 'farmer-register' && (
        <main className="main-content">
          <FarmerRegister
            lang={lang}
            onComplete={() => goTo('farmer-dashboard')}
          />
        </main>
      )}

      {/* ── App pages ── */}
      {page !== 'landing' && page !== 'login' && page !== 'signup' && page !== 'farmer-register' && (() => {
        const appPages = (
          <>

          {page === 'farmer-dashboard' && (
            <FarmerDashboard
              lang={lang}
              farms={farmerFarms}
              currentProfile={isDemo ? null : currentProfile}
              onBuildProfile={() => goTo('farmer-onboarding')}
              onMyStock={() => goTo('farmer-my-stock')}
              onMyActivity={() => goTo('farmer-status')}
              onAdvancedProfile={() => goTo('farmer-advanced-profile')}
              onRequests={() => goTo('farmer-requests')}
              openRequestsCount={farmerReviewRequests.filter(r => r.status === 'open').length}
            />
          )}

          {page === 'farmer-my-stock' && (
            <FarmerMyStock
              lang={lang}
              inventory={farmerInventory}
              onAddNew={() => { setStockEditItemId(null); goTo('farmer-stock-form') }}
              onEdit={handleEditStock}
              openRequestCount={farmerReviewRequests.filter(r => r.status === 'open').length}
              onGoRequests={() => goTo('farmer-requests')}
              onCoaUpload={isFarmerRole && isSupabaseConfigured ? handleCoaUpload : undefined}
            />
          )}

          {page === 'farmer-stock-form' && (
            <FarmerSubmitInventory
              lang={lang}
              farms={farmerFarms}
              initialItem={stockEditItemId ? farmerInventory.find(i => i.id === stockEditItemId) : null}
              onSubmit={async (item, coaFile) => {
                await handleInventorySubmit(item, coaFile)
                if (item.stockStatus !== 'draft') goTo('farmer-my-stock')
              }}
              onBack={() => goTo('farmer-my-stock')}
              marketBenchmarks={marketBenchmarks}
              openRequests={farmerReviewRequests}
            />
          )}

          {page === 'farmer-requests' && (
            <FarmerRequests
              lang={lang}
              requests={farmerReviewRequests}
              inventory={farmerInventory}
              onResolve={handleResolveRequest}
              onEditStock={handleEditStock}
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
            scopeLoading && isFarmerRole
              ? <div className="scope-loading">Loading your submissions…</div>
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
          {page === 'ddp-operations-desk' && isAdminRole && (
            <DDPOperationsDesk
              farms={farms}
              inventory={inventory}
              // Demo: the in-memory review requests are the honest value. Supabase
              // admin: null on a failed fetch so the desk reports the gap; [] while
              // still loading so a stale localStorage/farmer-scoped array is never
              // shown as admin data (the loading flag below explains the empty count);
              // the loaded rows once ready.
              reviewRequests={
                isDemo
                  ? reviewRequests
                  : reviewRequestsLoadState === 'failed'
                    ? null
                    : reviewRequestsLoadState === 'ready'
                      ? reviewRequests
                      : []
              }
              reviewRequestsLoading={!isDemo && reviewRequestsLoadState === 'idle'}
              // In demo mode there is no compliance source to fetch, so [] is
              // the honest value: loaded, and genuinely empty. In Supabase mode
              // a failed fetch passes null so the desk reports the gap.
              complianceAlerts={isDemo || complianceLoadState !== 'failed' ? complianceAlerts : null}
              complianceLoading={!isDemo && complianceLoadState === 'idle'}
              onOpenFarm={handleReviewFarm}
              onOpenItem={handleReviewItem}
              goTo={goTo}
            />
          )}

          {page === 'ddp-compliance-watchtower' && isAdminRole && (
            <DDPComplianceWatchtower
              farms={farms}
              inventory={inventory}
              currentUser={isDemo ? null : currentProfile}
            />
          )}
          </>
        )

        // Identical routed content in both frames — only the surrounding chrome
        // differs, so no page's behaviour depends on which one is drawn.
        return useEditorialShell ? (
          <AdminShell page={page} goTo={goTo} profile={currentProfile} onSignOut={handleSignOut}>
            {appPages}
          </AdminShell>
        ) : (
          // eo-farmer applies the editorial appearance to the farmer screens.
          // Class only — isFarmerPage is the app's existing value, and the
          // public login/signup screens render through their own <main>.
          <main className={`main-content${isFarmerPage ? ' eo-farmer' : ''}`}>{appPages}</main>
        )
      })()}

      {page !== 'landing' && (isDemo || buildVersion) && (
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
