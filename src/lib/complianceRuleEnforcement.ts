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
// The database now AGREES with this file. `isRuleEnforcedNow` and
// `public.compliance_rules_currently_enforced()` both accept `approved` and
// `active` inside the effective window, since migration 61 widened the SQL to
// match. If either vocabulary changes, change both — see that function.
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
 * ── STATUS VOCABULARY: SETTLED, AND SHARED WITH THE DATABASE ────────────────
 * `approved` and `active` both enforce; draft, suggested, paused, retired and
 * rejected do not. A paused rule is paused and must not block a shipment today.
 *
 * This disagreed with `compliance_rules_currently_enforced()` (migration 41,
 * `active` only) until 2026-08-07, when the owner decided that **approved means
 * switched on** — it is not a staging state ahead of activation. That resolved
 * the divergence in this file's favour, so migration 61 widened the SQL rather
 * than narrowing this. Narrowing here would have silently stopped a rule that
 * blocks a buyer pack today from blocking it tomorrow, which is a weakening of a
 * safety gate and not a way to tidy a mismatch.
 *
 * THE TWO SIDES ARE NOW A CONTRACT. Changing the vocabulary here without
 * changing migration 61's, or vice versa, reopens a state where a pack can be
 * blocked by a rule the database reports as not enforced. Both ends are pinned:
 * the parity test in complianceRuleEnforcement.test.ts, and section B of
 * 61_RULE_ENFORCEMENT_STATUS_PARITY_VERIFY.sql.
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
