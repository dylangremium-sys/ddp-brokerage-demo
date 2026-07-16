// Static regression guard for the Buyer Pack PRINT SURFACE (PR-2, second half).
//
// The print rules live in CSS and in JSX class placement; neither has a runtime
// seam a unit test can drive, and no visual-snapshot harness exists yet. These
// assertions therefore read the sources as text and lock in the properties that
// make the printed pack readable — matching the convention already used by the
// migration guards in this directory.
//
// They are deliberately written against behaviour-bearing declarations (an
// explicit ink colour exists; a width cap exists; break protection exists), not
// against formatting. The live proof is a real print preview, which is recorded
// as an outstanding gap in the PR body — a static guard cannot see pagination.
//
// Lives in scripts/ (.mjs) for node fs access, matching the other source guards.

import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

const root = new URL('..', import.meta.url)
const read = (f) => readFileSync(new URL(f, root), 'utf8')

const CSS = read('src/App.css')
const TSX = read('src/pages/admin/DDPBuyerPreview.tsx')
const PRINT = CSS.slice(CSS.indexOf('@media print'))

// The ratified ink values. Charcoal #1E2A24 is 14.87:1 on white; #46524B is
// 8.17:1. The app's own --text is #EDF1F5, which prints at 1.14:1.
const INK = '#1E2A24'
const INK_SECONDARY = '#46524B'

describe('print surface — readability cannot depend on the recipient print dialog', () => {
  it('sets an explicit foreground colour on body, not only a background', () => {
    // The original defect exactly: background was set, colour never was, so the
    // pack's near-white ink printed onto white paper at ~1.14:1.
    const body = PRINT.match(/body\s*\{[^}]*\}/)?.[0] ?? ''
    expect(body).toMatch(/background:\s*#fff/i)
    expect(body).toMatch(new RegExp(`color:\\s*${INK}`, 'i'))
  })

  it('gives pack values dark ink and labels readable secondary ink', () => {
    expect(PRINT).toMatch(new RegExp(`\\.buyer-pack-title[\\s\\S]*?${INK}`, 'i'))
    expect(PRINT).toMatch(new RegExp(`\\.buyer-pack-lbl[\\s\\S]*?${INK_SECONDARY}`, 'i'))
  })

  it('does not rely on print-color-adjust as the readability mechanism', () => {
    // It may supplement, but explicit foregrounds must carry the page.
    const explicit = PRINT.match(new RegExp(`color:\\s*(${INK}|${INK_SECONDARY})`, 'gi')) ?? []
    expect(explicit.length).toBeGreaterThan(4)
  })

  it('never leaves the pack relying on a printed background for legibility', () => {
    // Status chips are outlined + dark-inked rather than tinted, because element
    // backgrounds are suppressed by default when printing.
    const chip = PRINT.match(/\.status-pill,\s*\.badge\s*\{[^}]*\}/)?.[0] ?? ''
    expect(chip).toMatch(new RegExp(`color:\\s*${INK}`, 'i'))
    expect(chip).toMatch(/background:\s*transparent/i)
    expect(chip).toMatch(/border:\s*1px solid/i)
  })
})

describe('print surface — document geometry', () => {
  it('constrains the pack to the safe cross-format measure', () => {
    // A4 binds: 210mm = 793.7px at 96dpi; minus 2x18mm = 657.6px. Letter yields
    // 679.9px. 656px prints identically on both.
    expect(PRINT).toMatch(/\.buyer-pack-wrap[\s\S]*?max-width:\s*656px/i)
  })

  it('declares the page margin the measure was derived from', () => {
    expect(CSS).toMatch(/@page\s*\{[^}]*margin:\s*18mm/i)
  })

  it('protects page breaks and repeats table headers', () => {
    expect(PRINT).toMatch(/break-inside:\s*avoid/i)
    expect(PRINT).toMatch(/break-after:\s*avoid/i)
    expect(PRINT).toMatch(/display:\s*table-header-group/i)
  })

  it('makes table borders visible on paper', () => {
    expect(PRINT).toMatch(/\.inv-table th[\s\S]*?border-color/i)
  })
})

describe('print surface — nothing evidential is hidden', () => {
  it('excludes only interactive controls', () => {
    const hiddenRule = PRINT.slice(0, PRINT.indexOf('display: none !important'))
    for (const forbidden of [/disclaimer/i, /provenance/i, /buyer-pack-grid/i, /inv-table/i]) {
      expect(hiddenRule).not.toMatch(forbidden)
    }
  })

  it('reveals the printed provenance block', () => {
    expect(PRINT).toMatch(/\.print-only-block\s*\{\s*display:\s*block\s*!important/i)
    expect(CSS).toMatch(/\.print-only-block\s*\{\s*display:\s*none/i)
  })

  it('no longer hides the missing-document identities from the artifact', () => {
    // The count prints. Hiding the identities left the pack asserting "N Missing"
    // without saying what.
    expect(TSX).not.toMatch(/<ul className="no-print"/)
  })

  it('prints the approval identity, timestamp and pack id', () => {
    const block = TSX.match(/buyer-pack-provenance"[\s\S]*?<\/dl>/)?.[0] ?? ''
    expect(block).toMatch(/Pack identifier/)
    expect(block).toMatch(/Approval status/)
    expect(block).toMatch(/Human approver/)
    expect(block).toMatch(/Approval identifier/)
    expect(block).toMatch(/buyerPackApprovalId/)
    expect(block).toMatch(/Printed/)
  })
})

describe('print gate — wiring', () => {
  const handlePrint = TSX.match(/function handlePrint\(\)\s*\{[\s\S]*?\n  \}/)?.[0] ?? ''

  it('was found in source', () => {
    expect(handlePrint.length).toBeGreaterThan(0)
  })

  it('consults the shared release predicate BEFORE calling window.print()', () => {
    expect(handlePrint).toContain('deriveBuyerPackReleaseEligibility')
    expect(handlePrint.indexOf('deriveBuyerPackReleaseEligibility'))
      .toBeLessThan(handlePrint.indexOf('window.print()'))
  })

  it('returns early when the gate refuses', () => {
    expect(handlePrint).toMatch(/if\s*\(!gate\.eligible\)\s*\{[\s\S]*?return/)
  })

  it('does not silently swallow a refused print', () => {
    expect(handlePrint).toContain('setPrintError(gate.reason)')
  })

  it('does not reimplement the gate with a print-only condition', () => {
    // A weaker lookalike (e.g. checking isHumanApproved alone) would drop the
    // approver-identity prerequisite that issuance enforces.
    expect(handlePrint).not.toMatch(/if\s*\(\s*!?isHumanApproved\s*\)/)
  })
})
