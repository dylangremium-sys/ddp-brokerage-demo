// What a compliance rule CHECKS — the machine-readable half a rule has never had.
//
// A rule could always say who it applies to (entity_type, jurisdiction), how much
// it matters (severity, is_blocking) and whether it is in force (status, effective
// window). What it could not say is what makes a batch violate it. That is why
// nothing evaluates rules today and a human has to link rule to batch by hand
// (W1 in docs/WATCHTOWER_CANONICAL_ARCHITECTURE.md §9).
//
// This is Option A from docs/W1_RULE_CONDITION_DESIGN.md: the condition is DATA,
// not code and not a string to be parsed.
//
// ── WHY DATA ─────────────────────────────────────────────────────────────────
// The question this system eventually has to answer is not "does it work" but
// "six months on, why was batch DDP-0412 refused?". A condition stored as data
// answers that with a row — the rule, its version, the clause, and the value
// that tripped it. A condition stored as code answers it with "read the bundle
// that was deployed in March". In a regulated domain that is the wrong artefact
// to have to produce.
//
// It also keeps the people who own the rules and the people who own the deploy
// pipeline separate: a compliance officer reading a new Thai FDA notice can
// author the rule the same day.
//
// ── FAIL CLOSED, AND WHAT THAT MEANS HERE ────────────────────────────────────
// Evaluation has THREE outcomes, not two: matched, not matched, and UNEVALUABLE.
// A missing field, a field of the wrong shape, or an unknown operator is not
// "no violation" — it is "we cannot tell", and the caller must escalate it to a
// human rather than let a pack through. Collapsing unevaluable into false is the
// single most likely way to build a gate that silently stops gating.
//
// ── WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────────────
// No `eval`, no `new Function`, no expression parser. The only things that can
// be named are fields in the registry below, and the only things that can be
// done to them are the operators declared for their type. A condition that names
// anything else fails VALIDATION, before it can be stored — not at evaluation
// time on the gate's critical path.
//
// The cross-entity escape hatch ({"check": "named_key"}) from the design document
// is NOT implemented yet. It is deliberately absent rather than stubbed, so that
// nothing can half-use it. See parseRuleCondition's rejection of unknown keys.

import type { InventoryItem } from '../types'
import type { RuleCondition, RuleFieldType, RuleLeaf } from './complianceRuleConditionTypes'

// The shape lives in a dependency-free leaf module so types.ts can reference it
// without importing this one. Re-exported so existing importers are unaffected.
export type { RuleCondition, RuleFieldType, RuleLeaf }

// ── The field registry ───────────────────────────────────────────────────────

interface RuleFieldSpec {
  type: RuleFieldType
  /** Plain-English name, for describeRuleCondition and the authoring UI. */
  label: string
  /** Reads the raw value off a batch. Returns null when the batch has none. */
  read: (batch: InventoryItem) => number | string | null
  /** Shown next to the value in explanations, e.g. '%' or 'kg'. */
  unit?: string
}

/**
 * The ONLY fields a rule may name. Adding one here is a deliberate act: it
 * widens what compliance can express, and every entry must be a value that is
 * actually present on a batch rather than derived from somewhere unverified.
 */
export const RULE_FIELDS: Record<string, RuleFieldSpec> = {
  thcPct:      { type: 'number', label: 'THC',           unit: '%',  read: b => numOrNull(b.thcPct) },
  cbdPct:      { type: 'number', label: 'CBD',           unit: '%',  read: b => numOrNull(b.cbdPct) },
  moisturePct: { type: 'number', label: 'Moisture',      unit: '%',  read: b => numOrNull(b.moisturePct) },
  quantityKg:  { type: 'number', label: 'Quantity',      unit: 'kg', read: b => numOrNull(b.quantityKg) },
  pricePerKg:  { type: 'number', label: 'Price per kg',              read: b => numOrNull(b.pricePerKg) },
  harvestDate: { type: 'date',   label: 'Harvest date',              read: b => textOrNull(b.harvestDate) },
  cureDate:    { type: 'date',   label: 'Cure date',                 read: b => textOrNull(b.cureDate) },
  qualityGrade:{ type: 'text',   label: 'Quality grade',             read: b => textOrNull(b.qualityGrade) },
  location:    { type: 'text',   label: 'Location',                  read: b => textOrNull(b.location) },
  productName: { type: 'text',   label: 'Product',                   read: b => textOrNull(b.productName) },
  priceCurrency:{type: 'text',   label: 'Price currency',            read: b => textOrNull(b.priceCurrency ?? null) },
  certFileName:{ type: 'text',   label: 'COA file',                  read: b => textOrNull(b.certFileName) },
}

/**
 * NaN is not a number for our purposes. A NaN slipping through as a value would
 * make every comparison false, which reads as "no violation" — the exact
 * silent-pass this module exists to avoid. It is returned as null so the field
 * is UNEVALUABLE and a human is asked.
 */
function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

export const OPERATORS_BY_TYPE: Record<RuleFieldType, readonly string[]> = {
  number: ['gt', 'gte', 'lt', 'lte', 'eq', 'neq'],
  date:   ['before', 'after', 'olderThanDays'],
  text:   ['eq', 'neq', 'in', 'isPresent', 'isAbsent'],
}

// ── The condition shape ──────────────────────────────────────────────────────

// ── Validation, which happens on WRITE ───────────────────────────────────────

export type ParseResult =
  | { ok: true; condition: RuleCondition }
  | { ok: false; errors: string[] }

/**
 * Validates an untrusted value into a RuleCondition, or explains why not.
 *
 * Runs when a rule is SAVED, so an unknown field or a type mismatch is refused
 * at authoring time with a message the author can act on — rather than becoming
 * an unevaluable condition that blocks packs later for reasons nobody can see.
 */
export function parseRuleCondition(input: unknown, path = 'condition'): ParseResult {
  const errors: string[] = []
  const node = validate(input, path, errors)
  return errors.length === 0 && node !== null
    ? { ok: true, condition: node }
    : { ok: false, errors }
}

function validate(input: unknown, path: string, errors: string[]): RuleCondition | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    errors.push(`${path}: expected an object`)
    return null
  }
  const obj = input as Record<string, unknown>
  const keys = Object.keys(obj)

  if (keys.includes('all') || keys.includes('any')) {
    const key = keys.includes('all') ? 'all' : 'any'
    const branch = obj[key]
    if (!Array.isArray(branch) || branch.length === 0) {
      errors.push(`${path}.${key}: expected a non-empty array`)
      return null
    }
    const children = branch.map((child, i) => validate(child, `${path}.${key}[${i}]`, errors))
    if (children.some(c => c === null)) return null
    return key === 'all'
      ? { all: children as RuleCondition[] }
      : { any: children as RuleCondition[] }
  }

  if (keys.includes('not')) {
    const child = validate(obj.not, `${path}.not`, errors)
    return child === null ? null : { not: child }
  }

  // The cross-entity escape hatch is named explicitly so its absence is a clear
  // message rather than "expected an object".
  if (keys.includes('check')) {
    errors.push(`${path}.check: named cross-entity checks are not implemented yet (design option B escape hatch)`)
    return null
  }

  const field = obj.field
  const op = obj.op
  // hasOwnProperty, NOT `in`. `'constructor' in RULE_FIELDS` is TRUE via the
  // prototype chain, as are '__proto__', 'toString' and friends — so `in` would
  // admit a leaf naming any of them, hand back Object.prototype.constructor as
  // the "field spec", and then read `.type` off it. Found by the prototype
  // -pollution test in this module's suite, which is exactly why that test
  // exists rather than being assumed unnecessary.
  if (typeof field !== 'string' || !Object.prototype.hasOwnProperty.call(RULE_FIELDS, field)) {
    errors.push(`${path}.field: unknown field ${JSON.stringify(field)}. Known fields: ${Object.keys(RULE_FIELDS).join(', ')}`)
    return null
  }
  const spec = RULE_FIELDS[field]
  if (typeof op !== 'string' || !OPERATORS_BY_TYPE[spec.type].includes(op)) {
    errors.push(`${path}.op: ${JSON.stringify(op)} is not valid for a ${spec.type} field. Valid: ${OPERATORS_BY_TYPE[spec.type].join(', ')}`)
    return null
  }

  const takesNoOperand = op === 'isPresent' || op === 'isAbsent'
  if (takesNoOperand) {
    if ('value' in obj) errors.push(`${path}.value: ${op} takes no value`)
    return errors.length ? null : { field, op }
  }

  const value = obj.value
  if (op === 'in') {
    if (!Array.isArray(value) || value.length === 0 || value.some(v => typeof v !== 'string')) {
      errors.push(`${path}.value: 'in' expects a non-empty array of strings`)
      return null
    }
    return { field, op, value: value as string[] }
  }
  if (spec.type === 'number' || op === 'olderThanDays') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push(`${path}.value: expected a finite number`)
      return null
    }
    return { field, op, value }
  }
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push(`${path}.value: expected a non-empty string`)
    return null
  }
  return { field, op, value: value.trim() }
}

// ── Evaluation ───────────────────────────────────────────────────────────────

export interface EvaluationResult {
  /** True only when the condition definitively matched. */
  matched: boolean
  /**
   * True when the condition could not be decided — a missing value, an
   * unparseable date. NEVER treat this as "no violation": the caller must raise
   * it for a human. `matched` is false when this is true, so a caller that only
   * checks `matched` fails safe rather than silently passing.
   */
  unevaluable: boolean
  /** Plain-English account of what happened, for the alert and the audit row. */
  reason: string
}

export function evaluateRuleCondition(
  condition: RuleCondition,
  batch: InventoryItem,
  asOf: Date = new Date(),
): EvaluationResult {
  if ('all' in condition) {
    const parts = condition.all.map(c => evaluateRuleCondition(c, batch, asOf))
    const blocked = parts.find(p => p.unevaluable)
    if (blocked) return { matched: false, unevaluable: true, reason: blocked.reason }
    const failed = parts.find(p => !p.matched)
    return failed
      ? { matched: false, unevaluable: false, reason: failed.reason }
      : { matched: true, unevaluable: false, reason: parts.map(p => p.reason).join(' AND ') }
  }

  if ('any' in condition) {
    const parts = condition.any.map(c => evaluateRuleCondition(c, batch, asOf))
    const hit = parts.find(p => p.matched)
    if (hit) return hit
    // Only once nothing matched does an unevaluable branch matter: a definite
    // match elsewhere already decides the OR.
    const blocked = parts.find(p => p.unevaluable)
    return blocked
      ? { matched: false, unevaluable: true, reason: blocked.reason }
      : { matched: false, unevaluable: false, reason: parts.map(p => p.reason).join(' and ') }
  }

  if ('not' in condition) {
    const inner = evaluateRuleCondition(condition.not, batch, asOf)
    return inner.unevaluable
      ? inner
      : { matched: !inner.matched, unevaluable: false, reason: `NOT (${inner.reason})` }
  }

  return evaluateLeaf(condition, batch, asOf)
}

function evaluateLeaf(leaf: RuleLeaf, batch: InventoryItem, asOf: Date): EvaluationResult {
  const spec = RULE_FIELDS[leaf.field]
  if (!spec) {
    return { matched: false, unevaluable: true, reason: `unknown field ${leaf.field}` }
  }
  const raw = spec.read(batch)
  const shown = `${spec.label}${spec.unit ? ` (${spec.unit})` : ''}`

  if (leaf.op === 'isPresent') {
    return { matched: raw !== null, unevaluable: false, reason: raw !== null ? `${shown} is present` : `${shown} is missing` }
  }
  if (leaf.op === 'isAbsent') {
    return { matched: raw === null, unevaluable: false, reason: raw === null ? `${shown} is missing` : `${shown} is present` }
  }

  if (raw === null) {
    return { matched: false, unevaluable: true, reason: `${shown} is missing, so this rule cannot be decided for this batch` }
  }

  if (spec.type === 'number') {
    const actual = raw as number
    const target = leaf.value as number
    const matched =
      leaf.op === 'gt'  ? actual >  target :
      leaf.op === 'gte' ? actual >= target :
      leaf.op === 'lt'  ? actual <  target :
      leaf.op === 'lte' ? actual <= target :
      leaf.op === 'eq'  ? actual === target :
                          actual !== target
    return { matched, unevaluable: false, reason: `${shown} is ${actual}, ${OP_WORDS[leaf.op] ?? leaf.op} ${target}` }
  }

  if (spec.type === 'date') {
    const when = Date.parse(String(raw))
    if (Number.isNaN(when)) {
      return { matched: false, unevaluable: true, reason: `${shown} is not a readable date (${raw}), so this rule cannot be decided` }
    }
    if (leaf.op === 'olderThanDays') {
      const days = Math.floor((asOf.getTime() - when) / 86_400_000)
      const limit = leaf.value as number
      return { matched: days > limit, unevaluable: false, reason: `${shown} is ${days} day(s) ago, limit ${limit}` }
    }
    const target = Date.parse(String(leaf.value))
    if (Number.isNaN(target)) {
      return { matched: false, unevaluable: true, reason: `the rule's date ${JSON.stringify(leaf.value)} is not readable` }
    }
    const matched = leaf.op === 'before' ? when < target : when > target
    return { matched, unevaluable: false, reason: `${shown} is ${raw}, ${leaf.op} ${leaf.value}` }
  }

  const actual = String(raw)
  if (leaf.op === 'in') {
    const set = leaf.value as string[]
    return { matched: set.includes(actual), unevaluable: false, reason: `${shown} is "${actual}", among [${set.join(', ')}]` }
  }
  const target = String(leaf.value)
  const matched = leaf.op === 'eq' ? actual === target : actual !== target
  return { matched, unevaluable: false, reason: `${shown} is "${actual}", ${leaf.op === 'eq' ? 'equal to' : 'not equal to'} "${target}"` }
}

const OP_WORDS: Record<string, string> = {
  gt: 'above', gte: 'at or above', lt: 'below', lte: 'at or below',
  eq: 'equal to', neq: 'not equal to',
}

// ── Explanation ──────────────────────────────────────────────────────────────

/**
 * Renders a condition in plain English, for the authoring screen and for the
 * blocked-pack notice. A rule an operator cannot read is a rule they cannot
 * challenge, and on a hard-block gate that is not acceptable.
 */
export function describeRuleCondition(condition: RuleCondition): string {
  if ('all' in condition) return condition.all.map(describeRuleCondition).join(' AND ')
  if ('any' in condition) return condition.any.map(describeRuleCondition).join(' OR ')
  if ('not' in condition) return `NOT (${describeRuleCondition(condition.not)})`

  const spec = RULE_FIELDS[condition.field]
  const label = spec ? `${spec.label}${spec.unit ? ` (${spec.unit})` : ''}` : condition.field
  if (condition.op === 'isPresent') return `${label} is present`
  if (condition.op === 'isAbsent') return `${label} is missing`
  if (condition.op === 'in') return `${label} is one of [${(condition.value as string[]).join(', ')}]`
  if (condition.op === 'olderThanDays') return `${label} is more than ${condition.value} days ago`
  if (condition.op === 'before' || condition.op === 'after') return `${label} is ${condition.op} ${condition.value}`
  return `${label} is ${OP_WORDS[condition.op] ?? condition.op} ${condition.value}`
}
