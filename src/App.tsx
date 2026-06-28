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
  resetDemoData,
  isSupabaseConfigured,
  getFarmerScope,
  type FarmerScope,
} from './lib/db'
import { loadInventory, loadFarms } from './data'
import {
  signOut,
  subscribeToAuthChanges,
  type UserProfile,
} from './services/auth'
import { T } from './translations'
import type { Page, Lang, InventoryItem, FarmProfile, FarmStatus, InventoryStatus } from './types'
import LandingPage from './pages/LandingPage'
import LoginPage from './pages/LoginPage'
import SignupPage from './pages/SignupPage'
import FarmerOnboarding from './pages/FarmerOnboarding'
import FarmerSubmitInventory from './pages/FarmerSubmitInventory'
import FarmerStatus from './pages/FarmerStatus'
import DDPOverview from './pages/DDPOverview'
import DDPFarmProfiles from './pages/DDPFarmProfiles'
import DDPFarmReview from './pages/DDPFarmReview'
import DDPInventoryDashboard from './pages/DDPInventoryDashboard'
import DDPInventoryReview from './pages/DDPInventoryReview'
import DDPMasterInventory from './pages/DDPMasterInventory'
import DDPBuyerPreview from './pages/DDPBuyerPreview'

const FARMER_PAGES: Page[] = ['landing', 'login', 'signup', 'farmer-onboarding', 'farmer-submit', 'farmer-status']
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
  const [scopeLoading, setScopeLoading] = useState(false)

  // ── Persist to localStorage on every state change ────────────────────────
  useEffect(() => { persistInventory(inventory) }, [inventory])
  useEffect(() => { persistFarms(farms) }, [farms])

  // ── Auth subscription ────────────────────────────────────────────────────
  useEffect(() => {
    if (!isSupabaseConfigured) {
      setAuthLoading(false)
      return
    }
    const unsubscribe = subscribeToAuthChanges((profile) => {
      setCurrentProfile(profile)
      setAuthLoading(false)
      // Clear scope on sign-out
      if (!profile) setFarmerScope(null)
    })
    return unsubscribe
  }, [])

  // ── Load farmer scope when a farmer signs in ─────────────────────────────
  useEffect(() => {
    if (!isSupabaseConfigured || !currentProfile || currentProfile.role !== 'farmer') {
      if (!currentProfile || currentProfile.role !== 'farmer') setFarmerScope(null)
      return
    }
    setScopeLoading(true)
    getFarmerScope(currentProfile.id)
      .then(scope => setFarmerScope(scope))
      .catch(err => {
        console.warn('getFarmerScope failed:', err)
        // Fail safe: empty scope so farmer sees no other farms
        setFarmerScope({ farmIds: new Set(), itemIds: new Set() })
      })
      .finally(() => setScopeLoading(false))
  }, [currentProfile])

  // ── Role helpers ─────────────────────────────────────────────────────────
  // In demo mode (no Supabase), everything is open — preserve existing behaviour.
  const isDemo = !isSupabaseConfigured
  const isSignedIn = isDemo || currentProfile !== null
  const isAdminRole = isDemo || currentProfile?.role === 'ddp_admin'
  const isFarmerRole = !isDemo && currentProfile?.role === 'farmer'
  const isFarmerPage = FARMER_PAGES.includes(page)

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
    if (!isDemo && !isSignedIn) { goTo('signup'); return }
    goTo('farmer-onboarding')
  }

  function handleEnterDDP() {
    if (!isDemo && !isSignedIn) { goTo('login'); return }
    if (!isAdminRole) { setDbError('DDP Admin access is required to enter the operator portal.'); return }
    goTo('ddp-overview')
  }

  // ── Data handlers ─────────────────────────────────────────────────────────
  function handleInventorySubmit(item: InventoryItem) {
    setInventory(prev => [item, ...prev])
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

  function handleFarmSubmit(farm: FarmProfile) {
    setFarms(prev => [farm, ...prev])
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
      {page !== 'landing' && page !== 'login' && page !== 'signup' && (
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
                  className={`nav-btn${page === 'farmer-onboarding' ? ' nav-active' : ''}`}
                  onClick={() => goTo('farmer-onboarding')}
                >{T[lang].navOnboarding}</button>
                <button
                  className={`nav-btn${page === 'farmer-submit' ? ' nav-active' : ''}`}
                  onClick={() => goTo('farmer-submit')}
                >{T[lang].navSubmit}</button>
                <button
                  className={`nav-btn${page === 'farmer-status' ? ' nav-active' : ''}`}
                  onClick={() => goTo('farmer-status')}
                >{T[lang].navStatus}</button>
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
            onSuccess={() => goTo('farmer-onboarding')}
            onGoLogin={() => goTo('login')}
          />
        </main>
      )}

      {/* ── App pages ── */}
      {page !== 'landing' && page !== 'login' && page !== 'signup' && (
        <main className="main-content">

          {page === 'farmer-onboarding' && (
            <FarmerOnboarding
              lang={lang}
              onSubmit={handleFarmSubmit}
              onBack={() => goTo('farmer-status')}
            />
          )}

          {page === 'farmer-submit' && (
            scopeLoading && isFarmerRole
              ? <div className="scope-loading">Loading your farm data…</div>
              : <FarmerSubmitInventory
                  lang={lang}
                  farms={farmerFarms}
                  onSubmit={handleInventorySubmit}
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
              onAction={handleInventoryAction}
            />
          )}

          {page === 'ddp-master' && isAdminRole && (
            <DDPMasterInventory
              inventory={inventory}
              farms={farms}
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
