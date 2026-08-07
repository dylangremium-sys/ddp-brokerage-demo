import { describe, it, expect } from 'vitest'
import { FIELD_STEPS } from './farmProfileValidation'

/**
 * FIELD_STEPS is hand-written, and a hand-written map drifts. If a field moves
 * to another step of the wizard, a validation error would send the farmer to
 * the wrong page of a nine-step form to fix something that is not there — worse
 * than naming no step at all.
 *
 * So the map is checked against the component itself: this re-derives where
 * each field is actually rendered and asserts the two agree. The wizard renders
 * its steps as `{step === N && …}` blocks and every input calls `set('field')`,
 * which is enough to locate each field without a DOM.
 *
 * Source text is read via import.meta.glob('?raw'), the existing convention in
 * this repository for asserting against a .tsx file from a `node` test.
 */

const ONBOARDING_SRC = Object.values(
  import.meta.glob('../pages/farmer/FarmerOnboarding.tsx', {
    query: '?raw', import: 'default', eager: true,
  }) as Record<string, string>,
)[0] ?? ''

/** field -> the step whose block contains its `set(...)` call. */
function renderedFieldSteps(src: string): Record<string, number> {
  const starts = [...src.matchAll(/\{step === (\d) &&/gu)]
    .map((m) => ({ step: Number(m[1]), at: m.index ?? 0 }))
  const bounds = [...starts, { step: -1, at: src.length }]
  const found: Record<string, number> = {}
  for (let i = 0; i < starts.length; i++) {
    const block = src.slice(bounds[i].at, bounds[i + 1].at)
    for (const m of block.matchAll(/set\('(\w+)'/gu)) {
      const field = m[1]
      if (found[field] === undefined) found[field] = starts[i].step
    }
  }
  return found
}

describe('FIELD_STEPS matches where the wizard actually renders each field', () => {
  const rendered = renderedFieldSteps(ONBOARDING_SRC)

  it('can read the component at all', () => {
    // Guards the whole file: if the glob returned nothing, every assertion
    // below would vacuously pass against an empty string.
    expect(ONBOARDING_SRC.length).toBeGreaterThan(1000)
    expect(Object.keys(rendered).length).toBeGreaterThan(10)
  })

  it.each(Object.keys(FIELD_STEPS))('%s is on the step the map claims', (field) => {
    expect(rendered[field], `${field} is not rendered by the wizard at all`).toBeDefined()
    expect(rendered[field]).toBe(FIELD_STEPS[field])
  })

  it('never validates a field the farmer cannot see', () => {
    const invisible = Object.keys(FIELD_STEPS).filter((f) => rendered[f] === undefined)
    expect(invisible, 'validated but never rendered').toEqual([])
  })
})
