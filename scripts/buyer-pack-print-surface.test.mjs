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

// Comments are stripped before every structural assertion. Without this, a rule
// merely *described* in a comment would satisfy a test that no CSS satisfies —
// these files are heavily commented, so that is a live risk, not a theoretical
// one. (The same guard the SQL migration tests in this directory apply.)
const stripCssComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, ' ')
const stripJsxComments = (tsx) => tsx.replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')

const CSS = stripCssComments(read('src/App.css'))
const TSX = stripJsxComments(read('src/pages/admin/DDPBuyerPreview.tsx'))
const PRINT = CSS.slice(CSS.indexOf('@media print'))

// The ratified ink values. Charcoal #1E2A24 is 14.87:1 on white; #46524B is
// 8.17:1. The app's own --text is #EDF1F5, which prints at 1.14:1.
const INK = '#1E2A24'
const INK_SECONDARY = '#46524B'

// The interactive hidden-set rule, matched explicitly. An index-based slice
// would now stop at the fail-closed dossier rule (which also uses display:none)
// and inspect the wrong region — passing without proving anything.
const HIDDEN_RULE = PRINT.match(/\.no-print,[\s\S]*?\{\s*display:\s*none\s*!important;\s*\}/)?.[0] ?? ''

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

// The exact notice, as written. Pinned so a "tidy-up" cannot soften, shorten or
// re-word a distribution warning without this failing. Normalised for JSX line
// wrapping only — every word is the source's own.
const EXEC_SUMMARY_NOTICE =
  'INTERNAL — Executive summary not yet completed. Decision Required: this pack must not be issued to a buyer ' +
  'until DDP staff complete this section (farm standing, batch readiness, open risks, recommended decision).'

describe('Executive Summary notice — prints, intact and readable', () => {
  const noticeBlock = TSX.match(/<div className="detail-block buyer-pack-notice">[\s\S]*?<\/div>\s*\n\s*\n/)?.[0] ?? ''

  it('is not excluded from print', () => {
    // The whole point: a warning forbidding issuance must reach the artifact
    // that gets issued.
    expect(noticeBlock.length).toBeGreaterThan(0)
    expect(noticeBlock).not.toMatch(/no-print/)
    // And the interactive hidden-set may not hide it.
    expect(HIDDEN_RULE.length).toBeGreaterThan(0)
    expect(HIDDEN_RULE).not.toMatch(/buyer-pack-notice/)
  })

  it('retains the warning text exactly as written', () => {
    // One constant, rendered in the pack and again on the refusal page. Pinning
    // the constant pins both.
    const constant = read('src/pages/admin/DDPBuyerPreview.tsx')
      .match(/const EXECUTIVE_SUMMARY_NOTICE =\s*([\s\S]*?)\n\n/)?.[1] ?? ''
    const literal = constant.replace(/'\s*\+\s*'/g, '').replace(/'/g, '').replace(/\s+/g, ' ').trim()
    expect(literal).toBe(EXEC_SUMMARY_NOTICE)
    expect(noticeBlock).toContain('{EXECUTIVE_SUMMARY_NOTICE}')
  })

  it('still names the section it belongs to', () => {
    expect(noticeBlock).toContain('Executive Summary (Internal Draft)')
  })

  it('has explicit readable print ink that overrides the inline --warning colour', () => {
    // The notice carries an inline color: var(--warning) — #B8782E, 3.64:1 on
    // white (below AA). Inline styles beat stylesheet rules without !important, so the
    // override must be explicit or the warning prints as the faintest text.
    const rule = PRINT.match(/\.buyer-pack-notice \.detail-block-title,\s*\.buyer-pack-notice p\s*\{[^}]*\}/)?.[0] ?? ''
    expect(rule).toMatch(new RegExp(`color:\\s*${INK}\\s*!important`, 'i'))
  })

  it('is visually distinct without depending on a printed background', () => {
    const rule = PRINT.match(/\.buyer-pack-notice\s*\{[^}]*\}/)?.[0] ?? ''
    expect(rule).toMatch(/border-left:\s*3px solid/i)
    expect(rule).not.toMatch(/background/i)
    expect(rule).toMatch(/break-inside:\s*avoid/i)
  })

  it('adds no screen-scoped rules, so the on-screen layout is unchanged', () => {
    // Every .buyer-pack-notice rule must live inside @media print.
    const screenCss = CSS.slice(0, CSS.indexOf('@media print'))
    expect(screenCss).not.toMatch(/\.buyer-pack-notice/)
  })
})

describe('print surface — nothing evidential is hidden', () => {
  it('excludes only interactive controls', () => {
    expect(HIDDEN_RULE.length).toBeGreaterThan(0)
    for (const forbidden of [/disclaimer/i, /provenance/i, /buyer-pack-grid/i, /inv-table/i, /buyer-pack-notice/i, /buyer-pack-refusal/i]) {
      expect(HIDDEN_RULE).not.toMatch(forbidden)
    }
  })

  it('still excludes the interactive controls it always did', () => {
    // Loosening .no-print globally would make buttons and selects print.
    expect(HIDDEN_RULE).toMatch(/\.no-print/)
    expect(HIDDEN_RULE).toMatch(/\.buyer-pack-actions/)
    expect(HIDDEN_RULE).toMatch(/display:\s*none\s*!important/)
    // The action bar and the issue/decision blocks stay marked no-print in JSX.
    expect(TSX).toMatch(/className="buyer-pack-actions no-print"/)
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

// ── The media-level gate ────────────────────────────────────────────────────
// These assertions are structural because the cascade they describe cannot be
// executed in any JS test environment — jsdom does not implement @media print
// matching. The behavioural inputs are covered in src/lib/buyerPackPrintState.test.ts
// and the cascade itself is verified in a real browser (see the PR body).

describe('print media gate — fails closed', () => {
  it('hides the dossier by default in print', () => {
    // The default must be refusal. If the dossier printed by default, a removed
    // or misspelled attribute would silently disclose an unapproved pack.
    expect(PRINT).toMatch(/\.buyer-pack-card\s*\{\s*display:\s*none\s*!important;\s*\}/)
  })

  it('shows the dossier only on an exact authorized ancestor', () => {
    expect(PRINT).toMatch(/\[data-print-authorized="true"\]\s+\.buyer-pack-card\s*\{\s*display:\s*block\s*!important;\s*\}/)
  })

  it('prints the refusal page by default and suppresses it only when authorized', () => {
    expect(PRINT).toMatch(/\.buyer-pack-refusal\s*\{\s*display:\s*block\s*!important;\s*\}/)
    expect(PRINT).toMatch(/\[data-print-authorized="true"\]\s+\.buyer-pack-refusal\s*\{\s*display:\s*none\s*!important;\s*\}/)
  })

  it('wins on specificity, so the opt-in cannot be defeated by source order', () => {
    // (0,2,0) attribute+class beats (0,1,0) class. Both carry !important, so the
    // cascade is decided here and not by which rule comes last.
    const deny = PRINT.indexOf('.buyer-pack-card { display: none !important; }')
    const allow = PRINT.indexOf('[data-print-authorized="true"] .buyer-pack-card { display: block !important; }')
    expect(deny).toBeGreaterThan(-1)
    expect(allow).toBeGreaterThan(-1)
    expect(allow).toBeGreaterThan(deny)
  })

  it('keeps the refusal page off screen', () => {
    const screenCss = CSS.slice(0, CSS.indexOf('@media print'))
    expect(screenCss).toMatch(/\.buyer-pack-refusal\s*\{\s*display:\s*none;\s*\}/)
  })

  it('marks the root with the authorization attribute from the shared state', () => {
    expect(TSX).toMatch(/\[PRINT_AUTHORIZED_ATTR\]:\s*printState\.attr/)
  })
})

describe('unauthorized print output — a refusal, not a dossier', () => {
  const refusal = TSX.match(/<div className="buyer-pack-refusal">[\s\S]*?<\/div>\n\n/)?.[0] ?? ''

  it('was found in source', () => {
    expect(refusal.length).toBeGreaterThan(0)
  })

  it('states the established refusal reason', () => {
    expect(refusal).toMatch(/printState\.refusalReason/)
  })

  it('carries the established status label, not invented wording', () => {
    expect(refusal).toMatch(/\{packStatusLabel\}/)
  })

  it('preserves pack identity so the sheet is traceable', () => {
    expect(refusal).toMatch(/Pack identifier/)
    expect(refusal).toMatch(/\{item\.id\}/)
  })

  it('preserves the Executive Summary warning', () => {
    expect(refusal).toMatch(/EXECUTIVE_SUMMARY_NOTICE/)
  })

  it('never presents a blank print time as provenance', () => {
    expect(refusal).toMatch(/printedAt \?\? 'Unknown'/)
  })

  it('emits no evidence tables — they live inside the suppressed card', () => {
    for (const forbidden of [/inv-table/, /CHECKLIST/, /coa/i, /risk/i, /thcPct/]) {
      expect(refusal).not.toMatch(forbidden)
    }
  })

  it('has explicit print ink and a durable rule, not a background fill', () => {
    const rule = PRINT.match(/\.buyer-pack-refusal\s*\{[^}]*border[^}]*\}/)?.[0] ?? ''
    expect(rule).toMatch(/border:\s*2px solid #1E2A24/i)
    expect(rule).not.toMatch(/background/i)
    expect(PRINT).toMatch(/\.buyer-pack-refusal-reason[\s\S]*?color:\s*#1E2A24/i)
  })
})

describe('provenance — beforeprint covers native printing', () => {
  it('installs the listener via the shared helper and disposes it', () => {
    const eff = TSX.match(/useEffect\(\(\) => \{\s*return installPrintTimestampListener[\s\S]*?\}, \[\]\)/)?.[0] ?? ''
    expect(eff.length).toBeGreaterThan(0)
    // Returning the disposer is the cleanup.
    expect(eff).toMatch(/return installPrintTimestampListener\(window/)
  })

  it('stamps synchronously, so the print snapshot sees the new time', () => {
    expect(TSX).toMatch(/installPrintTimestampListener\(window,[\s\S]*?flushSync\(\(\) => setPrintedAt/)
  })

  it('no longer stamps only inside the click handler', () => {
    const fn = TSX.match(/function handlePrint\(\)\s*\{[\s\S]*?\n  \}/)?.[0] ?? ''
    expect(fn).not.toMatch(/setPrintedAt/)
  })

  it('never renders a blank timestamp in the pack provenance', () => {
    expect(TSX).toMatch(/<dd>\{printedAt \?\? 'Unknown'\}<\/dd>/)
  })
})

describe('button parity — disabled derives from shared eligibility', () => {
  const btn = TSX.match(/<button\s*\n\s*type="button"\s*\n\s*className="btn btn-primary"\s*\n\s*onClick=\{handlePrint\}[\s\S]*?>/)?.[0] ?? ''

  it('was found in source', () => {
    expect(btn.length).toBeGreaterThan(0)
  })

  it('uses the shared print state, not isHumanApproved alone', () => {
    expect(btn).toMatch(/disabled=\{!printState\.authorized\}/)
    expect(btn).not.toMatch(/isHumanApproved/)
  })

  it('explains itself with the established refusal reason', () => {
    expect(btn).toMatch(/title=\{printState\.refusalReason \?\? undefined\}/)
  })
})

describe('error lifecycle — no stale refusal', () => {
  it('scopes a stored refusal to the eligibility state that produced it', () => {
    expect(TSX).toMatch(/setPrintError\(\{ eligibilityKey, reason: printState\.refusalReason \}\)/)
  })

  it('renders the refusal only while its key still matches', () => {
    expect(TSX).toMatch(/const activePrintError = printError\?\.eligibilityKey === eligibilityKey \? printError\.reason : null/)
    expect(TSX).toMatch(/\{activePrintError && \(/)
  })
})

describe('print gate — wiring', () => {
  const handlePrint = TSX.match(/function handlePrint\(\)\s*\{[\s\S]*?\n  \}/)?.[0] ?? ''

  it('was found in source', () => {
    expect(handlePrint.length).toBeGreaterThan(0)
  })

  it('consults the shared print state BEFORE calling window.print()', () => {
    expect(handlePrint).toContain('printState.authorized')
    expect(handlePrint.indexOf('printState.authorized'))
      .toBeLessThan(handlePrint.indexOf('window.print()'))
  })

  it('returns early when the gate refuses', () => {
    expect(handlePrint).toMatch(/if\s*\(!printState\.authorized\)\s*\{[\s\S]*?return/)
  })

  it('does not silently swallow a refused print', () => {
    expect(handlePrint).toContain('setPrintError({ eligibilityKey, reason: printState.refusalReason })')
  })

  it('does not reimplement the gate with a print-only condition', () => {
    // A weaker lookalike (e.g. checking isHumanApproved alone) would drop the
    // approver-identity prerequisite that issuance enforces.
    expect(handlePrint).not.toMatch(/if\s*\(\s*!?isHumanApproved\s*\)/)
  })
})
