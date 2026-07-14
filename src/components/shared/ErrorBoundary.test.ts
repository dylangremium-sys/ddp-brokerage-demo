import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { ErrorBoundary } from './ErrorBoundary'

// Vitest runs in `environment: 'node'` here (vite.config.ts) — there is no jsdom
// and no testing-library in this repo, and adding them is out of scope for a P0
// observability fix. So the boundary is exercised through React's actual public
// contract instead: getDerivedStateFromError → state → render(). That is exactly
// what React itself calls when a child throws, so these assertions are about real
// behaviour, not a stand-in for it.

// The thrown error's payload. In a real crash this is precisely the kind of thing
// a message or component stack can carry, and none of it may reach the screen.
const SECRET = 'ddp_inventory=[{"batch":"B-001","farm":"Chiang Mai Organics"}]'
const CRASH = new Error(`Cannot read properties of undefined — ${SECRET}`)
CRASH.stack = `TypeError: ${SECRET}\n    at InventoryTable (/src/pages/admin/Inventory.tsx:214)`

interface El {
  type: unknown
  props?: Record<string, unknown>
}

function isElement(v: unknown): v is El {
  return typeof v === 'object' && v !== null && 'type' in v
}

/** Every string that would actually be shown to the user. */
function renderedText(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string' || typeof node === 'number') out.push(String(node))
  else if (Array.isArray(node)) node.forEach((n) => renderedText(n, out))
  else if (isElement(node)) renderedText(node.props?.children, out)
  return out
}

/** Every element in the tree, flattened. */
function elements(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) node.forEach((n) => elements(n, out))
  else if (isElement(node)) {
    out.push(node)
    elements(node.props?.children, out)
  }
  return out
}

function boundaryWith(children: ReactNode): ErrorBoundary {
  return new ErrorBoundary({ children })
}

let errorSpy: ReturnType<typeof vi.spyOn>
let reload: ReturnType<typeof vi.fn>
let storage: { clear: ReturnType<typeof vi.fn>; removeItem: ReturnType<typeof vi.fn>; setItem: ReturnType<typeof vi.fn> }

beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  reload = vi.fn()
  storage = { clear: vi.fn(), removeItem: vi.fn(), setItem: vi.fn() }
  vi.stubGlobal('window', { location: { reload } })
  vi.stubGlobal('localStorage', storage)
  vi.stubGlobal('sessionStorage', storage)
})
afterEach(() => {
  errorSpy.mockRestore()
  vi.unstubAllGlobals()
})

describe('normal rendering is untouched', () => {
  it('renders its children unchanged when nothing has thrown', () => {
    const children = createElement('div', null, 'THE REAL APP')
    const boundary = boundaryWith(children)

    // Identity, not a copy: the boundary is transparent in the happy path, so it
    // cannot interfere with routing, auth or app rendering.
    expect(boundary.render()).toBe(children)
    expect(errorSpy).not.toHaveBeenCalled()
  })
})

describe('a throwing child produces the fallback', () => {
  it('getDerivedStateFromError flips to the fallback and mints a reference', () => {
    const state = ErrorBoundary.getDerivedStateFromError()

    expect(state.hasError).toBe(true)
    expect(typeof state.reference).toBe('string')
    expect(state.reference!.length).toBeGreaterThan(15)
  })

  it('renders the calm fallback UI', () => {
    const boundary = boundaryWith(createElement('div', null, 'THE REAL APP'))
    boundary.state = ErrorBoundary.getDerivedStateFromError()

    const text = renderedText(boundary.render()).join(' ')
    expect(text).toContain('Something went wrong')
    expect(text).toContain('still')          // reassurance: still signed in
    expect(text).not.toContain('THE REAL APP') // the broken tree is not rendered
  })

  it('offers a reload control that actually reloads', () => {
    const boundary = boundaryWith(null)
    boundary.state = ErrorBoundary.getDerivedStateFromError()

    const button = elements(boundary.render()).find((el) => el.type === 'button')
    expect(button, 'a reload control must be present').toBeDefined()
    expect(renderedText(button).join(' ')).toMatch(/reload/i)

    ;(button!.props!.onClick as () => void)()
    expect(reload).toHaveBeenCalledTimes(1)
  })
})

describe('the raw error is never displayed', () => {
  it('nothing from the thrown error reaches the rendered output', () => {
    // React passes the error to getDerivedStateFromError. This boundary declares
    // NO parameter, so the error cannot enter state — call it WITH the error to
    // prove the value is discarded rather than merely unused.
    const withArg = ErrorBoundary.getDerivedStateFromError as unknown as (e: unknown) => {
      hasError: boolean
      reference: string | null
    }
    const boundary = boundaryWith(null)
    boundary.state = withArg(CRASH)

    const rendered = JSON.stringify(renderedText(boundary.render()))
    for (const leak of [SECRET, CRASH.message, CRASH.stack!, 'Inventory.tsx', 'Cannot read properties']) {
      expect(rendered, `fallback must not display: ${leak.slice(0, 40)}`).not.toContain(leak)
    }
  })
})

describe('the privacy-safe client event', () => {
  it('emits exactly one structured event, with the reference and a safe category', () => {
    const boundary = boundaryWith(null)
    boundary.state = ErrorBoundary.getDerivedStateFromError()
    boundary.componentDidCatch()

    expect(errorSpy).toHaveBeenCalledTimes(1)
    const log = JSON.parse(errorSpy.mock.calls[0][0] as string) as Record<string, unknown>
    expect(log.event).toBe('ui_crash')
    expect(log.category).toBe('render_error')
    expect(log.route).toBe('app_root')
    expect(log.requestId).toBe(boundary.state.reference)
  })

  it('the event carries no error text, no stack, no component stack, no stored value', () => {
    const boundary = boundaryWith(null)
    boundary.state = ErrorBoundary.getDerivedStateFromError()
    // Call it the way React does — with both arguments — to prove they are dropped.
    ;(boundary.componentDidCatch as unknown as (e: unknown, i: unknown) => void)(CRASH, {
      componentStack: `\n    at InventoryTable (/src/pages/admin/Inventory.tsx:214)`,
    })

    const raw = errorSpy.mock.calls.map((c: unknown[]) => c[0] as string).join('\n')
    for (const leak of [SECRET, CRASH.message, 'Inventory.tsx', 'ddp_inventory', 'Chiang Mai Organics']) {
      expect(raw, `log must not contain: ${leak.slice(0, 40)}`).not.toContain(leak)
    }
  })
})

describe('the boundary is not a security control and must not act like one', () => {
  it('does NOT clear browser storage and does NOT sign the user out', () => {
    const boundary = boundaryWith(null)
    boundary.state = ErrorBoundary.getDerivedStateFromError()
    boundary.componentDidCatch()
    const button = elements(boundary.render()).find((el) => el.type === 'button')
    ;(button!.props!.onClick as () => void)()

    // A render bug is not evidence of a compromised session. Wiping the operator's
    // state here would turn a recoverable glitch into lost work; sign-out clearing
    // belongs in services/auth.ts, where it already lives.
    expect(storage.clear).not.toHaveBeenCalled()
    expect(storage.removeItem).not.toHaveBeenCalled()
    expect(reload).toHaveBeenCalledTimes(1)
  })
})

// ─── Source sweep ───────────────────────────────────────────────────────────
const SRC = Object.values(
  import.meta.glob('./ErrorBoundary.tsx', { query: '?raw', import: 'default', eager: true }),
)[0] as string

describe('ErrorBoundary source', () => {
  it('loaded', () => {
    expect(SRC.length).toBeGreaterThan(200)
  })

  it('never touches storage, auth, or the error object', () => {
    expect(SRC).not.toMatch(/localStorage|sessionStorage/)
    expect(SRC).not.toMatch(/signOut|clearSensitiveDdpStorage|supabase/i)
    expect(SRC).not.toMatch(/\.stack\b|\.message\b|componentStack/)
  })
})
