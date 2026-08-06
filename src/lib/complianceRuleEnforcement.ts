// Whether an approved compliance rule actually STOPS a buyer pack being issued.
//
// This is the fifth link in the Watchtower chain — AI detects → AI summarises →
// human reviews → approved rule → SYSTEM ENFORCES. Until this module existed the
// fifth link did not: rules were stored, displayed and status-managed, and
// nothing in the platform read one to gate anything. An administrator could
// approve a blocking rule and the buyer pack would still issue. See
// docs/WATCHTOWER_CANONICAL_ARCHITECTURE.md §1 (gap W8).
//
// ── WHAT COUNTS AS "IN FORCE", AND WHY THIS FILE DOES NOT SIMPLY CALL
//    public.compliance_rules_currently_enforced() ─────────────────────────────
//
// There are two definitions of "this rule is enforced" in this codebase and they
// DISAGREE. That is a defect in its own right; it is recorded so the next reader
// does not assume one of them is authoritative:
//
//   • isEnforcedRuleStatus() in complianceRules.ts says 'approved' OR 'active',
//     and its docblock calls itself "the single canonical definition". It has no
//     concept of effective dating at all, because it predates migration 41,
//     which added effective_from / effective_to and was never reconciled with it.
//
//   • compliance_rules_currently_enforced() (41_EFFECTIVE_DATED_RULESETS) says
//     status = 'active' ONLY, and additionally requires today to fall inside the
//     effective window.
//
// A gate cannot be built on an ambiguity — whichever it picked, the other
// definition would keep producing a screen that disagreed with the gate. So this
// module takes the SAFE HALF OF EACH, deliberately:
//
//   STATUS   — the WIDER set (isEnforcedRuleStatus: approved or active).
//              Failing to block is the dangerous direction. A rule a human has
//              approved should not be silently inert because a second promotion
//              step was never taken.
//   DATE     — the NARROWER set (inside the effective window).
//              A rule not yet in force, or already expired, must NOT block. That
//              is not caution, it is a wrong answer.
//
// This is a decision, not a discovery. If the team reconciles the two
// definitions later, this module should follow the reconciled one and this
// comment should be deleted rather than left to rot.
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
import { isEnforcedRuleStatus } from './complianceRules'

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
 * True when this rule is capable of blocking work right now: it blocks by
 * design, its status counts as enforced, and today is inside its window.
 */
export function isRuleBlockingNow(rule: ComplianceRule, asOf: Date = new Date()): boolean {
  return rule.isBlocking === true
    && isEnforcedRuleStatus(rule.status)
    && isRuleWithinEffectiveWindow(rule, asOf)
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

  return alerts
    .filter(alert =>
      alert.entityType === entityType
      && alert.entityId === entityId
      && unresolved.has(alert.status)
      && !!alert.ruleId
      && blockingRules.has(alert.ruleId),
    )
    .map(alert => {
      const rule = blockingRules.get(alert.ruleId!)!
      return {
        alertId: alert.id,
        alertTitle: alert.alertTitle,
        ruleId: rule.id,
        ruleCode: rule.ruleCode,
        ruleTitle: rule.title,
        severity: alert.severity,
      }
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
