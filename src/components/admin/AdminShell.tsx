import type { ReactNode } from 'react'
import type { Page } from '../../types'
import type { UserProfile } from '../../services/auth'
import { DDPMonogramLogo } from '../logos'
import UserBadge from '../shared/UserBadge'
import AdminNav from './AdminNav'
import { contentVariantClass } from './adminPresentation'

/**
 * Breadcrumb label per existing route. Presentation only — this maps the
 * router's current Page to a readable area name for the utility header. It
 * introduces no route and changes no navigation behaviour.
 */
const AREA_LABEL: Partial<Record<Page, string>> = {
  'ddp-overview': 'Operations overview',
  'ddp-farms': 'Farm profiles',
  'ddp-farm-review': 'Farm review',
  'ddp-master': 'Supply ledger',
  'ddp-inventory': 'Inventory review',
  'ddp-inventory-review': 'Inventory review',
  'ddp-missing-documents': 'Missing documents',
  'ddp-coa-intelligence': 'COA intelligence',
  'ddp-risk-register': 'Risk register',
  'ddp-compliance-watchtower': 'Compliance watchtower',
  'ddp-buyer': 'Buyer pack preview',
}

/**
 * Editorial Operations authenticated shell: deep-green side navigation, a 64px
 * utility header, and the routed content area.
 *
 * Rendered only for a signed-in DDP admin session. Farmer and demo sessions
 * keep the existing top navbar untouched, so this task does not alter the
 * farmer portal.
 *
 * The utility header intentionally carries no global search control: none
 * exists in the product today, and inventing one would imply behaviour that is
 * not there. Likewise no language control — admin pages are not localised
 * today, and adding that is a behavioural change beyond this task's scope.
 */
export default function AdminShell({ page, goTo, profile, onSignOut, children }: {
  page: Page
  goTo: (p: Page) => void
  profile: UserProfile | null
  onSignOut: () => void
  children: ReactNode
}) {
  return (
    <div className="eo-shell">
      <a className="eo-skip" href="#eo-content">Skip to content</a>

      <aside className="eo-nav">
        <button
          className="eo-nav-brand"
          onClick={() => goTo('landing')}
          aria-label="Go to home"
        >
          <DDPMonogramLogo height={32} />
          <span>DDP Brokerage</span>
        </button>
        <AdminNav page={page} goTo={goTo} />
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

        <main id="eo-content" className={`eo-content ${contentVariantClass(page)}`}>
          {children}
        </main>
      </div>
    </div>
  )
}
