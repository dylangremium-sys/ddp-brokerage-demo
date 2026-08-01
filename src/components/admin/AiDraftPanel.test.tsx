// @vitest-environment jsdom
//
// The first test in this repository that RENDERS anything.
//
// Until now the suite was `environment: 'node'` with no `.test.tsx` files at
// all, so no line of JSX was ever executed. The component tests that did exist
// read page source as raw TEXT and regex-matched it — which proves a string is
// present, not that a screen works. Two changes reached production through that
// gap having never run anywhere: the source-reference list key and an escaped
// apostrophe. Both were correct by luck, not by check.
//
// These assertions are about what a reviewer actually SEES, because the risk in
// this panel is not a crash — it is a draft being presented as something more
// settled than it is.

import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiDraftSummary } from '../../lib/complianceAiSummarisation'
import { AiDraftPanel } from './AiDraftPanel'

afterEach(cleanup)

function draft(overrides: Partial<AiDraftSummary> = {}): AiDraftSummary {
  return {
    legalUpdateId: 'lu-1',
    providerId: 'anthropic',
    modelId: 'claude-opus-5',
    generatedAt: '2026-08-01T13:32:01.852Z',
    label: 'AI-generated draft — requires human legal review',
    requiresHumanReview: true,
    approvesUpdate: false,
    createsRule: false,
    enforces: false,
    certifiesCompliance: false,
    draftSummary: 'The notice restates an existing labelling duty.',
    possibleSignificance: 'May affect export documentation.',
    uncertainties: 'The commencement date is not stated in the evidence.',
    reviewQuestions: ['Does this change the COA requirement?'],
    sourceReferences: [],
    droppedSourceReferences: 0,
    ...overrides,
  } as AiDraftSummary
}

describe('AiDraftPanel — what the reviewer actually sees', () => {
  it('renders one list item per source reference', () => {
    render(
      <AiDraftPanel
        draft={draft({
          sourceReferences: [
            'Thai FDA',
            'Ministerial Regulation No. 8 (2565), Annex IV',
            'Notification of the Ministry of Public Health, s.44',
          ],
        })}
        updateTitle="Thai labelling notice"
        busy={false}
        onDiscard={() => {}}
      />,
    )

    const heading = screen.getByText('Source references')
    const list = heading.nextElementSibling as HTMLElement
    expect(list.tagName).toBe('UL')
    const items = within(list).getAllByRole('listitem')
    expect(items).toHaveLength(3)
    expect(items.map(li => li.textContent)).toEqual([
      'Thai FDA',
      'Ministerial Regulation No. 8 (2565), Annex IV',
      'Notification of the Ministry of Public Health, s.44',
    ])
  })

  // The list is keyed by reference content, which is only safe because the
  // server deduplicates references before they reach the browser. If that ever
  // stops being true React drops the duplicate and the reviewer silently sees
  // fewer citations than the model produced — so assert the visible count.
  it('shows every reference even when two share a prefix', () => {
    render(
      <AiDraftPanel
        draft={draft({ sourceReferences: ['Annex IV, para 1', 'Annex IV, para 2'] })}
        updateTitle="x"
        busy={false}
        onDiscard={() => {}}
      />,
    )
    const list = screen.getByText('Source references').nextElementSibling as HTMLElement
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
  })

  it('says plainly when nothing could be matched, instead of showing an empty list', () => {
    render(
      <AiDraftPanel draft={draft({ sourceReferences: [] })} updateTitle="x" busy={false} onDiscard={() => {}} />,
    )
    expect(
      screen.getByText(/None\. No reference could be matched to the recorded source evidence\./),
    ).toBeTruthy()
  })

  it('renders the apostrophe as a character, not an HTML entity', () => {
    // Shipped as `&apos;` to satisfy a lint rule. If that ever regresses to a
    // raw entity in a text node the reviewer reads "the AI&apos;s wording".
    render(<AiDraftPanel draft={draft()} updateTitle="x" busy={false} onDiscard={() => {}} />)
    const caption = screen.getByText(/not the AI's wording of it/)
    expect(caption.textContent).toContain("the AI's wording")
    expect(caption.textContent).not.toContain('&apos;')
  })

  it('states the draft is transient and names the update it belongs to', () => {
    render(<AiDraftPanel draft={draft()} updateTitle="Thai labelling notice" busy={false} onDiscard={() => {}} />)
    expect(screen.getByText(/This draft is transient — it is not saved/)).toBeTruthy()
    expect(screen.getByText('Thai labelling notice')).toBeTruthy()
    expect(screen.getByText('AI-generated draft — requires human legal review')).toBeTruthy()
    expect(screen.getByText('Draft only')).toBeTruthy()
  })

  it('attributes the draft to the provider and model that produced it', () => {
    render(<AiDraftPanel draft={draft()} updateTitle="x" busy={false} onDiscard={() => {}} />)
    expect(
      screen.getByText(/Provider: anthropic · Model: claude-opus-5 · Generated: 2026-08-01T13:32:01\.852Z/),
    ).toBeTruthy()
  })

  it('reports discarded references only when some were discarded', () => {
    const { unmount } = render(
      <AiDraftPanel draft={draft({ droppedSourceReferences: 2 })} updateTitle="x" busy={false} onDiscard={() => {}} />,
    )
    expect(screen.getByText(/2 unmatched reference\(s\) were discarded from this draft\./)).toBeTruthy()
    unmount()

    render(<AiDraftPanel draft={draft({ droppedSourceReferences: 0 })} updateTitle="x" busy={false} onDiscard={() => {}} />)
    expect(screen.queryByText(/unmatched reference\(s\) were discarded/)).toBeNull()
  })

  it('never renders approval or certification wording', () => {
    render(
      <AiDraftPanel
        draft={draft({ sourceReferences: ['Thai FDA'], droppedSourceReferences: 1 })}
        updateTitle="x"
        busy={false}
        onDiscard={() => {}}
      />,
    )
    expect(document.body.textContent).not.toMatch(
      /AI-approved|legally confirmed|compliance verified|certified compliant|ready for enforcement/i,
    )
  })

  it('discards on click, and refuses to while a request is in flight', () => {
    const onDiscard = vi.fn()
    const { unmount } = render(
      <AiDraftPanel draft={draft()} updateTitle="x" busy={false} onDiscard={onDiscard} />,
    )
    const button = screen.getByRole('button', { name: 'Discard draft' }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    button.click()
    expect(onDiscard).toHaveBeenCalledTimes(1)
    unmount()

    render(<AiDraftPanel draft={draft()} updateTitle="x" busy={true} onDiscard={onDiscard} />)
    expect((screen.getByRole('button', { name: 'Discard draft' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
