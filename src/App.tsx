import { useState, useEffect } from 'react'
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
  type UserProfile,
} from './services/auth'
import { T } from './translations'
import type { Page, Lang, InventoryItem, FarmProfile, FarmStatus, InventoryStatus, ReviewRequest, MarketBenchmark } from './types'
import LandingPage from './pages/LandingPage'
import LoginPage from './pages/LoginPage'
import SignupPage from './pages/SignupPage'
import FarmerRegister from './pages/FarmerRegister'
import FarmerDashboard from './pages/FarmerDashboard'
import FarmerOnboarding from './pages/FarmerOnboarding'
import FarmerAdvancedProfile from './pages/FarmerAdvancedProfile'
import FarmerMyStock from './pages/FarmerMyStock'
import FarmerSubmitInventory from './pages/FarmerSubmitInventory'
import FarmerRequests from './pages/FarmerRequests'
import FarmerStatus from './pages/FarmerStatus'
import DDPOverview from './pages/DDPOverview'
import DDPFarmProfiles from './pages/DDPFarmProfiles'
import DDPFarmReview from './pages/DDPFarmReview'
import DDPInventoryDashboard from './pages/DDPInventoryDashboard'
import DDPInventoryReview from './pages/DDPInventoryReview'
import DDPMasterInventory from './pages/DDPMasterInventory'
import DDPBuyerPreview from './pages/DDPBuyerPreview'

const FARMER_PAGES: Page[] = [
  'landing', 'login', 'signup', 'farmer-register',
  'farmer-dashboard', 'farmer-onboarding', 'farmer-advanced-profile',
  'farmer-my-stock', 'farmer-stock-form', 'farmer-requests', 'farmer-status',
]
const DDP_PAGES: Page[] = ['ddp-overview', 'ddp-farms', 'ddp-farm-review', 'ddp-inventory', 'ddp-inventory-review', 'ddp-master', 'ddp-buyer']
const PUBLIC_PAGES: Page[] = ['landing', 'login', 'signup']

// ─── Sub-components ──────────────────────────────────────────────────────────

function LangToggle({ lang, setLang }: { lang: Lang; setLang: (l: Lang) => void }) {
  return (
    <div className="lang-toggle">
      <button className={`lang-btn${lang === 'en' ? ' lang-active' : ''}`} onClick={() => setLang('en')}>EN</button>
      <button className={`lang-btn${lang === 'th' ? ' lang-active' : ''}`} onClick={() => setLang('th')}>ไทย</button>
    </div>
  )
}

function UserBadge({ profile, onSignOut }: { profile: UserProfile; onSignOut: () => void }) {
  return (
    <div className="user-badge">
      <span className={`user-role-chip ${profile.role === 'ddp_admin' ? 'chip-admin' : 'chip-farmer'}`}>
        {profile.role === 'ddp_admin' ? 'Admin' : 'Farmer'}
      </span>
      <span className="user-email">{profile.displayName || profile.email}</span>
      <button className="nav-reset-btn" onClick={onSignOut}>Sign out</button>
    </div>
  )
}

function AccessDenied({ onBack }: { onBack: () => void }) {
  return (
    <div className="page-wrap" style={{ textAlign: 'center', paddingTop: 80 }}>
      <div style={{ fontSize: 48, marginBottom: 16 }}>🔒</div>
      <h2 style={{ color: '#1e293b', marginBottom: 12 }}>Access Denied</h2>
      <p style={{ color: '#64748b', marginBottom: 28, maxWidth: 380, margin: '0 auto 28px' }}>
        You don't have permission to view this page. DDP Admin access is required.
      </p>
      <button className="btn btn-primary" onClick={onBack}>Go back</button>
    </div>
  )
}

// ─── Main App ────────────────────────────────────────────────────────────────

export default function App() {
  const [page, setPage] = useState<Page>('landing')
  const [lang, setLang] = useState<Lang>('en')
  const [inventory, setInventory] = useState<InventoryItem[]>(() => getInventoryBatches())
  const [farms, setFarms] = useState<FarmProfile[]>(() => getFarmProfiles())
  const [reviewFarmId, setReviewFarmId] = useState<string | null>(null)
  const [reviewItemId, setReviewItemId] = useState<string | null>(null)
  const [dbError, setDbError] = useState<string | null>(null)

  // Auth state — only meaningful when isSupabaseConfigured is true
  const [authLoading, setAuthLoading] = useState<boolean>(isSupabaseConfigured)
  const [currentProfile, setCurrentProfile] = useState<UserProfile | null>(null)

  // Farmer data scope — null until loaded, empty Sets if farmer has no data
  const [farmerScope, setFarmerScope] = useState<FarmerScope | null>(null)

  // Review requests (owner → farmer messages) and stock edit tracking
  const [reviewRequests, setReviewRequests] = useState<ReviewRequest[]>(() => loadReviewRequests())
  const [marketBenchmarks, setMarketBenchmarks] = useState<MarketBenchmark[]>(() => loadMarketBenchmarks())
  const [stockEditItemId, setStockEditItemId] = useState<string | null>(null)

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
        if (dbRequests.length > 0) setReviewRequests(dbRequests)
      })
      .catch(err => {
        console.warn('getFarmerScope / data load failed:', err)
        setFarmerScope({ farmIds: new Set(), itemIds: new Set() })
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

  // ── Load market benchmarks from Supabase once on mount ───────────────────
  useEffect(() => {
    if (!isSupabaseConfigured) return
    loadMarketBenchmarksFromDB()
      .then(benchmarks => { if (benchmarks.length > 0) setMarketBenchmarks(benchmarks) })
      .catch(err => console.warn('loadMarketBenchmarksFromDB failed:', err))
  }, [])

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
    setPage(p)
    window.scrollTo(0, 0)
  }

  async function handleSignOut() {
    await signOut()
    setCurrentProfile(null)
    setPage('landing')
    window.scrollTo(0, 0)
  }

  // ── Landing page entry points ─────────────────────────────────────────────
  function handleEnterFarmer() {
    if (isDemo) { goTo('farmer-register'); return }
    if (!isSignedIn) { goTo('signup'); return }
    goTo('farmer-dashboard')
  }


  function handleEnterDDP() {
    if (!isDemo && !isSignedIn) { goTo('login'); return }
    if (!isAdminRole) { setDbError('DDP Admin access is required to enter the operator portal.'); return }
    goTo('ddp-overview')
  }

  // ── Data handlers ─────────────────────────────────────────────────────────
  function handleInventorySubmit(item: InventoryItem) {
    setInventory(prev => {
      const exists = prev.some(i => i.id === item.id)
      return exists ? prev.map(i => i.id === item.id ? item : i) : [item, ...prev]
    })
    createInventoryBatch(item, currentProfile?.id).catch(onDbError)
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

  // ── Auth loading screen ───────────────────────────────────────────────────
  if (authLoading) {
    return (
      <div className="app auth-loading">
        <span>Loading…</span>
      </div>
    )
  }

  // ── Render ────────────────────────────────────────────────────────────────
  const showFarmerNav = isSignedIn
  const showDDPNav = isAdminRole

  return (
    <div className="app">

      {/* ── Navbar (all non-landing pages) ── */}
      {page !== 'landing' && page !== 'login' && page !== 'signup' && page !== 'farmer-register' && (
        <nav className="navbar">
          <div className="navbar-brand" onClick={() => goTo('landing')} style={{ cursor: 'pointer' }}>
            <span className="brand-logo">DDP</span>
            <span className="brand-name">Supply Intelligence</span>
          </div>

          <div className="navbar-links">
            {showFarmerNav && (
              <div className="nav-group">
                <span className="nav-group-label">{T[lang].farmerGroupLabel}</span>
                <button
                  className={`nav-btn${page === 'farmer-dashboard' ? ' nav-active' : ''}`}
                  onClick={() => goTo('farmer-dashboard')}
                >{T[lang].navDashboard}</button>
                <button
                  className={`nav-btn${page === 'farmer-onboarding' ? ' nav-active' : ''}`}
                  onClick={() => goTo('farmer-onboarding')}
                >{T[lang].buildProfile}</button>
                <button
                  className={`nav-btn${page === 'farmer-my-stock' ? ' nav-active' : ''}`}
                  onClick={() => goTo('farmer-my-stock')}
                >{T[lang].myStock}</button>
                <button
                  className={`nav-btn${page === 'farmer-status' ? ' nav-active' : ''}`}
                  onClick={() => goTo('farmer-status')}
                >{T[lang].myActivity}</button>
              </div>
            )}

            {showFarmerNav && showDDPNav && <div className="nav-sep" />}

            {showDDPNav && (
              <div className="nav-group">
                <span className="nav-group-label ddp-label">DDP</span>
                <button
                  className={`nav-btn ddp-nav-btn${page === 'ddp-overview' ? ' nav-active' : ''}`}
                  onClick={() => goTo('ddp-overview')}
                >Overview</button>
                <button
                  className={`nav-btn ddp-nav-btn${page === 'ddp-farms' || page === 'ddp-farm-review' ? ' nav-active' : ''}`}
                  onClick={() => goTo('ddp-farms')}
                >Farm Profiles</button>
                <button
                  className={`nav-btn ddp-nav-btn${page === 'ddp-inventory' || page === 'ddp-inventory-review' ? ' nav-active' : ''}`}
                  onClick={() => goTo('ddp-inventory')}
                >Inventory Review</button>
                <button
                  className={`nav-btn ddp-nav-btn${page === 'ddp-master' ? ' nav-active' : ''}`}
                  onClick={() => goTo('ddp-master')}
                >Master Inventory</button>
                <button
                  className={`nav-btn ddp-nav-btn${page === 'ddp-buyer' ? ' nav-active' : ''}`}
                  onClick={() => goTo('ddp-buyer')}
                >Buyer Preview</button>
              </div>
            )}
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

      {/* ── Landing page ── */}
      {page === 'landing' && (
        <div>
          <div className="landing-nav">
            <div className="navbar-brand">
              <span className="brand-logo">DDP</span>
              <span className="brand-name" style={{ color: '#e2e8f0' }}>Supply Intelligence</span>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {isDemo && <LangToggle lang={lang} setLang={setLang} />}
              {!isDemo && isSignedIn && (
                <UserBadge profile={currentProfile!} onSignOut={handleSignOut} />
              )}
              {!isDemo && !isSignedIn && (
                <button className="btn btn-primary" style={{ fontSize: 13, padding: '6px 14px' }} onClick={() => goTo('login')}>
                  Sign in
                </button>
              )}
            </div>
          </div>
          <LandingPage
            lang={lang}
            onEnterFarmer={handleEnterFarmer}
            onEnterDDP={handleEnterDDP}
          />
        </div>
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
            onSuccess={() => goTo('landing')}
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
      {page !== 'landing' && page !== 'login' && page !== 'signup' && page !== 'farmer-register' && (
        <main className="main-content">

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
              openRequestsCount={reviewRequests.filter(r => r.status === 'open').length}
            />
          )}

          {page === 'farmer-my-stock' && (
            <FarmerMyStock
              lang={lang}
              inventory={farmerInventory}
              onAddNew={() => { setStockEditItemId(null); goTo('farmer-stock-form') }}
              onEdit={handleEditStock}
              openRequestCount={reviewRequests.filter(r => r.status === 'open').length}
              onGoRequests={() => goTo('farmer-requests')}
              onCoaUpload={isFarmerRole && isSupabaseConfigured ? handleCoaUpload : undefined}
            />
          )}

          {page === 'farmer-stock-form' && (
            <FarmerSubmitInventory
              lang={lang}
              farms={farmerFarms}
              initialItem={stockEditItemId ? farmerInventory.find(i => i.id === stockEditItemId) : null}
              onSubmit={item => {
                handleInventorySubmit(item)
                if (item.stockStatus !== 'draft') goTo('farmer-my-stock')
              }}
              onBack={() => goTo('farmer-my-stock')}
              marketBenchmarks={marketBenchmarks}
              openRequests={reviewRequests}
            />
          )}

          {page === 'farmer-requests' && (
            <FarmerRequests
              lang={lang}
              requests={reviewRequests}
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
              onReview={handleReviewFarm}
            />
          )}

          {page === 'ddp-farm-review' && isAdminRole && reviewFarm && (
            <DDPFarmReview
              farm={reviewFarm}
              onBack={() => goTo('ddp-farms')}
              onAction={handleFarmAction}
            />
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
            />
          )}

          {page === 'ddp-master' && isAdminRole && (
            <DDPMasterInventory
              inventory={inventory}
              farms={farms}
              onGetCoaUrl={isSupabaseConfigured ? getCoaSignedUrl : undefined}
            />
          )}

          {page === 'ddp-buyer' && isAdminRole && (
            <DDPBuyerPreview
              inventory={inventory}
            />
          )}
        </main>
      )}

      {isDemo && (
        <div className="demo-utility-strip">
          <span className="db-mode-badge">○ Demo mode: localStorage</span>
          <button className="demo-reset-btn" onClick={handleReset} title="Reset all demo data">
            ↺ Reset Demo
          </button>
        </div>
      )}
    </div>
  )
}
