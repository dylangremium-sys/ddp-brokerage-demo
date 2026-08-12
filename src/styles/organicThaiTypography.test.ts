import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guards three corrections in organicScoped.css that a browser proved were
 * needed and that nothing else in the suite can see.
 *
 * WHY THESE ARE ASSERTED AGAINST THE SOURCE TEXT. All three are cascade
 * defects: the declaration was present and correct somewhere, and lost a tie
 * to a sheet emitted later in the bundle. A rendering test cannot catch that —
 * jsdom does not resolve cross-stylesheet cascade, and the component renders
 * identically either way. What is actually at risk is someone "tidying" the
 * sheet back toward the handoff's original, which is a source-level edit, so
 * the guard is source-level too.
 *
 * The handoff says of the first two: "override them, and do not 'fix' the
 * override back". This is that instruction, executable.
 */

/**
 * Comments are stripped before anything is matched. The corrections below are
 * documented in prose that necessarily QUOTES the wrong value it replaced
 * ("do not restore `--font-heading`"), so matching the raw file makes every
 * assertion fail on its own explanation.
 */
const CSS = readFileSync(join(__dirname, 'organicScoped.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')

/** The `.btn` declaration block, without the comment that precedes it. */
function btnBlock(): string {
  const start = CSS.indexOf('\n.btn {')
  expect(start, '.btn rule not found — did the sheet get restructured?').toBeGreaterThan(-1)
  return CSS.slice(start, CSS.indexOf('}', start))
}

describe('handoff defect 1 — the display face does not belong on a control', () => {
  it('gives .btn the body font, not --font-heading', () => {
    const block = btnBlock()
    expect(block).toContain('--font-body')
    // Caprasimo ships weight 400 only and is a display face. farmerPortal.css
    // carries the same correction and was INERT: both land at (0,2,0) and this
    // sheet is emitted last, so restoring --font-heading here silently wins
    // and every button in the portal renders Caprasimo again.
    expect(block).not.toContain('--font-heading')
  })
})

describe('handoff defect 2 — a ghost button is all label, so it needs a text-grade accent', () => {
  it('gives .btn-ghost the deep ramp step', () => {
    const rule = CSS.match(/^\.btn-ghost \{[^}]*\}/m)?.[0] ?? ''
    expect(rule, '.btn-ghost rule not found').not.toBe('')
    // #c67139 on #f5ead8 measures 3.03:1 — under the 4.5:1 body-text floor.
    // #8c491a measures 5.72:1.
    expect(rule).toContain('--color-accent-700')
    expect(rule).not.toMatch(/color:\s*var\(--color-accent\)/)
  })
})

describe('Thai typography survives the Organic layer', () => {
  it('defines a Thai face, because Caprasimo and Figtree have no Thai glyphs', () => {
    expect(CSS).toContain('--font-thai')
    expect(CSS).toMatch(/--font-thai:\s*"Sarabun"/)
  })

  it('covers every element this sheet gives a Latin-only face or explicit tracking', () => {
    // App.css:5335 resets these product-wide but enumerates classes, and it
    // predates the Organic layer — so it lists none of these.
    for (const target of ['h1', '.btn', '.tag', '.card-kicker', 'th']) {
      expect(
        CSS.includes(`${target}:lang(th)`),
        `${target} carries explicit letter-spacing or a Latin-only face but has no :lang(th) guard`,
      ).toBe(true)
    }
  })

  it('puts :lang(th) on the target element, never on an ancestor', () => {
    // `.organic-scope :lang(th) .btn` needs an INTERMEDIATE element, so it
    // fails to match a direct child — and it fails OPEN, restoring the
    // tracking on the one screen the rule exists to protect. Thai has no word
    // spaces; letter-spacing pulls the marks apart.
    const descendantForm = CSS.match(/:lang\(th\)\s+[.\w[]/g)
    expect(
      descendantForm,
      `:lang(th) used as an ancestor: ${descendantForm?.join(', ')} — put it on the target instead`,
    ).toBeNull()
  })
})
