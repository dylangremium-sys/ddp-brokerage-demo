// The condition SHAPE, alone, with no imports.
//
// Extracted so `src/types.ts` can give ComplianceRule a typed `condition`
// without importing the evaluator, which imports InventoryItem from types.ts.
// A type-only cycle would erase at runtime and probably be harmless, but this
// repository has been bitten by import-graph surprises before (the Vercel ESM
// trap that shipped a dead endpoint), and a dependency-free leaf module is the
// pattern already used for exactly this reason — see complianceSourceTypes.ts.
//
// Behaviour lives in complianceRuleCondition.ts. Nothing here executes.

export type RuleFieldType = 'number' | 'date' | 'text'

export interface RuleLeaf {
  field: string
  op: string
  /** Absent for isPresent / isAbsent, which take no operand. */
  value?: number | string | string[]
}

export type RuleCondition =
  | RuleLeaf
  | { all: RuleCondition[] }
  | { any: RuleCondition[] }
  | { not: RuleCondition }
