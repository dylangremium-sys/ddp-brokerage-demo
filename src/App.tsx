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
    })
    return unsubscribe
  }, [])

  // ── Role helpers ─────────────────────────────────────────────────────────
  // In demo mode (no Supabase), everything is open — preserve existing behaviour.
  const isDemo = !isSupabaseConfigured
  const isSignedIn = isDemo || currentProfile !== null
  const isAdminRole = isDemo || currentProfile?.role === 'ddp_admin'
  const isFarmerRole = !isDemo && currentProfile?.role === 'farmer'
  const isFarmerPage = FARMER_PAGES.includes(page)

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
  }

  function handleFarmSubmit(farm: FarmProfile) {
    setFarms(prev => [farm, ...prev])
    createFarmProfile(farm, currentProfile?.id).catch(onDbError)
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
            <span
              className="db-mode-badge"
              title={isSupabaseConfigured
                ? 'Connected to Supabase database'
                : 'Using browser localStorage — no Supabase env vars set'}
            >
              {isSupabaseConfigured ? '● Database mode: Supabase' : '○ Demo mode: localStorage'}
            </span>

            {isDemo ? (
              <>
                {isFarmerPage && <LangToggle lang={lang} setLang={setLang} />}
                <button className="nav-reset-btn" onClick={handleReset} title="Reset all demo data">
                  ↺ Reset Demo
                </button>
              </>
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
              <span
                className="db-mode-badge"
                title={isSupabaseConfigured ? 'Supabase connected' : 'localStorage demo mode'}
              >
                {isSupabaseConfigured ? '● Database mode: Supabase' : '○ Demo mode: localStorage'}
              </span>
              {isDemo && <LangToggle lang={lang} setLang={setLang} />}
              {!isDemo && isSignedIn && (
                <UserBadge profile={currentProfile!} onSignOut={handleSignOut} />
              )}
              {!isDemo && !isSignedIn && (
                <button className="btn btn-primary" style={{ fontSize: 13, padding: '6px 14px' }} onClick={() => goTo('login')}>
                  Sign in
                </button>
              )}
              {isDemo && (
                <button className="nav-reset-btn" onClick={handleReset} title="Reset demo data">↺ Reset Demo</button>
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
            <FarmerSubmitInventory
              lang={lang}
              farms={farms}
              onSubmit={handleInventorySubmit}
            />
          )}

          {page === 'farmer-status' && (
            <FarmerStatus
              lang={lang}
              inventory={inventory}
              farms={farms}
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
    </div>
  )
}
