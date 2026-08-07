// What a rule WOULD do, before it is allowed to do anything.
//
// This exists because of an ordering problem that is easy to get wrong. Rule
// enforcement is a HARD BLOCK with no override (owner decision, 2026-08-07): an
// approved blocking rule stops a buyer pack being issued, full stop. The first
// person to author a real rule is therefore one save away from halting trade on
// however many batches they did not think about — and production already holds
// 182 candidate updates waiting to become rules.
//
// A dry run is the cheapest possible answer: evaluate the candidate condition
// across the batches that exist today and show exactly which ones it would flag,
// which it could not decide, and which it would leave alone. Nothing is written
// and no alert is raised.
//
// It is also the fastest way to discover that the field registry cannot express
// what a real regulation needs — which is a design finding worth having BEFORE
// the migration that stores conditions, not after.
//
// ── THE UNEVALUABLE COUNT IS THE INTERESTING NUMBER ──────────────────────────
// A rule that flags 3 batches and cannot decide 40 is not a working rule. It is
// a rule that will raise 40 alerts for a human to triage the moment it is
// switched on, because unevaluable never means "no violation" here. Authors
// consistently look at the match count and ignore this one, so the summary
// reports it first-class rather than burying it in a total.

import type { InventoryItem } from '../types'
import { evaluateRuleCondition } from './complianceRuleCondition'
import type { RuleCondition } from './complianceRuleCondition'

export interface DryRunHit {
  batchId: string
  batchNumber: string
  farmName: string
  /** Why this batch was flagged, or why it could not be decided. */
  reason: string
}

export interface DryRunSummary {
  /** How many batches the condition was run against. */
  evaluated: number
  /** Batches the rule WOULD flag. Each of these becomes a blocked buyer pack. */
  wouldFlag: DryRunHit[]
  /** Batches the rule CANNOT decide. Each of these becomes a human triage item. */
  cannotDecide: DryRunHit[]
  /** Count left untouched. Derived, but reported so the three numbers sum visibly. */
  wouldLeaveAlone: number
}

/**
 * Runs a candidate condition across batches without writing anything.
 *
 * `asOf` is injectable so a rule with a date clause can be checked against a
 * chosen day rather than only "now" — an author reasoning about a rule that
 * takes effect next month needs to see what it does then, not today.
 */
export function dryRunRuleCondition(
  condition: RuleCondition,
  batches: InventoryItem[],
  asOf: Date = new Date(),
): DryRunSummary {
  const wouldFlag: DryRunHit[] = []
  const cannotDecide: DryRunHit[] = []

  for (const batch of batches) {
    const result = evaluateRuleCondition(condition, batch, asOf)
    const hit: DryRunHit = {
      batchId: batch.id,
      batchNumber: batch.batchNumber || batch.id,
      farmName: batch.farmName || '',
      reason: result.reason,
    }
    // Order matters: unevaluable is checked FIRST. `matched` is already false
    // whenever `unevaluable` is true, but relying on that ordering silently
    // would make this correct by accident rather than on purpose.
    if (result.unevaluable) cannotDecide.push(hit)
    else if (result.matched) wouldFlag.push(hit)
  }

  return {
    evaluated: batches.length,
    wouldFlag,
    cannotDecide,
    wouldLeaveAlone: batches.length - wouldFlag.length - cannotDecide.length,
  }
}

/**
 * One line an author can act on, leading with whichever number should worry
 * them most.
 *
 * A rule that decides nothing is reported as broken rather than as harmless:
 * "would flag 0" reads like a safe rule, and if the other 40 are undecidable it
 * is the opposite of safe.
 */
export function describeDryRun(summary: DryRunSummary): string {
  const { evaluated, wouldFlag, cannotDecide, wouldLeaveAlone } = summary

  if (evaluated === 0) {
    return 'No batches to check. This rule has not been tested against anything.'
  }
  if (cannotDecide.length === evaluated) {
    return `This rule cannot be decided for ANY of the ${evaluated} batches checked — every one is missing a value it needs. Switching it on would raise ${evaluated} triage items and block nothing.`
  }
  if (wouldFlag.length === 0 && cannotDecide.length === 0) {
    return `This rule would flag none of the ${evaluated} batches checked. Confirm that is what you expect before approving it.`
  }

  const parts = [`Would flag ${wouldFlag.length} of ${evaluated} batches`]
  if (cannotDecide.length > 0) {
    parts.push(`cannot decide ${cannotDecide.length} (each becomes a human triage item, not a pass)`)
  }
  parts.push(`${wouldLeaveAlone} unaffected`)
  return parts.join('; ') + '.'
}
