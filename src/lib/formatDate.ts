import type { Lang } from '../types'

/**
 * One date format for the whole farmer interface, driven by the app's own
 * language setting.
 *
 * P1 / W10.4 — row F-U4, "Buddhist-Era date handling", scored 0.
 *
 * The finding behind that row is that `thaiCalendar.ts` — 296 lines, tested —
 * is imported by nothing. Wiring it in here would be the obvious response and
 * would be wrong: `Intl` already renders the Thai calendar. `th-TH` formats
 * 2026-03-01 as "1 มี.ค. 2569", with the Buddhist year, on every engine this
 * app runs on. Measured, not assumed.
 *
 * The actual defect is that the farmer screens format dates four different
 * ways and only two of them consult `lang`:
 *
 *   - FarmerMyStock rendered `{item.harvestDate}` raw, so a farmer read
 *     "2026-03-01" in both languages.
 *   - FarmerMyStock also called `toLocaleDateString()` with NO locale, which
 *     follows the machine rather than the app — so a farmer who chose English
 *     on a Thai handset still got Thai dates, and the reverse.
 *   - FarmerStatus hardcoded 'en-GB', so the Thai interface showed Gregorian
 *     years to a Thai reader.
 *   - Two other call sites did it correctly, which is how the inconsistency
 *     survived: it looked right wherever anyone checked.
 *
 * So the fix is one function, not a calendar library. What `thaiCalendar.ts`
 * uniquely offers — classifying and converting a Buddhist year that ARRIVES in
 * data — still has no caller, and every farmer-facing date input is a native
 * `<input type="date">`, which yields ISO Gregorian regardless of locale. That
 * module should be wired to an import or admin boundary, or deleted; it is
 * recorded as such rather than being given a cosmetic caller here.
 */

const LOCALE: Record<Lang, string> = { en: 'en-GB', th: 'th-TH' }

const DEFAULT_OPTIONS: Intl.DateTimeFormatOptions = {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
}

/**
 * Formats an ISO date or timestamp for display.
 *
 * Returns the input unchanged when it is not a date this can parse. A farmer
 * seeing the raw value they entered is recoverable; seeing "Invalid Date" is
 * not, and neither is a screen that throws.
 */
export function formatDate(
  value: string | null | undefined,
  lang: Lang,
  options: Intl.DateTimeFormatOptions = DEFAULT_OPTIONS,
): string {
  if (!value) return ''
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toLocaleDateString(LOCALE[lang] ?? LOCALE.en, options)
}
