import type { Page } from '../../types'
import {
  SIDEBAR_SECTIONS,
  TOPBAR_ENTRIES,
  type AdminNavVariant,
} from './adminPresentation'

/** Minimal outlined icons — currentColor, 1.5 stroke, no colour of their own. */
function Icon({ d }: { d: string }) {
  return (
    <svg
      className="eo-nav-icon"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={d} />
    </svg>
  )
}

/**
 * Admin navigation.
 *
 * `variant` is explicit rather than inferred from CSS or context: the editorial
 * sidebar markup is only ever correct inside AdminShell, and the compact navbar
 * markup is only ever correct inside the legacy 56px `.navbar`, which demo mode
 * still uses and may share with FarmerNav.
 *
 * Both variants draw their destinations and active-state rules from the same
 * definitions in adminPresentation, so routing cannot drift between them.
 */
export default function AdminNav({ page, goTo, variant = 'sidebar' }: {
  page: Page
  goTo: (p: Page) => void
  variant?: AdminNavVariant
}) {
  if (variant === 'topbar') {
    return (
      <div className="nav-group">
        <span className="nav-group-label ddp-label">DDP</span>
        {TOPBAR_ENTRIES.map(e => (
          <button
            key={e.target}
            className={`nav-btn ddp-nav-btn${e.isActive(page) ? ' nav-active' : ''}`}
            aria-current={e.isActive(page) ? 'page' : undefined}
            onClick={() => goTo(e.target)}
          >{e.label}</button>
        ))}
      </div>
    )
  }

  return (
    <div className="eo-nav-scroll">
      {SIDEBAR_SECTIONS.map((section, i) => (
        <div className="eo-nav-section" key={section.label ?? `section-${i}`}>
          {section.label && <div className="eo-nav-section-label">{section.label}</div>}
          {section.entries.map(e => (
            <button
              key={e.target}
              className="eo-nav-item"
              aria-current={e.isActive(page) ? 'page' : undefined}
              onClick={() => goTo(e.target)}
            >
              <Icon d={e.icon} />
              <span>{e.label}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}
