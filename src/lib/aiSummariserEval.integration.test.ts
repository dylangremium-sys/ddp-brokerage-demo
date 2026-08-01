import { afterAll, describe, expect, it } from 'vitest'
import { checkFixture } from './aiEvalChecks'
import { EVAL_FIXTURES, type EvalFixture } from './aiEvalFixtures'
import { generateAiDraftSummary, type AiSummaryResult } from './complianceAiSummarisation'
import { createServerAiSummaryProvider, type ServerAiEffort } from './serverAiProvider'

// ─── AI draft summariser — evaluation harness ───────────────────────────────
//
// Runs the fixture corpus through the REAL provider and the REAL shipped
// pipeline: createServerAiSummaryProvider → generateAiDraftSummary, which means
// the Cannamonitor gate, the eligibility guard, the wording guard and the
// reference guard all run exactly as they do in production. Anything that
// bypassed them would measure a system nobody deploys.
//
// SKIPPED unless AI_EVAL_API_KEY is set, so `npm test` and CI never make a
// network call or spend a cent. Run it deliberately:
//
//   AI_EVAL_API_KEY=sk-ant-... npx vitest run src/lib/aiSummariserEval.integration.test.ts
//
// Optional: AI_EVAL_MODEL (default claude-opus-5), AI_EVAL_EFFORT (low|medium|
// high|xhigh|max, default low — matching the endpoint). Those two exist so the
// effort sweep is a matter of re-running this, not editing code.
//
// WHAT THIS MEASURES: guardrail health. Whether the reply parses, whether the
// citations trace to the evidence, whether the wording guard fires when it
// should and stays quiet when it should not, and whether an instruction buried
// in the feed changes any of those answers. It does NOT score summary quality:
// that needs a labelled corpus and an agreed rubric, neither of which exists
// here, and a number invented for it would look like evidence without being any.
//
// NOT MEASURED: token usage. The provider adapter deliberately discards the
// vendor response beyond the content it parses, so `usage` never reaches this
// layer. Latency is measured; cost is not. Surfacing tokens would mean widening
// the adapter's return shape, which is a production change and not one this
// harness should force.

const apiKey = process.env.AI_EVAL_API_KEY ?? ''
const model = process.env.AI_EVAL_MODEL ?? 'claude-opus-5'
const effort = (process.env.AI_EVAL_EFFORT ?? 'low') as ServerAiEffort
const ready = apiKey.length > 0

interface EvalOutcome {
  fixture: EvalFixture
  result: AiSummaryResult
  latencyMs: number
}

const outcomes: EvalOutcome[] = []

describe.skipIf(!ready)('AI draft summariser — evaluation corpus', () => {
  const provider = ready
    ? createServerAiSummaryProvider({ apiKey, model, effort, timeoutMs: 120_000 })
    : null

  for (const fixture of EVAL_FIXTURES) {
    it(
      `${fixture.id} — ${fixture.expectation}`,
      async () => {
        const startedAt = Date.now()
        const result = await generateAiDraftSummary(fixture.update, provider, {
          requestInProgress: false,
        })
        outcomes.push({ fixture, result, latencyMs: Date.now() - startedAt })

        // Scoring lives in checkFixture, which is unit-tested in
        // aiEvalChecks.test.ts against synthetic results. Without that, this
        // harness's judgement would only ever run when someone had a key, and
        // a scoring bug would read as a clean sweep.
        const failures = checkFixture(fixture, result)
        expect(failures, `${fixture.id} — ${fixture.rationale}`).toEqual([])
      },
      180_000,
    )
  }

  afterAll(() => {
    if (outcomes.length === 0) return

    const rows = outcomes.map(o => ({
      fixture: o.fixture.id,
      outcome: o.result.ok ? 'draft' : o.result.code,
      refs: o.result.ok ? o.result.draft.sourceReferences.length : 0,
      dropped: o.result.ok ? o.result.draft.droppedSourceReferences : 0,
      ms: o.latencyMs,
    }))

    const drafts = outcomes.filter(o => o.result.ok)
    const totalRefs = rows.reduce((n, r) => n + r.refs, 0)
    const totalDropped = rows.reduce((n, r) => n + r.dropped, 0)
    const returned = totalRefs + totalDropped

    // Printed rather than asserted: these are the numbers to diff across a
    // prompt, model or effort change. A threshold on them would be a guess.
    console.log(`\nAI eval — model=${model} effort=${effort}`)
    console.table(rows)
    console.log(
      [
        `drafts produced      ${drafts.length}/${outcomes.length}`,
        `citations kept       ${totalRefs}`,
        `citations discarded  ${totalDropped}` +
          (returned > 0 ? ` (${Math.round((totalDropped / returned) * 100)}% of those returned)` : ''),
        `median latency       ${
          [...rows.map(r => r.ms)].sort((a, b) => a - b)[Math.floor(rows.length / 2)]
        } ms`,
      ].join('\n'),
    )
  })
})
