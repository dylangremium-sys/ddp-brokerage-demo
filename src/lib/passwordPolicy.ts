// ─── New-password policy (pure) ─────────────────────────────────────────────
//
// Validated on the client so the user is told what is wrong before a round
// trip, and so the two fields are compared at all — Supabase never sees the
// confirmation field and cannot check it.
//
// This is a usability gate, not a security boundary: the authoritative minimum
// lives in the Supabase project's auth settings. Keeping the client minimum at
// or above the server's means a password accepted here is never rejected there.

/**
 * Minimum length. Deliberately above Supabase's default of 6: these accounts
 * hold supplier inventory, farm profiles and buyer-pack evidence.
 */
export const MIN_PASSWORD_LENGTH = 10

/**
 * Maximum length, in BYTES not characters.
 *
 * bcrypt — which Supabase (GoTrue) uses — hashes only the first 72 bytes and
 * ignores the rest. A Thai passphrase costs 3 bytes per character, so a
 * perfectly reasonable 25-character Thai password silently overflows and the
 * user ends up with a password whose tail does nothing. Refusing it is honest;
 * truncating it is not.
 */
export const MAX_PASSWORD_BYTES = 72

export type PasswordRejection =
  | 'empty'
  | 'too-short'
  | 'too-long'
  | 'no-letter'
  | 'no-number'
  | 'mismatch'

export type PasswordCheck =
  | { ok: true }
  | { ok: false; reason: PasswordRejection }

/** UTF-8 byte length — the unit bcrypt actually counts. */
export function passwordByteLength(password: string): number {
  return new TextEncoder().encode(password).length
}

/**
 * Whether this password may be set, and if not, why.
 *
 * The order of the checks is the order the messages should appear in: the user
 * is told the password itself is unusable before being told the confirmation
 * does not match it, so they never fix the second problem only to hit the
 * first.
 */
export function validateNewPassword(password: string, confirm: string): PasswordCheck {
  if (!password) return { ok: false, reason: 'empty' }
  // Count code points, not UTF-16 units: an emoji or an astral character is one
  // character to the user, and [...s].length agrees with them where .length does not.
  if ([...password].length < MIN_PASSWORD_LENGTH) return { ok: false, reason: 'too-short' }
  if (passwordByteLength(password) > MAX_PASSWORD_BYTES) return { ok: false, reason: 'too-long' }
  // \p{L} rather than [a-zA-Z]: a Thai password is not "letterless".
  if (!/\p{L}/u.test(password)) return { ok: false, reason: 'no-letter' }
  if (!/\p{Nd}/u.test(password)) return { ok: false, reason: 'no-number' }
  if (password !== confirm) return { ok: false, reason: 'mismatch' }
  return { ok: true }
}
