/**
 * The one telephone number DDP publishes, in the form an `href` needs.
 *
 * The number is displayed through the translation register — `homeFooterOfficeTel`
 * is `'Tel: +66 2 210 8888'` in English and `'โทร: +66 2 210 8888'` in Thai — so
 * the visible string carries a localised label and human spacing that a `tel:`
 * URI must not. That leaves two representations of one fact, and before this
 * module the dialable one was a bare literal repeated in the components that
 * happened to link it. Changing the office number meant finding every copy.
 *
 * Keeping the href here does not by itself stop the two drifting apart, so
 * `publicContactChannel.test.ts` asserts that the digits below are the digits
 * displayed in every language tree. A number changed in one place and not the
 * other fails there rather than shipping a link that dials the old office.
 *
 * E.164: country code, then the national number with no spaces and no
 * punctuation. Dialers accept the spaced form inconsistently; this form is the
 * one every platform parses.
 */
export const OFFICE_TEL_E164 = '+6622108888'

/** The `href` value for a link that dials the office. */
export const OFFICE_TEL_HREF = `tel:${OFFICE_TEL_E164}`
