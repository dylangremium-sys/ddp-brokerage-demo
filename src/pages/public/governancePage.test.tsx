// @vitest-environment jsdom
//
// Rendered, not regexed: this page's failure modes are visual — a heading that
// duplicates the shell's, an input §11 draws but the product cannot receive, a
// second filled primary. A source scan sees none of those.
import { readFileSync } from 'node:fs'
import { render, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import GovernancePage from './GovernancePage'
import { STATUS_STATES } from '../../lib/statusVocabulary'
import { T } from '../../translations'
import { PUBLIC_CORPORATE_PAGES } from '../../lib/navigationGuard'
import { pathForPage } from '../../lib/urlRouting'
import { metadataForPage, indexablePages } from '../../lib/publicPageMetadata'

/**
 * Governance — handoff §11.
 *
 * The registration tests matter more than they look. A public page has to be
 * declared in seven places, and missing one fails quietly in a way that reads
 * as success: the link renders, the click does nothing, the sitemap advertises
 * a URL that serves the landing page. That is the failure mode the nav rename
 * was sequenced last to avoid, so it is asserted rather than trusted.
 */
describe('the Governance page', () => {
  const renderPage = (lang: 'en' | 'th' = 'en') =>
    render(<GovernancePage lang={lang} setLang={vi.fn()} onNavigate={vi.fn()} />)

  it('renders all four states from the shared vocabulary, not retyped strings', () => {
    const { container } = renderPage()
    const q = within(container)
    for (const state of STATUS_STATES) {
      expect(q.getByText(state.label.en)).toBeTruthy()
      expect(q.getByText(state.meaning.en)).toBeTruthy()
    }
  })

  it('types no status string of its own', () => {
    const text = readFileSync('src/pages/public/GovernancePage.tsx', 'utf8')
    for (const state of STATUS_STATES) {
      expect(text).not.toContain(`'${state.label.en}'`)
      expect(text).not.toContain(`>${state.label.en}<`)
    }
    expect(text).toContain('statusVocabulary')
  })

  it('carries exactly one h1 — the hero slot replaces the shell heading', () => {
    const { container } = renderPage()
    expect(container.querySelectorAll('h1')).toHaveLength(1)
    expect(within(container).getByRole('heading', { level: 1 }).textContent).toBe(T.en.govTitle)
  })

  /**
   * §11 draws an input beside this button. There is no dossier-request intake
   * to receive what someone types, and a field that accepts a value and drops
   * it on navigation is the defect this product keeps finding.
   */
  it('offers no input it cannot receive', () => {
    const { container } = renderPage()
    expect(container.querySelectorAll('input, textarea')).toHaveLength(0)
  })

  it('has exactly one filled primary, and it is the dossier request', () => {
    const { container } = renderPage()
    const primaries = container.querySelectorAll('.btn-primary')
    expect(primaries).toHaveLength(1)
    expect(primaries[0].textContent).toBe(T.en.govRequestCta)
  })

  it('renders in Thai when asked', () => {
    const { container } = renderPage('th')
    const q = within(container)
    expect(q.getByRole('heading', { level: 1 }).textContent).toBe(T.th.govTitle)
    expect(q.getByText(STATUS_STATES[0].meaning.th)).toBeTruthy()
  })
})

describe('the Governance route registration', () => {
  it('is reachable by a signed-out visitor', () => {
    expect(PUBLIC_CORPORATE_PAGES).toContain('governance')
  })

  it('resolves to its own path, not the root fallback', () => {
    expect(pathForPage('governance')).toBe('/governance')
  })

  it('is registered for indexing with a canonical that matches its route', () => {
    const meta = metadataForPage('governance')
    expect(meta.robots).toBe('index,follow')
    expect(meta.canonicalPath).toBe(pathForPage('governance'))
    expect(indexablePages()).toContain('governance')
  })
})
