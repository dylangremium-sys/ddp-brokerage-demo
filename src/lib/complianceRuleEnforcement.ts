// Whether an approved compliance rule actually STOPS a buyer pack being issued.
//
// This is the fifth link in the Watchtower chain — AI detects → AI summarises →
// human reviews → approved rule → SYSTEM ENFORCES. Until this module existed the
// fifth link did not: rules were stored, displayed and status-managed, and
// nothing in the platform read one to gate anything. An administrator could
// approve a blocking rule and the buyer pack would still issue. See
// docs/WATCHTOWER_CANONICAL_ARCHITECTURE.md §1 (gap W8).
//
// ── WHAT COUNTS AS "IN FORCE" ────────────────────────────────────────────────
//
// `isRuleEnforcedNow` below is the application's single answer to "does this
// rule gate work right now?". Every caller that acts as though a rule has force
// uses it. Its companion, `isHumanApprovedRuleStatus` in complianceRules.ts,
// answers the different question "has a human blessed this?" and is used only
// for approval bookkeeping. Those two were one overloaded function until the
// reconciliation; see the comment at the top of complianceRules.ts for why they
// were split.
//
// One disagreement with the database SURVIVES that split and is deliberately
// left open, because it is a product decision rather than a coding one:
// `isRuleEnforcedNow` accepts `approved` as well as `active`, while
// `compliance_rules_currently_enforced()` (migration 41) accepts only `active`.
// The full reasoning, and how to close it in one line, is on that function.
//
// ── FAIL CLOSED ────────────────────────────────────────────────────────────────
// A rule state we could not read must never be allowed to CLEAR a block, for the
// same reason the override state may not: an unreadable state leaves us unable to
// prove either direction, so the gate shuts. This mirrors `overridesUnverified`
// in DDPBuyerPreview.tsx, deliberately — a second, differently-shaped safety
// pattern in the same gate is how half-gates get shipped.

import type {
  ComplianceAlert,
  ComplianceRule,
  ComplianceRuleEntityType,
  ComplianceSeverity,
} from '../types'
import { isHumanApprovedRuleStatus } from './complianceRules'

/**
 * Alert statuses that still represent a LIVE problem. 'resolved' and 'dismissed'
 * are the only two that release a block — listed as an allow-list of blocking
 * states rather than a deny-list, so a status added to the union later blocks by
 * default instead of silently opening the gate.
 */
export const UNRESOLVED_ALERT_STATUSES = ['open', 'in_review', 'blocked'] as const

/** One reason a pack is blocked, carrying enough detail to name it on screen. */
export interface BlockingRuleAlert {
  alertId: string
  alertTitle: string
  ruleId: string
  ruleCode: string
  ruleTitle: string
  severity: ComplianceSeverity
}

/**
 * The authoritative rule-enforcement state for ONE entity's gate computation.
 * `null` means the read has not settled; `unavailable` means it FAILED. Both
 * block. Shape deliberately mirrors DisclosureOverrideState.
 */
export interface RuleEnforcementState {
  blockingAlerts: BlockingRuleAlert[]
  /** True ⇒ the authoritative read FAILED; no rule state may be trusted either way. */
  unavailable: boolean
}

/**
 * True when today falls inside the rule's effective window.
 *
 * A rule whose effective_from is absent is treated as IN FORCE, not out of it:
 * the column is NOT NULL DEFAULT current_date in the database, so an absent
 * value here means the client did not select the column, and a gate must not
 * quietly stop blocking because of a projection change.
 */
export function isRuleWithinEffectiveWindow(
  rule: Pick<ComplianceRule, 'effectiveFrom' | 'effectiveTo'>,
  asOf: Date = new Date(),
): boolean {
  const today = asOf.toISOString().slice(0, 10)
  const from = rule.effectiveFrom ?? null
  const to = rule.effectiveTo ?? null
  if (from !== null && from > today) return false
  if (to !== null && to <= today) return false
  return true
}

/**
 * THE CANONICAL "does this rule gate work right now?" PREDICATE for the
 * application. A rule is enforced now when a human has blessed its status and
 * today falls inside its effective window.
 *
 * Every caller that acts as though a rule has force — the buyer-pack gate, rule
 * impact, alert derivation, rule linking — must use this and not a bare status
 * check, because a bare status check cannot see the effective window and will
 * happily enforce a rule that expired last year or starts next year.
 *
 * ── OPEN QUESTION, DELIBERATELY LEFT OPEN ───────────────────────────────────
 * This includes status `approved` as well as `active`, matching the behaviour
 * shipped in #157. The database's `compliance_rules_currently_enforced()`
 * (migration 41) is NARROWER: `active` only. The two therefore still disagree
 * about one status, and that disagreement is a PRODUCT decision, not a coding
 * one:
 *
 *   • If `approved` means "a human signed it off but it is not switched on
 *     yet", then only `active` should enforce and this should narrow to match
 *     the database.
 *   • If `approved` and `active` are effectively synonyms in the operator's
 *     head, the database function should widen instead.
 *
 * It is left WIDE here on purpose: narrowing it would silently stop a rule that
 * blocks a buyer pack today from blocking it tomorrow, and quietly weakening a
 * safety gate is not a change to make as a side effect of a refactor. Flipping
 * it is one line — swap `isHumanApprovedRuleStatus` for `status === 'active'` —
 * once someone decides what `approved` means. Until then the divergence is
 * named rather than hidden, and asserted by test.
 */
export function isRuleEnforcedNow(rule: ComplianceRule, asOf: Date = new Date()): boolean {
  return isHumanApprovedRuleStatus(rule.status)
    && isRuleWithinEffectiveWindow(rule, asOf)
}

/**
 * True when this rule is capable of BLOCKING work right now: it is enforced now
 * (above) and it blocks by design rather than merely informing.
 */
export function isRuleBlockingNow(rule: ComplianceRule, asOf: Date = new Date()): boolean {
  return rule.isBlocking === true && isRuleEnforcedNow(rule, asOf)
}

/**
 * The blocking reasons for one entity: every unresolved alert raised against it
 * that names a rule which is blocking right now.
 *
 * An alert naming NO rule is not a blocker here. That is deliberate: this gate
 * enforces *rules*, and an unattributed alert has no approved rule behind it.
 * Such alerts remain visible on the compliance pages; they simply do not gate.
 */
export function selectBlockingRuleAlerts(
  entityType: ComplianceRuleEntityType,
  entityId: string,
  rules: ComplianceRule[],
  alerts: ComplianceAlert[],
  asOf: Date = new Date(),
): BlockingRuleAlert[] {
  const blockingRules = new Map(
    rules.filter(rule => isRuleBlockingNow(rule, asOf)).map(rule => [rule.id, rule]),
  )
  if (blockingRules.size === 0) return []

  const unresolved = new Set<string>(UNRESOLVED_ALERT_STATUSES)

  // A guard sequence rather than filter+map: the map half would need two
  // non-null assertions to re-state what the filter already proved, and an
  // assertion on a security gate is a claim the compiler cannot check. Each
  // early return below is a distinct, readable reason an alert does not block.
  return alerts.flatMap(alert => {
    if (alert.entityType !== entityType) return []
    if (alert.entityId !== entityId) return []
    if (!unresolved.has(alert.status)) return []

    const ruleId = alert.ruleId
    if (!ruleId) return []

    const rule = blockingRules.get(ruleId)
    if (!rule) return []

    return [{
      alertId: alert.id,
      alertTitle: alert.alertTitle,
      ruleId: rule.id,
      ruleCode: rule.ruleCode,
      ruleTitle: rule.title,
      severity: alert.severity,
    }]
  })
}

/**
 * True when the rule state could not be trusted — not settled, or the read
 * failed. `undefined` means the caller does not participate in this gate at all
 * and is NOT treated as unverified, matching the overrideState convention.
 */
export function isRuleEnforcementUnverified(
  state: RuleEnforcementState | null | undefined,
): boolean {
  return state !== undefined && (state === null || state.unavailable)
}

/**
 * The single question the buyer-pack gate asks: must this pack be blocked on
 * compliance-rule grounds? True when the state is unverifiable OR at least one
 * blocking rule alert stands.
 */
export function hasEnforcedRuleBlock(
  state: RuleEnforcementState | null | undefined,
): boolean {
  if (isRuleEnforcementUnverified(state)) return true
  return !!state && state.blockingAlerts.length > 0
}

/** Human wording for the blocked notice, naming the rules rather than a count. */
export function describeRuleBlock(alerts: BlockingRuleAlert[]): string {
  if (alerts.length === 0) return ''
  const named = alerts.map(a => `${a.ruleCode} — ${a.ruleTitle}`).join('; ')
  return alerts.length === 1
    ? `Blocked by an approved compliance rule in force: ${named}.`
    : `Blocked by ${alerts.length} approved compliance rules in force: ${named}.`
}
