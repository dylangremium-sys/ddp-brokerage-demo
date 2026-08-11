import type { Page } from '../../types'

/**
 * The console shell on the Organic design system — handoff screen 4's sidebar.
 *
 * WHY THIS IS A SIBLING OF AdminShell AND NOT A CHANGE TO IT. Fifteen screens
 * render inside AdminShell. Restyling it would move all fifteen at once, which
 * is exactly the uncontrolled change a pilot exists to avoid. This shell is used
 * by the screens that have been rebuilt; everything else keeps the shell it has.
 *
 * Everything is inside `.organic-scope`, so the design system's tokens and
 * component classes apply here and nowhere else. See styles/organicScoped.css.
 */

export interface ConsoleNavItem {
  page: Page
  label: string
  /**
   * Matters waiting on this area. Zero renders as NOTHING, never as "0" — a
   * zero in a navigation counter reads as a score, and the operator has to
   * decode it before ignoring it. Absence is the faster signal.
   */
  count?: number
}

export default function OrganicConsoleShell({
  page, items, signedInAs, children, goTo, onSignOut,
}: {
  page: Page
  items: ConsoleNavItem[]
  signedInAs: string
  children: React.ReactNode
  /** Real navigation. Passed in so the shell holds no routing knowledge. */
  goTo: (page: Page) => void
  /**
   * Required, not optional. This shell REPLACES AdminShell on the screens that
   * use it, and AdminShell is where sign-out lives. A console frame with no way
   * out is not a design choice.
   */
  onSignOut: () => void
}) {
  return (
    <div
      className="organic-scope"
      style={{ display: 'grid', gridTemplateColumns: '252px 1fr', minHeight: '100vh' }}
    >
      <aside
        style={{
          background: 'var(--color-accent-2-900)', padding: '30px 20px',
          display: 'flex', flexDirection: 'column', gap: 26,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span
            aria-hidden="true"
            style={{
              width: 34, height: 34, borderRadius: 10, background: 'var(--color-accent-500)',
              display: 'grid', placeItems: 'center',
              fontFamily: "'IBM Plex Mono', monospace", fontSize: 11,
              color: 'var(--color-accent-2-900)',
            }}
          >
            DDP
          </span>
          <span style={{ fontWeight: 600, fontSize: 15, color: 'var(--color-neutral-100)' }}>
            Operations
          </span>
        </div>

        <nav style={{ display: 'grid', gap: 2 }} aria-label="Console">
          {items.map(item => {
            const active = item.page === page
            return (
              <button
                key={item.page}
                type="button"
                aria-current={active ? 'page' : undefined}
                onClick={() => goTo(item.page)}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
                  border: 'none', cursor: 'pointer', textAlign: 'left',
                  borderRadius: 999, padding: '11px 14px',
                  fontFamily: 'var(--font-body)', fontSize: 14,
                  fontWeight: active ? 600 : 500,
                  background: active ? 'var(--color-accent-2-700)' : 'transparent',
                  color: active ? 'var(--color-neutral-100)' : 'var(--color-accent-2-200)',
                }}
              >
                <span>{item.label}</span>
                <span
                  style={{
                    fontFamily: "'IBM Plex Mono', monospace", fontSize: 12,
                    color: active ? 'var(--color-accent-300)' : 'var(--color-accent-2-400)',
                  }}
                >
                  {item.count ? item.count : ''}
                </span>
              </button>
            )
          })}
        </nav>

        <div style={{ marginTop: 'auto', fontSize: 13, color: 'var(--color-accent-2-300)' }}>
          {signedInAs}
          <div style={{ color: 'var(--color-accent-400)', marginTop: 4 }}>Audit log recording</div>
          <button
            type="button"
            onClick={onSignOut}
            style={{
              marginTop: 12, border: '1px solid var(--color-accent-2-700)', background: 'transparent',
              color: 'var(--color-accent-2-200)', borderRadius: 999, padding: '8px 16px',
              fontFamily: 'var(--font-body)', fontSize: 13, cursor: 'pointer',
            }}
          >
            Sign out
          </button>
        </div>
      </aside>

      <main style={{ background: 'var(--color-bg)', padding: '40px 48px 90px', minWidth: 0 }}>
        {children}
      </main>
    </div>
  )
}
