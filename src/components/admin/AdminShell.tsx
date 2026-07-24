import type { ReactNode } from 'react'
import type { Page } from '../../types'
import type { UserProfile } from '../../services/auth'
import { DDPMonogramLogo } from '../logos'
import UserBadge from '../shared/UserBadge'
import AdminNav from './AdminNav'

/**
 * Readable area name per existing route, for the header breadcrumb. Presentation
 * only: it maps the router's current Page to a label and introduces no route.
 */
const AREA_LABEL: Partial<Record<Page, string>> = {
  'ddp-overview': 'Operations Overview',
  'ddp-farms': 'Compliance',
  'ddp-farm-review': 'Farm Review',
  'ddp-inventory': 'Inventory Review',
  'ddp-inventory-review': 'Inventory Review',
  'ddp-master': 'Master Inventory',
  'ddp-buyer': 'Buyer Preview',
  'ddp-missing-documents': 'Missing Documents',
  'ddp-coa-intelligence': 'COA Intelligence',
  'ddp-risk-register': 'Risk Register',
  'ddp-compliance-watchtower': 'Compliance Watchtower',
  'ddp-operations-desk': 'Operations Desk',
}

/**
 * Editorial admin chrome: deep-green side navigation, a utility header and the
 * routed content area.
 *
 * Presentation only. It renders whatever it is given and decides nothing: no
 * state, no effects, no data, no routing. `goTo`, `profile` and `onSignOut` are
 * the app's existing values, passed straight through.
 *
 * The header deliberately carries no global search or language control — neither
 * exists for admin routes today, and adding one would imply behaviour that is
 * not there.
 */
export default function AdminShell({ page, goTo, profile, onSignOut, children, onBrandClick }: {
  page: Page
  goTo: (p: Page) => void
  profile: UserProfile | null
  onSignOut: () => void
  children: ReactNode
  // Brand/home click. Optional so the shell keeps its previous behaviour if a
  // caller does not pass it; App supplies a handler that routes a signed-in
  // admin to their dashboard rather than the public landing.
  onBrandClick?: () => void
}) {
  return (
    <div className="eo-shell">
      <a className="eo-skip" href="#eo-content">Skip to content</a>

      <aside className="eo-nav">
        <button className="eo-nav-brand" onClick={onBrandClick ?? (() => goTo('landing'))} aria-label="Go to home">
          <DDPMonogramLogo height={32} />
          <span>DDP Brokerage</span>
        </button>
        <AdminNav page={page} goTo={goTo} variant="sidebar" />
      </aside>

      <div className="eo-main">
        <header className="eo-header">
          <nav className="eo-crumb" aria-label="Breadcrumb">
            <span>DDP</span>
            <span className="eo-crumb-sep" aria-hidden="true">/</span>
            <span className="eo-crumb-current" aria-current="page">
              {AREA_LABEL[page] ?? 'Operations'}
            </span>
          </nav>
          <div className="eo-header-right">
            {profile && <UserBadge profile={profile} onSignOut={onSignOut} />}
          </div>
        </header>

        <main
          id="eo-content"
          className={`eo-content ${page === 'ddp-overview' ? 'eo-content-canvas' : 'eo-content-legacy'}`}
        >
          {children}
        </main>
      </div>
    </div>
  )
}
