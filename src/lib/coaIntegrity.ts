// ─── COA integrity checks — the part that can fail ───────────────────────────
//
// coaExtraction.ts normalises what a model reported into database-shaped rows.
// It cannot tell whether that reading is INTERNALLY COHERENT, and on real
// documents that is the failure that matters, because an incoherent reading
// looks exactly like a good one: every value is a plausible number in a
// plausible unit, and every constraint in migration 28 is satisfied.
//
// These checks are pure, take no dependencies, and are the reason
// docs/COA_EXTRACTION_DESIGN.md exists. Each one is here because it caught
// something on a real document, and the comment says which.

/**
 * The decarboxylation factor.
 *
 * THCA loses a carboxyl group when heated and becomes d9-THC. The mass lost is
 * fixed, so the yield is fixed: 0.877 of the THCA mass. Every laboratory in the
 * evidence base applies it, and both report families state a total that this
 * reproduces.
 *
 * This is arithmetic about a molecule, not a policy, so it is not configurable.
 */
export const THC_CONVERSION_FACTOR = 0.877

/**
 * How far the recomputed total may sit from the stated total before it is a
 * disagreement rather than rounding.
 *
 * WHY THIS IS NOT ZERO, which is the tempting value. The laboratory publishes
 * d9-THC and THCA already rounded to two decimals, so the recomputation inherits
 * that rounding and can never reproduce the stated total exactly. Across the
 * eleven real certificates the largest disagreement is 0.0108 (report
 * RP-E2602-0193). Two inputs each rounded to two decimals can move the result by
 * roughly 0.015 in the worst case.
 *
 * An equality test would reject reports RP-E2602-0192 and RP-E2602-0193, both of
 * which are correct — they round to 21.05 against a stated 21.06, and 22.53
 * against a stated 22.52. That is the whole reason this constant is named and
 * carries this comment.
 */
export const TOTAL_THC_TOLERANCE_PCT = 0.02

/** Percent by weight, as the laboratory reports cannabinoids. */
export interface CannabinoidReading {
  /** d9-THC, %w/w. */
  delta9ThcPct: number | null
  /** THCA, %w/w. */
  thcaPct: number | null
  /** Total THC as the laboratory printed it, %w/w. */
  statedTotalThcPct: number | null
}

export type TotalThcVerdict =
  /** Recomputed total agrees with the stated total. */
  | 'consistent'
  /** Recomputed total contradicts the stated total. */
  | 'inconsistent'
  /** Not enough figures were read to run the check. */
  | 'not_checkable'

export interface TotalThcCheck {
  verdict: TotalThcVerdict
  /** d9 + (THCA × 0.877), or null when the inputs were not both read. */
  recomputedPct: number | null
  /** |recomputed − stated|, or null when either side is missing. */
  differencePct: number | null
  /** Populated for every verdict except `consistent`. */
  warning: string | null
}

const isFiniteNumber = (v: number | null): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * Total THC from its two components.
 *
 * Exported separately because it is also the honest way to report a total on a
 * certificate that states none: the working can be shown.
 */
export function recomputeTotalThc(delta9ThcPct: number, thcaPct: number): number {
  return delta9ThcPct + thcaPct * THC_CONVERSION_FACTOR
}

/**
 * Checks the stated total THC against the total implied by its own components.
 *
 * THIS IS NOT PRIMARILY A CHECK ON THE LABORATORY. It is the strongest evidence
 * available that the extractor paired the right labels with the right values,
 * because it relates three cells from three different rows and can only agree if
 * all three were read correctly.
 *
 * The failure it exists for is real and was measured. In one of the two report
 * families the PDF text layer emits whole columns rather than rows, so values
 * are paired to labels by position — and the position is not stable between
 * pages of the same file. On page 11 of the evidence pack the two totals come
 * last; on page 13, same laboratory, same template, same day, they come first. A
 * parser that learned the order from page 11 reads page 13's arsenic as 0.96 ppm
 * where the true reading is 0.04.
 *
 * No plausibility check on an individual value would fire: 0.96 ppm of arsenic
 * is an ordinary number. This check fires, because it is the only one that tests
 * a RELATIONSHIP rather than a magnitude.
 *
 * `not_checkable` is deliberately distinct from `inconsistent`. A certificate
 * that simply states no total is not a suspect certificate, and collapsing the
 * two would either raise false alarms or hide real ones.
 */
export function checkTotalThc(reading: CannabinoidReading): TotalThcCheck {
  const { delta9ThcPct, thcaPct, statedTotalThcPct } = reading

  if (!isFiniteNumber(delta9ThcPct) || !isFiniteNumber(thcaPct)) {
    return {
      verdict: 'not_checkable',
      recomputedPct: null,
      differencePct: null,
      warning: 'total THC not verified — d9-THC and THCA were not both read',
    }
  }

  const recomputedPct = recomputeTotalThc(delta9ThcPct, thcaPct)

  if (!isFiniteNumber(statedTotalThcPct)) {
    return {
      verdict: 'not_checkable',
      recomputedPct,
      differencePct: null,
      warning:
        `total THC not verified — the document states no total; ` +
        `computed ${recomputedPct.toFixed(2)} from d9-THC ${delta9ThcPct} + THCA ${thcaPct} × ${THC_CONVERSION_FACTOR}`,
    }
  }

  const differencePct = Math.abs(recomputedPct - statedTotalThcPct)

  if (differencePct <= TOTAL_THC_TOLERANCE_PCT) {
    return { verdict: 'consistent', recomputedPct, differencePct, warning: null }
  }

  return {
    verdict: 'inconsistent',
    recomputedPct,
    differencePct,
    warning:
      `total THC disagrees with its components: stated ${statedTotalThcPct}, ` +
      `but d9-THC ${delta9ThcPct} + THCA ${thcaPct} × ${THC_CONVERSION_FACTOR} = ${recomputedPct.toFixed(4)} ` +
      `(difference ${differencePct.toFixed(4)}, tolerance ${TOTAL_THC_TOLERANCE_PCT}). ` +
      `Do not accept these figures without reading the document.`,
  }
}

/** One date read from a report, in the order the report's own process requires. */
export interface OrderedDate {
  /** Human label, used in the warning text. */
  label: string
  /** ISO `YYYY-MM-DD`, or null when the date could not be parsed. */
  iso: string | null
}

/**
 * Checks that a report's dates run in the only order its process allows.
 *
 * A sample is received, then tested, then reported on. Given in that order, the
 * ISO dates must be non-decreasing.
 *
 * WHAT THIS IS FOR, AND WHAT IT IS NOT FOR. It is a validator, not a detector.
 * The date format is fixed by the lab profile and nothing found inside a
 * document may change it — see `coaLabProfiles.ts`. This check may reject a set
 * of dates. It may never reassign the format.
 *
 * That distinction is the whole point. It is tempting to reason "17/02/2026 has
 * no valid month in the first position, therefore this document is DD/MM" — and
 * that inference is correct on this laboratory's reports and silently wrong on
 * the first document whose dates all happen to be ambiguous. Read report
 * RP-E2602-0197 as US format and the sample is received on 2 November 2026,
 * after it was reported on. This check catches that. It does not conclude
 * anything about the format from it.
 *
 * Unparsed dates (null) are skipped rather than treated as failures — they have
 * already produced their own warning at parse time, and reporting them twice
 * tells a reviewer there are two problems when there is one.
 */
export function checkDateOrder(dates: readonly OrderedDate[]): string[] {
  const known = dates.filter((d): d is { label: string; iso: string } => d.iso !== null)
  const warnings: string[] = []

  for (let i = 1; i < known.length; i += 1) {
    const previous = known[i - 1]
    const current = known[i]
    // ISO YYYY-MM-DD compares correctly as a string, so no Date objects and no
    // timezone to get wrong.
    if (current.iso < previous.iso) {
      warnings.push(
        `${current.label} (${current.iso}) is before ${previous.label} (${previous.iso}), ` +
          `which the reporting process does not allow — the dates may have been misread`,
      )
    }
  }

  return warnings
}
