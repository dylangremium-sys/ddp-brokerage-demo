import { describe, expect, it } from 'vitest'
import {
  MAX_REFERENCE_CONTEXT_CHARS,
  MAX_SOURCE_REFERENCES,
  MIN_QUOTED_REFERENCE_CHARS,
  verifySourceReferences,
  type SourceReferenceContext,
} from './aiSourceReferenceGuard'

// ─── AI source-reference verification tests ─────────────────────────────────
//
// The property under test is narrow and absolute: nothing reaches `verified`
// that cannot be shown to occur in the recorded evidence. Everything else —
// invented clause numbers, paraphrases, plausible-looking document names — is
// dropped and counted.

const CONTEXT: SourceReferenceContext = {
  sourceName: 'Thai FDA',
  sourceUrl: 'https://example.test/notice',
  itemTitle: 'Cultivation record-keeping notice',
  rawEvidence:
    'Licence holders must retain harvest batch records for five years. ' +
    'Section 12 of the Cannabis Act applies to all registered cultivators.',
}

describe('verifySourceReferences — grounds accepted', () => {
  it('keeps an exact source name, source URL, and item title', () => {
    const result = verifySourceReferences(
      ['Thai FDA', 'https://example.test/notice', 'Cultivation record-keeping notice'],
      CONTEXT,
    )
    expect(result.verified).toEqual([
      'Thai FDA',
      'https://example.test/notice',
      'Cultivation record-keeping notice',
    ])
    expect(result.droppedCount).toBe(0)
  })

  it('keeps a verbatim quotation, rendered as its enclosing sentence', () => {
    const result = verifySourceReferences(
      ['Section 12 of the Cannabis Act'],
      CONTEXT,
    )
    // Read back out of the evidence, not echoed from the model — see the
    // DISPLAY rule in the guard header.
    expect(result.verified).toEqual([
      'Section 12 of the Cannabis Act applies to all registered cultivators.',
    ])
    expect(result.droppedCount).toBe(0)
  })

  it('matches a quotation across differing case, whitespace, and surrounding quote marks', () => {
    const result = verifySourceReferences(
      ['  "section  12   OF the cannabis act"  ', '“retain harvest batch records”'],
      CONTEXT,
    )
    expect(result.verified).toHaveLength(2)
    expect(result.droppedCount).toBe(0)
    // Both render the recorded sentence, in the recorded casing.
    expect(result.verified[0]).toBe(
      'Section 12 of the Cannabis Act applies to all registered cultivators.',
    )
    expect(result.verified[1]).toBe(
      'Licence holders must retain harvest batch records for five years.',
    )
  })

  it('accepts a quotation that ends in a full stop or is wrapped in ellipses', () => {
    // Models routinely punctuate their quotations. Edge punctuation carries no
    // matching signal, and discarding a correct citation over it would teach
    // reviewers the reference list is unreliable.
    const stop = verifySourceReferences(['Section 12 of the Cannabis Act.'], CONTEXT)
    const ellipsis = verifySourceReferences(['... Section 12 of the Cannabis Act ...'], CONTEXT)
    expect(stop.droppedCount).toBe(0)
    expect(ellipsis.droppedCount).toBe(0)
    expect(stop.verified).toEqual(ellipsis.verified)
  })

  it('keeps a short reference when it exactly matches recorded metadata', () => {
    // 'Thai FDA' is below the quotation floor but is checked against a specific
    // recorded field, so the floor does not apply.
    expect('Thai FDA'.length).toBeLessThan(MIN_QUOTED_REFERENCE_CHARS)
    expect(verifySourceReferences(['Thai FDA'], CONTEXT).verified).toEqual(['Thai FDA'])
  })
})

describe('verifySourceReferences — ungrounded references dropped', () => {
  it('drops an invented clause that does not occur in the evidence', () => {
    const result = verifySourceReferences(
      ['Section 47(b) of the Narcotics Control Act 2565'],
      CONTEXT,
    )
    expect(result.verified).toEqual([])
    expect(result.droppedCount).toBe(1)
  })

  it('drops a paraphrase of text that IS in the evidence', () => {
    // The evidence says "retain harvest batch records for five years"; a
    // paraphrase is not a quotation and must not be presented as a citation.
    const result = verifySourceReferences(['records must be kept for 5 years'], CONTEXT)
    expect(result.verified).toEqual([])
    expect(result.droppedCount).toBe(1)
  })

  it('drops a short fragment that only matches by being ubiquitous', () => {
    // 'the' occurs in the evidence, but a substring match on it would launder a
    // guess into a citation — the length floor is what prevents that.
    const result = verifySourceReferences(['the', 'must', 'Act'], CONTEXT)
    expect(result.verified).toEqual([])
    expect(result.droppedCount).toBe(3)
  })

  it('drops a near-miss URL on a different host', () => {
    const result = verifySourceReferences(['https://evil.test/notice'], CONTEXT)
    expect(result.verified).toEqual([])
    expect(result.droppedCount).toBe(1)
  })

  it('drops empty and whitespace-only entries', () => {
    const result = verifySourceReferences(['', '   ', '\n\t'], CONTEXT)
    expect(result.verified).toEqual([])
    expect(result.droppedCount).toBe(3)
  })

  it('keeps the grounded entries and drops the rest from a mixed list', () => {
    const result = verifySourceReferences(
      ['Thai FDA', 'Ministerial Regulation No. 8', 'Section 12 of the Cannabis Act', 'Annex IV'],
      CONTEXT,
    )
    expect(result.verified).toEqual([
      'Thai FDA',
      'Section 12 of the Cannabis Act applies to all registered cultivators.',
    ])
    expect(result.droppedCount).toBe(2)
  })
})

// ─── Display rule: shown text is ours, never the model's ────────────────────
//
// Regression tests for two attacks the earlier echo-the-model implementation
// admitted. Both were confirmed live before this rule existed.

describe('verifySourceReferences — display text comes from the record', () => {
  it('restores a negation the model cut out of its span', () => {
    // "would not require certification" contains the verbatim span "require
    // certification of exports". Echoed back alone, it cites the source as
    // saying the opposite of what it says.
    const context = {
      ...CONTEXT,
      rawEvidence: 'The proposal would not require certification of exports.',
    }
    const result = verifySourceReferences(['require certification of exports'], context)

    expect(result.verified).toEqual(['The proposal would not require certification of exports.'])
    expect(result.verified[0]).toContain('not')
  })

  it('renders the recorded URL, not the model spelling of it', () => {
    // URL paths are case-sensitive, so /NOTICE need not be /notice. Matching is
    // lenient; what gets shown is the recorded value either way.
    const result = verifySourceReferences(['HTTPS://EXAMPLE.TEST/NOTICE'], CONTEXT)
    expect(result.verified).toEqual([CONTEXT.sourceUrl])
  })

  it('bounds a rendered sentence rather than pasting a wall of text', () => {
    const runOn = `Preamble ${'lorem ipsum dolor sit amet '.repeat(60)}quoted clause here`
    const result = verifySourceReferences(['quoted clause here'], { ...CONTEXT, rawEvidence: runOn })
    expect(result.verified).toHaveLength(1)
    expect(result.verified[0].length).toBeLessThanOrEqual(MAX_REFERENCE_CONTEXT_CHARS + 1)
  })

  it('collapses two fragments of one sentence into a single entry', () => {
    const result = verifySourceReferences(
      ['Section 12 of the Cannabis', 'the Cannabis Act applies to all'],
      CONTEXT,
    )
    expect(result.verified).toEqual([
      'Section 12 of the Cannabis Act applies to all registered cultivators.',
    ])
    expect(result.droppedCount).toBe(1)
  })
})

describe('verifySourceReferences — bounds', () => {
  it('de-duplicates references that normalise to the same text', () => {
    const result = verifySourceReferences(['Thai FDA', 'thai fda', '  Thai   FDA  '], CONTEXT)
    expect(result.verified).toEqual(['Thai FDA'])
    expect(result.droppedCount).toBe(2)
  })

  it('caps the list and counts the excess as dropped', () => {
    // Distinct grounded quotations: each clause is long enough to clear the
    // floor and appears verbatim in the evidence, so every one would pass on
    // its own and only the cap can exclude it.
    const clauses = Array.from(
      { length: MAX_SOURCE_REFERENCES + 5 },
      (_unused, i) => `clause number ${i} applies to cultivators`,
    )
    const result = verifySourceReferences(clauses, { ...CONTEXT, rawEvidence: clauses.join('. ') })
    expect(result.verified).toHaveLength(MAX_SOURCE_REFERENCES)
    expect(result.droppedCount).toBe(5)
  })

  it('returns an empty result for an empty list', () => {
    expect(verifySourceReferences([], CONTEXT)).toEqual({ verified: [], droppedCount: 0 })
  })

  it('drops a non-string entry without throwing', () => {
    const hostile = ['Thai FDA', 42, null] as unknown as string[]
    const result = verifySourceReferences(hostile, CONTEXT)
    expect(result.verified).toEqual(['Thai FDA'])
    expect(result.droppedCount).toBe(2)
  })

  it('is idempotent — re-verifying its own output changes nothing', () => {
    // The orchestration runs at two layers (server endpoint, then browser
    // controller over the server's already-filtered list). The second pass must
    // not drop anything the first kept.
    const first = verifySourceReferences(
      ['Thai FDA', 'Invented Regulation 9', 'Section 12 of the Cannabis Act'],
      CONTEXT,
    )
    const second = verifySourceReferences(first.verified, CONTEXT)
    expect(second.verified).toEqual(first.verified)
    expect(second.droppedCount).toBe(0)
  })
})
