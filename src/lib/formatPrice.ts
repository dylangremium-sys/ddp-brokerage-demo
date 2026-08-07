import { DEFAULT_BATCH_PRICE_CURRENCY, type BatchPriceCurrency } from '../types'

/**
 * One way to render a batch price, for every surface that shows one.
 *
 * P1 — row B-P3, "Price with explicit currency".
 *
 * Two defects, both measured 2026-08-07 across all five places a price is
 * rendered:
 *
 * 1. Every one of them hardcoded the baht sign, and two of them hardcoded the
 *    literal string "THB/kg". Production accepts THB, USD and EUR
 *    (inventory_batches_price_currency_allowed), and a batch now stores which
 *    one it is — so a USD listing displayed as baht everywhere, at roughly a
 *    thirty-fold error, with nothing anywhere to hint at it.
 *
 * 2. The guard against an unpriced batch was applied on some screens and not
 *    others. `pricePerKg` comes from `parseFloat(x) || 0`, so a batch with no
 *    price stores 0. The buyer pack renders "—" for that; the farmer's own
 *    stock list and status page rendered "฿0/kg", telling a farm its crop was
 *    priced at zero.
 *
 * NOTE for docs/MASTER_PLAN.md §11: finding F-N5 says an unpriced batch "will
 * read to a buyer as ฿0/kg". That is wrong, and this corrects it — the buyer
 * pack already guarded `> 0`. It was the FARMER's own screens that showed ฿0.
 * The finding was right that the defect exists and wrong about who saw it.
 */

/** Symbols for the currencies production's CHECK admits. */
const SYMBOL: Record<BatchPriceCurrency, string> = {
  THB: '฿',
  USD: '$',
  EUR: '€',
}

/** What to show when there is no price, rather than a price of nothing. */
export const NO_PRICE = '—'

/**
 * Renders a price, or `NO_PRICE` when there is not one.
 *
 * A batch with no price is not a batch priced at zero, and the difference
 * matters to whoever reads it: "—" invites the question, "฿0" answers it
 * wrongly.
 */
export function formatBatchPrice(
  pricePerKg: number | null | undefined,
  currency: BatchPriceCurrency | null | undefined,
  unit: string = 'kg',
): string {
  if (pricePerKg == null || Number.isNaN(pricePerKg) || pricePerKg <= 0) return NO_PRICE
  const code = currency ?? DEFAULT_BATCH_PRICE_CURRENCY
  return `${SYMBOL[code] ?? ''}${pricePerKg.toLocaleString()} ${code}/${unit}`
}
