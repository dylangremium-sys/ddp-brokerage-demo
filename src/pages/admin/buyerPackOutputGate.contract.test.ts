import { describe, expect, it } from 'vitest'

// Source-contract for the Buyer Pack output gate. Vitest runs in `environment:
// 'node'` here (no jsdom / testing-library — see ErrorBoundary.test.ts), so the
// component cannot be rendered; the wiring is asserted against the .tsx source
// via `import.meta.glob` `?raw`, the repo's existing convention
// (watchtowerAiSummaryIntegration.test.ts). The print-CSS fail-closed behaviour
// (commercial card suppressed, NOT-APPROVED notice shown) is verified separately
// by browser print-media emulation, because vitest stubs CSS.
const SRC = Object.values(
  import.meta.glob('./DDPBuyerPreview.tsx', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>,
)[0] ?? ''

function fnBody(name: string): string {
  const start = SRC.indexOf(name)
  if (start === -1) return ''
  // functions here have no nested braces before their close, so the first `}`
  // after the signature is the function's own closing brace.
  return SRC.slice(start, SRC.indexOf('}', start) + 1)
}

describe('Buyer Pack output-gate wiring (source contract)', () => {
  it('has readable source', () => {
    expect(SRC.length).toBeGreaterThan(1000)
  })

  it('imports the shared gate and derives canEmitOutput from isHumanApproved (not inventory status)', () => {
    expect(SRC).toMatch(/from '\.\.\/\.\.\/lib\/buyerPackOutputGate'/)
    expect(SRC).toMatch(/const canEmitOutput = canEmitBuyerPackOutput\(isHumanApproved\)/)
  })

  it('gates handlePrint before window.print() and before any download record', () => {
    const body = fnBody('function handlePrint')
    expect(body).toMatch(/if \(!canEmitOutput\) return/)
    expect(body.indexOf('if (!canEmitOutput) return')).toBeLessThan(body.indexOf('window.print()'))
    expect(body.indexOf('if (!canEmitOutput) return')).toBeLessThan(body.indexOf("recordDownload('print-pdf')"))
  })

  it('gates handleCopy before the clipboard write', () => {
    const start = SRC.indexOf('async function handleCopy')
    const body = SRC.slice(start, SRC.indexOf('function handlePrint', start))
    expect(body).toMatch(/if \(!canEmitOutput\) return/)
    expect(body.indexOf('if (!canEmitOutput) return')).toBeLessThan(body.indexOf('clipboard.writeText'))
  })

  it('disables the Print and Copy buttons when output is not allowed', () => {
    const disabled = SRC.match(/disabled=\{!canEmitOutput\}/g) ?? []
    expect(disabled.length).toBeGreaterThanOrEqual(2)
  })

  it('flags the pack root blocked and renders a print-only NOT-APPROVED notice that is NOT inside .no-print', () => {
    expect(SRC).toMatch(/buyer-pack--output-blocked/)
    // the print-only notice element
    const idx = SRC.indexOf('className="buyer-pack-print-block"')
    expect(idx).toBeGreaterThan(-1)
    const openTag = SRC.slice(SRC.lastIndexOf('<', idx), SRC.indexOf('>', idx))
    expect(openTag).not.toMatch(/no-print/)
    expect(SRC).toMatch(/BUYER_PACK_OUTPUT_BLOCKED_TITLE/)
  })

  it('leaves the server-authoritative issue button gated as before', () => {
    expect(SRC).toMatch(/disabled=\{!isHumanApproved \|\| issuing\}/)
  })
})
