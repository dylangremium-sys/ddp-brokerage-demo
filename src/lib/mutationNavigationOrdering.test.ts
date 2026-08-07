import { describe, expect, it } from 'vitest'
import { commitMutation } from './mutationCommit'

/**
 * F5 — the handler the merged `remediation/p0-mutations` branch did not close.
 *
 * a92f892 made handleInventorySubmit DB-first internally, but the handler still
 * resolved identically whether the insert landed or was rejected, and its sole
 * caller (the farmer-stock-form onSubmit) navigated on the bare `await`:
 *
 *     await handleInventorySubmit(item, coaFile)
 *     if (item.stockStatus !== 'draft') goTo('farmer-my-stock')
 *
 * So a submission refused by RLS still sent the farmer to My Stock — a list
 * that does not contain the batch they just filed. The audit named this at
 * App.tsx:939-942. The handler now returns whether the batch was committed and
 * the caller gates navigation on it.
 *
 * This repo's vitest environment is 'node' with no jsdom, and .tsx is never
 * rendered under test, so the wiring is asserted against source text via
 * `import.meta.glob(..., '?raw')` — the existing convention here (see
 * operationsDeskRouting.test.ts, db.persist.test.ts).
 */
function raw(glob: Record<string, string>): string {
  return Object.values(glob)[0] ?? ''
}

const APP_SRC = raw(import.meta.glob('../App.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)

/** Extract a `function name(...)` body by brace matching, for scoped assertions. */
function fnBody(src: string, signature: string): string {
  const start = src.indexOf(signature)
  if (start === -1) return ''
  let depth = 0
  let seenOpen = false
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') { depth++; seenOpen = true }
    else if (src[i] === '}') {
      depth--
      if (seenOpen && depth === 0) return src.slice(start, i + 1)
    }
  }
  return src.slice(start)
}

/**
 * The <FarmerSubmitInventory onSubmit={…}> lambda, sliced from App.tsx.
 *
 * Anchored on `onSubmit={async (` rather than on the full parameter list: the
 * previous version anchored on the literal `onSubmit={async (item, coaFile)`,
 * which meant fixing the parameter list made every assertion here slice an
 * empty string and pass vacuously. A locator that only finds the broken form of
 * the code cannot guard the fixed form.
 */
function farmerStockFormCaller(): string {
  const start = APP_SRC.indexOf('onSubmit={async (')
  const end = APP_SRC.indexOf("onBack={() => goTo('farmer-my-stock')}")
  if (start === -1 || end === -1 || end < start) return ''
  return APP_SRC.slice(start, end)
}

describe('F5 — source fixture is readable', () => {
  it('loads App.tsx', () => {
    expect(APP_SRC.length).toBeGreaterThan(1000)
  })
})

describe('F5 — no handler navigates after a failed write', () => {
  it('leaves no fire-and-forget `.catch(onDbError)` write anywhere in App.tsx', () => {
    // The signature of the defect: the write's outcome discarded into a catch
    // while state and navigation had already been applied.
    expect(APP_SRC).not.toContain('.catch(onDbError)')
  })

  it('handleInventorySubmit reports whether the batch was committed', () => {
    const body = fnBody(APP_SRC, 'async function handleInventorySubmit(')
    expect(body).not.toBe('')
    // A Promise<void> tells the caller nothing — that was the gap.
    expect(body).toMatch(/handleInventorySubmit\([^)]*\)\s*:\s*Promise<boolean>/s)
    // Rejected insert ⇒ false, and the COA step is never reached.
    expect(body).toContain('if (!created) return false')
  })

  it('the farmer-stock-form caller navigates only on a committed submission', () => {
    const caller = farmerStockFormCaller()
    expect(caller).not.toBe('')
    // The bare `await` followed by an unconditional goTo is the defect.
    expect(caller).not.toMatch(/await handleInventorySubmit\([^)]*\)\s*\n\s*if \(item\.stockStatus/)
    expect(caller).toMatch(/const committed = await handleInventorySubmit\(/)
    expect(caller).toMatch(/if \(committed && item\.stockStatus !== 'draft'\) goTo\('farmer-my-stock'\)/)
  })

  // ── The dropped-argument guard ────────────────────────────────────────────
  //
  // This lambda took (item, coaFile) while FarmerSubmitInventory called it with
  // (item, coaFile, photoFiles). The third argument was discarded silently, so
  // handleInventorySubmit's photo block — guarded by `if (photoFiles?.length …)`
  // — could never run. Production measured farmer_photos n_tup_ins = 0: not one
  // insert ever ATTEMPTED, against an upload path that was built and correct.
  //
  // NOTHING ELSE CATCHES THIS. TypeScript will not: a function of fewer
  // parameters is assignable to a type of more, deliberately, because dropping
  // trailing arguments is normally safe. Here it is the whole defect. The
  // callback also cannot be type-annotated into safety — the assignability rule
  // is what makes React event and prop callbacks ergonomic everywhere else.
  //
  // So the guard is textual, and it asserts FORWARDING rather than a fixed
  // spelling: any parameter the props type declares must reach the handler.
  it('the farmer-stock-form caller forwards every argument it is given', () => {
    const caller = farmerStockFormCaller()
    const params = /onSubmit=\{async \(([^)]*)\)/.exec(caller)?.[1] ?? ''
    const declared = params.split(',').map(p => p.trim()).filter(Boolean)

    // The props type is the contract; the lambda must accept all of it.
    expect(declared).toEqual(['item', 'coaFile', 'photoFiles'])

    const forwarded = /handleInventorySubmit\(([^)]*)\)/.exec(caller)?.[1] ?? ''
    const passed = forwarded.split(',').map(a => a.trim()).filter(Boolean)

    // …and pass all of it on. Accepting photoFiles and then not forwarding it
    // is the same defect wearing a longer signature.
    expect(passed).toEqual(declared)
  })

  it('every audited handler routes its write through commitMutation', () => {
    for (const handler of [
      'handleSendReviewRequest',
      'handleResolveRequest',
      'handleMarkClientVisible',
      'handleSaveOwnerNote',
      'handleFarmSubmit',
      'handleFarmAction',
      'handleInventoryAction',
      'handleInventorySubmit',
    ]) {
      const body = fnBody(APP_SRC, `async function ${handler}(`)
      expect(body, `${handler} is not an async handler`).not.toBe('')
      expect(body, `${handler} does not await a commitMutation`).toContain('await commitMutation(')
    }
  })

  it('handleFarmSubmit and handleFarmAction navigate inside onCommitted, not after it', () => {
    for (const [handler, destination] of [
      ['handleFarmSubmit', "goTo('farmer-status')"],
      ['handleFarmAction', "goTo('ddp-farms')"],
      ['handleInventoryAction', "goTo('ddp-inventory')"],
    ] as const) {
      const body = fnBody(APP_SRC, `async function ${handler}(`)
      const committedAt = body.indexOf('onCommitted:')
      const errorAt = body.indexOf('onError:', committedAt)
      const navAt = body.lastIndexOf(destination)
      expect(committedAt, `${handler} has no onCommitted`).toBeGreaterThan(-1)
      // The navigation sits between onCommitted and onError ⇒ inside the
      // success branch. handleFarmAction/handleInventoryAction also navigate on
      // the unrecognised-action early return, which persists nothing; that call
      // is before onCommitted, hence lastIndexOf.
      expect(navAt, `${handler} navigates outside onCommitted`).toBeGreaterThan(committedAt)
      expect(navAt, `${handler} navigates outside onCommitted`).toBeLessThan(errorAt)
    }
  })
})

describe('F5 — commitMutation ordering contract holds under failure', () => {
  it('does not run the visible consequences when the write is rejected', async () => {
    const applied: string[] = []
    const ok = await commitMutation(
      () => Promise.reject(new Error('new row violates row-level security policy')),
      {
        onCommitted: () => { applied.push('state+navigation') },
        onError: () => { applied.push('error') },
      },
    )
    expect(ok).toBe(false)
    expect(applied).toEqual(['error'])
  })

  it('runs the visible consequences only after the write settles', async () => {
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const running = commitMutation(
      async () => { await gate; order.push('write') },
      { onCommitted: () => { order.push('navigate') }, onError: () => { order.push('error') } },
    )
    expect(order).toEqual([])   // nothing visible has happened yet
    release()
    await expect(running).resolves.toBe(true)
    expect(order).toEqual(['write', 'navigate'])
  })
})
