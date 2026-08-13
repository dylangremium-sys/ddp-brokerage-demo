import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { STATUS_STATES, STATUS_VOCABULARY, statesPresentIn } from './statusVocabulary'

/**
 * THE STATUS VOCABULARY IS ONE CONSTANT, OR IT IS NOT SHARED.
 *
 * Standing rule 3 says the marketing site and the console use the same four
 * states. Before this constant existed they did not share anything: the console
 * typed "Needs a person" as a literal in two files, and the homepage shipped a
 * card scored with green/amber/amber/red traffic lights — a palette the system
 * does not contain, with red on "Buyer visibility: Restricted", which is the
 * product working correctly.
 *
 * The failure mode is not a wrong colour. It is someone retyping one of these
 * strings on a new screen, at which point the two surfaces drift and nobody
 * notices until an audit. These tests guard the seam rather than the pixels.
 */
describe('the status vocabulary', () => {
  it('is exactly four states', () => {
    expect(STATUS_STATES).toHaveLength(4)
    expect(STATUS_STATES.map(s => s.key)).toEqual([
      'cleared', 'needsPerson', 'watching', 'notApplicable',
    ])
  })

  it('pairs each state with the Organic tag class rule 3 fixes for it', () => {
    expect(STATUS_VOCABULARY.cleared.tagClass).toBe('tag tag-accent-2')
    expect(STATUS_VOCABULARY.needsPerson.tagClass).toBe('tag tag-accent')
    expect(STATUS_VOCABULARY.watching.tagClass).toBe('tag tag-neutral')
    expect(STATUS_VOCABULARY.notApplicable.tagClass).toBe('tag tag-outline')
  })

  it('gives every state a distinct label, modifier and colour in both languages', () => {
    const distinct = (xs: string[]) => new Set(xs).size === xs.length
    expect(distinct(STATUS_STATES.map(s => s.modifier))).toBe(true)
    expect(distinct(STATUS_STATES.map(s => s.label.en))).toBe(true)
    expect(distinct(STATUS_STATES.map(s => s.label.th))).toBe(true)
    for (const s of STATUS_STATES) {
      expect(s.label.th).not.toBe(s.label.en)
      expect(s.meaning.th).not.toBe(s.meaning.en)
    }
  })

  /**
   * The legend is derived so it cannot describe a colour that is not on screen,
   * and cannot omit one that is.
   */
  it('derives a legend in vocabulary order, whatever order the rows arrive in', () => {
    expect(statesPresentIn(['notApplicable', 'cleared']).map(s => s.key))
      .toEqual(['cleared', 'notApplicable'])
  })

  it('collapses repeats — three cleared rows are one legend line', () => {
    expect(statesPresentIn(['cleared', 'cleared', 'cleared']).map(s => s.key))
      .toEqual(['cleared'])
  })

  it('returns nothing for no rows, rather than the whole vocabulary', () => {
    expect(statesPresentIn([])).toEqual([])
  })
})

/**
 * Source-level guards. These read files rather than render, because what they
 * are protecting is a habit, not an output: the moment someone types one of
 * these four strings into a component, the constant has stopped being the
 * source of truth even though every screen still looks right.
 */
describe('the surfaces that show status', () => {
  const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8')

  it('do not retype a status string in the dossier card', () => {
    const src = read('components/public/BatchDossierCard.tsx')
    for (const state of STATUS_STATES) {
      expect(src).not.toContain(`'${state.label.en}'`)
      expect(src).not.toContain(`>${state.label.en}<`)
    }
    expect(src).toContain('statusVocabulary')
  })

  it('do not retype a status string in the two console screens', () => {
    for (const file of [
      'pages/admin/DDPOverviewOrganic.tsx',
      'pages/admin/DDPOperationsDeskOrganic.tsx',
    ]) {
      const src = read(file)
      expect(src).toContain('statusVocabulary')
      for (const state of STATUS_STATES) {
        expect(src).not.toContain(`"${state.label.en}"`)
        expect(src).not.toContain(`>${state.label.en}<`)
      }
    }
  })

  /**
   * The CSP carries no 'unsafe-inline' and the public routes are prerendered, so
   * a `style` attribute in that static HTML is refused and the element renders
   * unpainted — live, green, and invisible. Six styles shipped that way. The
   * legend dots take their colour from a modifier class for exactly this reason.
   */
  it('colour the legend dots with a class, never an inline style', () => {
    const src = read('components/public/BatchDossierCard.tsx')
    expect(src).not.toMatch(/style=\{\{/)
    for (const state of STATUS_STATES) {
      expect(read('styles/publicHome.css')).toContain(`.hp-dossier-dot.${state.modifier}`)
    }
  })
})
