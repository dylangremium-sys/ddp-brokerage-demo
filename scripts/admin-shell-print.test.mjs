import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * Print rules for the buyer-facing document.
 *
 * A signed-in admin renders the Buyer Pack Preview inside the editorial shell,
 * so "Print / Save PDF" was printing the sidebar, the utility header (carrying
 * the admin's identity and sign-out) and the shell's 248px column into a
 * buyer-facing document.
 *
 * These assert the stylesheet itself — the rules are what the browser applies,
 * and the src test environment has no DOM to observe them through. This lives in
 * scripts/ (alongside the other node-API regression test) because it reads the
 * file from disk: vitest stubs CSS imports, and src/ is typechecked by a config
 * that deliberately excludes node types.
 */

const CSS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'App.css'),
  'utf8',
)

/** Every `@media print { … }` block body, in source order. */
function printBlocks(css) {
  const blocks = []
  const re = /@media print\s*\{/g
  for (let m = re.exec(css); m !== null; m = re.exec(css)) {
    let depth = 1
    let i = re.lastIndex
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth++
      else if (css[i] === '}') depth--
      i++
    }
    blocks.push(css.slice(re.lastIndex, i - 1))
  }
  return blocks
}

const BLOCKS = printBlocks(CSS)
const PRINT_CSS = BLOCKS.join('\n')
const SHELL_BLOCK = BLOCKS[BLOCKS.length - 1]

describe('print rules exist and are ordered so they win', () => {
  it('has at least one @media print block', () => {
    expect(BLOCKS.length).toBeGreaterThan(0)
  })

  it('the shell print rules are declared after the .eo-* base rules', () => {
    // Equal specificity: the later declaration wins. A print block placed above
    // `.eo-shell { display: grid }` would be silently overridden — the exact
    // trap that already caught the legacy content gutter.
    const shellBase = CSS.indexOf('.eo-shell {')
    const shellPrint = CSS.lastIndexOf('@media print')
    expect(shellBase).toBeGreaterThan(-1)
    expect(shellPrint).toBeGreaterThan(shellBase)
  })
})

describe('print hides the admin chrome', () => {
  it('hides the side navigation', () => {
    expect(PRINT_CSS).toMatch(/\.eo-nav[\s\S]{0,160}display:\s*none/)
  })

  it('hides the utility header — breadcrumb, admin identity and sign-out live there', () => {
    expect(PRINT_CSS).toMatch(/\.eo-header[\s\S]{0,160}display:\s*none/)
  })

  it('hides the skip link', () => {
    expect(PRINT_CSS).toMatch(/\.eo-skip[\s\S]{0,160}display:\s*none/)
  })

  it('still hides the chrome the original print block always hid', () => {
    for (const sel of ['.no-print', '.buyer-pack-actions', '.demo-utility-strip', '.user-badge']) {
      expect(PRINT_CSS).toContain(sel)
    }
  })
})

describe('print lets the document occupy the printable width', () => {
  it('does not hide .eo-shell — it is the ancestor of the routed pack', () => {
    // Hiding it would hide the buyer pack itself.
    expect(SHELL_BLOCK).not.toMatch(/\.eo-shell[^{]*\{[^}]*display:\s*none/)
  })

  it('releases the shell grid so the sidebar column does not survive', () => {
    expect(SHELL_BLOCK).toMatch(/\.eo-shell\s*\{[\s\S]*?display:\s*block/)
  })

  it('releases the main column flow', () => {
    expect(SHELL_BLOCK).toMatch(/\.eo-main\s*\{[\s\S]*?display:\s*block/)
  })

  it('removes the admin gutter and canvas tint from the printed page', () => {
    expect(SHELL_BLOCK).toMatch(/padding:\s*0\s*!important/)
    expect(SHELL_BLOCK).toMatch(/background:\s*#fff\s*!important/)
  })
})

describe('print rules do not leak', () => {
  it('every shell print rule is scoped to an .eo-* class', () => {
    // Strip comments first — their prose is not a selector.
    const selectors = SHELL_BLOCK.replace(/\/\*[\s\S]*?\*\//g, '')
      .split('}')
      .map(chunk => chunk.split('{')[0])
      .join(',')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
    expect(selectors.length).toBeGreaterThan(0)
    for (const sel of selectors) expect(sel.startsWith('.eo-')).toBe(true)
  })

  it('screen rendering is untouched — the shell is still a grid outside print', () => {
    const base = CSS.slice(CSS.indexOf('.eo-shell {'), CSS.indexOf('.eo-shell {') + 200)
    expect(base).toMatch(/display:\s*grid/)
    expect(base).toMatch(/grid-template-columns/)
  })

  it('public and farmer surfaces cannot be reached by these rules', () => {
    // .eo-* exists only inside AdminShell.
    for (const sel of ['.landing-shell', '.navbar', '.main-content']) {
      expect(SHELL_BLOCK).not.toContain(sel)
    }
  })
})
