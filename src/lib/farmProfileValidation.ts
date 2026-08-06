/**
 * What the farm onboarding wizard refuses to submit.
 *
 * P1 / W10.1 — the farm profile had no validation of any kind, and neither
 * does the database: `public.farms` carries **zero** CHECK constraints and only
 * three NOT NULL columns (id, created_at, updated_at), verified against
 * production 2026-08-06. Compare `inventory_batches`, which has nineteen. So a
 * farm row can be created with a blank name, no contact of any kind, and a THC
 * figure of 900%, and nothing anywhere says no. This module is the only line of
 * defence there is.
 *
 * Two deliberate limits:
 *
 *   1. It blocks the FINAL submit only. Saving a draft and moving between steps
 *      must never be blocked — a farmer part-way through a nine-step form on a
 *      phone has to be able to stop, and blocking that loses the work.
 *
 *   2. A blank optional field is not an error. Only the small required set is
 *      required; everything else is checked only once the farmer has typed
 *      something. Over-blocking an onboarding form does not produce better
 *      data, it produces no farm.
 *
 * Messages are not built here. This returns codes, and the component renders
 * them in the farmer's language — matching how the rest of the farmer screens
 * handle bilingual copy, and keeping this module testable without any UI.
 */

export type FarmValidationSeverity = 'error' | 'warning'

export interface FarmValidationIssue {
  /** The draft key, so the component can focus or highlight it. */
  field: string
  /** Which wizard step the farmer must go back to. */
  step: number
  code: FarmValidationCode
  severity: FarmValidationSeverity
}

export type FarmValidationCode =
  | 'required'
  | 'contact-required'
  | 'email-invalid'
  | 'phone-invalid'
  | 'not-a-number'
  | 'negative'
  | 'percent-out-of-range'
  | 'cannabinoids-implausible'

/**
 * Where each validated field lives in the wizard, so an error can say which
 * step to go back to on a nine-step form.
 *
 * Verified against the component by `farmProfileValidation.stepMap.test.ts`,
 * which re-derives this from the source. A hand-written map that silently
 * drifts would send a farmer to the wrong step, which is worse than no step.
 */
export const FIELD_STEPS: Readonly<Record<string, number>> = {
  tradingName: 1,
  province: 1,
  district: 1,
  farmType: 1,
  primaryContact: 2,
  position: 2,
  email: 2,
  mobileNumber: 2,
  lineId: 2,
  qtyAvailableNow: 4,
  typicalThc: 5,
  typicalCbd: 5,
  harvestsPerYear: 5,
  avgYieldPerHarvest: 5,
  annualCapacity: 5,
  qtyAvailable30: 6,
  qtyAvailable60: 6,
  qtyAvailable90: 6,
  qtyAvailable180: 6,
}

/** Without these, the record cannot be reviewed or the farm contacted. */
const REQUIRED_FIELDS = ['tradingName', 'province', 'primaryContact'] as const

/** At least one of these must be present — DDP has to be able to reply. */
const CONTACT_FIELDS = ['email', 'mobileNumber', 'lineId'] as const

/** Quantities and capacities: a number, and not a negative one. */
const NON_NEGATIVE_FIELDS = [
  'qtyAvailableNow', 'qtyAvailable30', 'qtyAvailable60', 'qtyAvailable90',
  'qtyAvailable180', 'harvestsPerYear', 'avgYieldPerHarvest', 'annualCapacity',
] as const

/** Percentages, bounded the same way `inventory_batches` bounds its own. */
const PERCENT_FIELDS = ['typicalThc', 'typicalCbd'] as const

/**
 * Deliberately permissive: one @, something either side, a dot in the domain.
 * A stricter pattern rejects addresses that are legal and in use, and the cost
 * of a false rejection here is a farm that cannot finish onboarding.
 */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/u

/**
 * Thai mobiles and landlines, with or without +66, and international forms.
 *
 * The leading class includes '(' deliberately: '(02) 123 4567' is how a Bangkok
 * landline is written, and an earlier version of this rule rejected it.
 */
const PHONE_ALLOWED = /^[+(\d][\d\s\-()]*$/u
const MIN_PHONE_DIGITS = 8

type Draft = Record<string, unknown>

const text = (draft: Draft, field: string): string =>
  typeof draft[field] === 'string' ? (draft[field] as string).trim() : ''

const filled = (draft: Draft, field: string): boolean => text(draft, field) !== ''

const issue = (
  field: string,
  code: FarmValidationCode,
  severity: FarmValidationSeverity = 'error',
): FarmValidationIssue => ({ field, step: FIELD_STEPS[field] ?? 1, code, severity })

/**
 * Every problem with the draft, in wizard order so the farmer is sent
 * backwards through the form once rather than bounced between steps.
 */
export function validateFarmProfile(draft: Draft): FarmValidationIssue[] {
  const issues: FarmValidationIssue[] = []

  for (const field of REQUIRED_FIELDS) {
    if (!filled(draft, field)) issues.push(issue(field, 'required'))
  }

  if (!CONTACT_FIELDS.some((field) => filled(draft, field))) {
    // Reported against the first contact field so it lands on step 2, where
    // all three live, rather than floating without a home.
    issues.push(issue('email', 'contact-required'))
  }

  if (filled(draft, 'email') && !EMAIL.test(text(draft, 'email'))) {
    issues.push(issue('email', 'email-invalid'))
  }

  if (filled(draft, 'mobileNumber')) {
    const value = text(draft, 'mobileNumber')
    const digits = value.replace(/\D/gu, '').length
    if (!PHONE_ALLOWED.test(value) || digits < MIN_PHONE_DIGITS) {
      issues.push(issue('mobileNumber', 'phone-invalid'))
    }
  }

  for (const field of NON_NEGATIVE_FIELDS) {
    if (!filled(draft, field)) continue
    const value = Number(text(draft, field))
    if (Number.isNaN(value)) issues.push(issue(field, 'not-a-number'))
    else if (value < 0) issues.push(issue(field, 'negative'))
  }

  for (const field of PERCENT_FIELDS) {
    if (!filled(draft, field)) continue
    const value = Number(text(draft, field))
    if (Number.isNaN(value)) issues.push(issue(field, 'not-a-number'))
    else if (value < 0 || value > 100) issues.push(issue(field, 'percent-out-of-range'))
  }

  // A warning, not a block: unusual combinations exist, and a farmer must not
  // be stopped by a plausibility opinion.
  const thc = Number(text(draft, 'typicalThc'))
  const cbd = Number(text(draft, 'typicalCbd'))
  if (filled(draft, 'typicalThc') && filled(draft, 'typicalCbd')
      && !Number.isNaN(thc) && !Number.isNaN(cbd) && thc + cbd > 100) {
    issues.push(issue('typicalThc', 'cannabinoids-implausible', 'warning'))
  }

  return issues.sort((a, b) => a.step - b.step)
}

/** Only errors stop a submission; warnings are shown and then stood aside from. */
export function blockingIssues(issues: readonly FarmValidationIssue[]): FarmValidationIssue[] {
  return issues.filter((i) => i.severity === 'error')
}
