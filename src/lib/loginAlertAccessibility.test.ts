import { describe, expect, it } from 'vitest'

/**
 * Login failure announcement to assistive technology (audit F9).
 *
 * This repo's vitest environment is 'node' and the include glob covers only
 * `src/**‍/*.test.ts` — there is no jsdom and .tsx is never rendered under
 * test. The accessibility contract on the login error alert is therefore
 * asserted against source text via `import.meta.glob(..., '?raw')`, the
 * existing convention here (see operationsDeskRouting.test.ts and
 * statusPendingClassMapping.test.ts).
 *
 * The finding: the login error rendered as a bare styled <div>, with focus
 * left on the submit button — so a screen-reader user who submitted bad
 * credentials heard nothing at all. The fix is role="alert" plus a ref+effect
 * that moves focus onto the (tabIndex={-1}) alert when the error appears.
 */
function raw(glob: Record<string, string>): string {
  return Object.values(glob)[0] ?? ''
}

const LOGIN_SRC = raw(import.meta.glob('../pages/public/LoginPage.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)

describe('Login alert accessibility — source fixture is readable', () => {
  it('loads the LoginPage source under assertion', () => {
    expect(LOGIN_SRC.length).toBeGreaterThan(500)
  })
})

describe('Login alert accessibility — announcement contract', () => {
  // Scope assertions to the error alert element itself, not the whole file.
  const alertElement = LOGIN_SRC.slice(
    LOGIN_SRC.indexOf('{error && ('),
    LOGIN_SRC.indexOf('{error}'),
  )

  it('the error element carries role="alert" so the failure is announced', () => {
    expect(alertElement).toContain('role="alert"')
    expect(alertElement).toContain('alert alert-danger') // existing styling retained
  })

  it('the error element carries tabIndex={-1} so it can receive programmatic focus', () => {
    expect(alertElement).toContain('tabIndex={-1}')
    expect(alertElement).toContain('ref={errorRef}')
  })

  it('a ref + effect moves focus to the alert when the error appears', () => {
    // The ref exists…
    expect(LOGIN_SRC).toContain('const errorRef = useRef<HTMLDivElement | null>(null)')
    // …and the effect focuses it, keyed on (and gated by) the error state —
    // focus fires when error becomes non-null, not on every render.
    const effect = LOGIN_SRC.slice(
      LOGIN_SRC.indexOf('useEffect('),
      LOGIN_SRC.indexOf('}, [error])') + '}, [error])'.length,
    )
    expect(effect.length).toBeGreaterThan(0)
    expect(effect).toContain('if (error) errorRef.current?.focus()')
    expect(effect).toContain('}, [error])')
  })

  it('falsification: the bare un-announced alert div no longer appears', () => {
    // The exact pre-fix render — a plain styled div with no role attribute —
    // must be gone. If someone reverts the role, this line reappears verbatim.
    expect(LOGIN_SRC).not.toContain('<div className="alert alert-danger"')
  })
})
