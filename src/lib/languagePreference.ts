import type { Lang } from '../types'

/**
 * Which language the interface opens in, and remembering the answer.
 *
 * P1 / W10.3 — Thai was unreachable on the farmer's primary entry path.
 *
 * A Thai farm arrives by scanning a QR code, which cold-loads `/farmer`
 * (`farmer-register`). That page is public, so the navbar — the only place the
 * language toggle rendered — is not drawn at all; and the toggle was inside an
 * `isDemo ?` branch, so in production it never rendered anywhere. `lang` then
 * initialised to a hardcoded `'en'` on every load and was never persisted, so
 * even a farmer who found the landing page's own toggle lost the choice on the
 * next navigation.
 *
 * The product ships 498 Thai keys at exact parity with English. All of them
 * were unreachable to the people they were written for.
 *
 * Everything here takes its inputs explicitly so the decision can be tested
 * without a DOM — this repository's vitest environment is `node`.
 */

const STORAGE_KEY = 'ddp.lang'

const SUPPORTED: readonly Lang[] = ['en', 'th']

/** English unless something says otherwise — the safe default for an operator. */
export const FALLBACK_LANGUAGE: Lang = 'en'

export function isSupportedLanguage(value: unknown): value is Lang {
  return typeof value === 'string' && (SUPPORTED as readonly string[]).includes(value)
}

/**
 * The first supported language among the browser's preferences.
 *
 * Matches on the primary subtag, so `th-TH` selects Thai — a Thai phone reports
 * a region and matching the whole string would never hit.
 */
export function detectLanguage(preferences?: readonly string[]): Lang | null {
  for (const preference of preferences ?? []) {
    const primary = preference.split('-')[0]?.toLowerCase()
    if (isSupportedLanguage(primary)) return primary
  }
  return null
}

/** Storage can throw (Safari private mode, disabled cookies); never let it break boot. */
function safeStorage(): Storage | null {
  try {
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage
  } catch {
    return null
  }
}

export function readStoredLanguage(storage: Storage | null = safeStorage()): Lang | null {
  try {
    const stored = storage?.getItem(STORAGE_KEY)
    return isSupportedLanguage(stored) ? stored : null
  } catch {
    return null
  }
}

export function storeLanguage(lang: Lang, storage: Storage | null = safeStorage()): void {
  try {
    storage?.setItem(STORAGE_KEY, lang)
  } catch {
    // A preference that cannot be saved is not worth failing a render over.
  }
}

/**
 * What the app should open in.
 *
 * An explicit choice always wins over detection — someone who picked English on
 * a Thai handset meant it, and must not be overridden on every reload.
 */
export function initialLanguage(
  storage: Storage | null = safeStorage(),
  preferences: readonly string[] | undefined = typeof globalThis.navigator === 'undefined'
    ? undefined
    : globalThis.navigator.languages ?? [globalThis.navigator.language],
): Lang {
  return readStoredLanguage(storage) ?? detectLanguage(preferences) ?? FALLBACK_LANGUAGE
}
