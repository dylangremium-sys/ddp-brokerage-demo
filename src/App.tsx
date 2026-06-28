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
import { T } from './translations'
import type { Page, Lang, InventoryItem, FarmProfile, FarmStatus, InventoryStatus } from './types'
import LandingPage from './pages/LandingPage'
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

const FARMER_PAGES: Page[] = ['landing', 'farmer-onboarding', 'farmer-submit', 'farmer-status']

function LangToggle({ lang, setLang }: { lang: Lang; setLang: (l: Lang) => void }) {
  return (
    <div className="lang-toggle">
      <button className={`lang-btn${lang === 'en' ? ' lang-active' : ''}`} onClick={() => setLang('en')}>EN</button>
      <button className={`lang-btn${lang === 'th' ? ' lang-active' : ''}`} onClick={() => setLang('th')}>ไทย</button>
    </div>
  )
}

export default function App() {
  const [page, setPage] = useState<Page>('landing')
  const [lang, setLang] = useState<Lang>('en')
  const [inventory, setInventory] = useState<InventoryItem[]>(() => getInventoryBatches())
  const [farms, setFarms] = useState<FarmProfile[]>(() => getFarmProfiles())
  const [reviewFarmId, setReviewFarmId] = useState<string | null>(null)
  const [reviewItemId, setReviewItemId] = useState<string | null>(null)
  const [dbError, setDbError] = useState<string | null>(null)

  useEffect(() => { persistInventory(inventory) }, [inventory])
  useEffect(() => { persistFarms(farms) }, [farms])

  function onDbError(err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('Supabase error:', msg)
    setDbError(msg)
  }

  const t = T[lang]
  const isFarmerPage = FARMER_PAGES.includes(page)

  function goTo(p: Page) {
    setPage(p)
    window.scrollTo(0, 0)
  }

  function handleInventorySubmit(item: InventoryItem) {
    setInventory(prev => [item, ...prev])
    createInventoryBatch(item).catch(onDbError)
  }

  function handleFarmSubmit(farm: FarmProfile) {
    setFarms(prev => [farm, ...prev])
    createFarmProfile(farm).catch(onDbError)
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
      updateFarmProfileStatus(farmId, newStatus, oldStatus).catch(onDbError)
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
      updateInventoryStatus(itemId, newStatus, oldStatus).catch(onDbError)
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
  const reviewItemFarm = reviewItem ? farms.find(f => f.id === reviewItem.farmId || f.tradingName === reviewItem.farmName) : undefined

  return (
    <div className="app">
      {page !== 'landing' && (
        <nav className="navbar">
          <div className="navbar-brand" onClick={() => goTo('landing')} style={{ cursor: 'pointer' }}>
            <span className="brand-logo">DDP</span>
            <span className="brand-name">Supply Intelligence</span>
          </div>

          <div className="navbar-links">
            <div className="nav-group">
              <span className="nav-group-label">{t.farmerGroupLabel}</span>
              <button
                className={`nav-btn${page === 'farmer-onboarding' ? ' nav-active' : ''}`}
                onClick={() => goTo('farmer-onboarding')}
              >{t.navOnboarding}</button>
              <button
                className={`nav-btn${page === 'farmer-submit' ? ' nav-active' : ''}`}
                onClick={() => goTo('farmer-submit')}
              >{t.navSubmit}</button>
              <button
                className={`nav-btn${page === 'farmer-status' ? ' nav-active' : ''}`}
                onClick={() => goTo('farmer-status')}
              >{t.navStatus}</button>
            </div>

            <div className="nav-sep" />

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
          </div>

          <div className="navbar-right">
            <span className="db-mode-badge" title={isSupabaseConfigured ? 'Connected to Supabase database' : 'Using browser localStorage — no Supabase env vars set'}>
              {isSupabaseConfigured ? '● Database mode: Supabase' : '○ Demo mode: localStorage'}
            </span>
            {isFarmerPage && <LangToggle lang={lang} setLang={setLang} />}
            <button className="nav-reset-btn" onClick={handleReset} title="Reset all demo data">
              ↺ Reset Demo
            </button>
          </div>
        </nav>
      )}

      {page === 'landing' && (
        <div>
          <div className="landing-nav">
            <div className="navbar-brand">
              <span className="brand-logo">DDP</span>
              <span className="brand-name" style={{ color: '#e2e8f0' }}>Supply Intelligence</span>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span className="db-mode-badge" title={isSupabaseConfigured ? 'Connected to Supabase database' : 'Using browser localStorage — no Supabase env vars set'}>
                {isSupabaseConfigured ? '● Database mode: Supabase' : '○ Demo mode: localStorage'}
              </span>
              <LangToggle lang={lang} setLang={setLang} />
              <button className="nav-reset-btn" onClick={handleReset} title="Reset demo data">↺ Reset Demo</button>
            </div>
          </div>
          <LandingPage
            lang={lang}
            onEnterFarmer={() => goTo('farmer-onboarding')}
            onEnterDDP={() => goTo('ddp-overview')}
          />
        </div>
      )}

      {dbError && (
        <div className="db-error-banner" role="alert">
          <strong>Database write failed:</strong> {dbError}
          <button className="db-error-dismiss" onClick={() => setDbError(null)} aria-label="Dismiss">✕</button>
        </div>
      )}

      {page !== 'landing' && (
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

          {page === 'ddp-overview' && (
            <DDPOverview
              farms={farms}
              inventory={inventory}
              onReviewFarm={handleReviewFarm}
              onReviewItem={handleReviewItem}
            />
          )}

          {page === 'ddp-farms' && (
            <DDPFarmProfiles
              farms={farms}
              onReview={handleReviewFarm}
            />
          )}

          {page === 'ddp-farm-review' && reviewFarm && (
            <DDPFarmReview
              farm={reviewFarm}
              onBack={() => goTo('ddp-farms')}
              onAction={handleFarmAction}
            />
          )}

          {page === 'ddp-inventory' && (
            <DDPInventoryDashboard
              inventory={inventory}
              onReview={handleReviewItem}
            />
          )}

          {page === 'ddp-inventory-review' && reviewItem && (
            <DDPInventoryReview
              item={reviewItem}
              farm={reviewItemFarm}
              onBack={() => goTo('ddp-inventory')}
              onAction={handleInventoryAction}
            />
          )}

          {page === 'ddp-master' && (
            <DDPMasterInventory
              inventory={inventory}
              farms={farms}
            />
          )}

          {page === 'ddp-buyer' && (
            <DDPBuyerPreview
              inventory={inventory}
            />
          )}
        </main>
      )}
    </div>
  )
}
