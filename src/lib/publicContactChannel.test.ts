import { describe, expect, it } from 'vitest'
import { T } from '../translations'

/**
 * W0.2 — every published contact address sat on a domain that does not exist.
 *
 * `info@ddp-brokerage.com` and `partnerships@ddp-brokerage.com` were rendered in
 * both language footers (LandingPage.tsx:439-440) as `mailto:` links, and shipped
 * four times in the production bundle. The hyphenated domain is NXDOMAIN at the
 * system resolver, 8.8.8.8 and 1.1.1.1, and `whois` returns "No match for domain":
 * no A, no MX, no NS. The live site is `ddpbrokerage.com` — no hyphen — which does
 * have MX (mx1/mx2.privateemail.com).
 *
 * The consequence was not cosmetic. The hero CTA "Request a Consultation" is the
 * primary buyer funnel, and it terminated in a bounce that DDP never saw. The
 * second-order risk is worse: an unregistered domain is registrable by anyone for
 * about ten dollars, and whoever registered it would receive DDP's inbound buyer
 * correspondence.
 *
 * This guard asserts the exported values rather than the source text, so it holds
 * however the constants are authored, and it scans EVERY string in both language
 * trees rather than only the two keys that were wrong — a third contact address
 * added later must not be able to reintroduce the defect.
 *
 * It is deliberately offline. Whether a mailbox actually receives is a live-mail
 * question that belongs in the W0.2 acceptance test, not in a unit suite that has
 * to pass in CI without network.
 */

/** The only domain DDP publishes. Registered, live, and holding MX records. */
const CANONICAL_DOMAIN = 'ddpbrokerage.com'

/** Registered defensively; must never appear in a published address. */
const DEAD_DOMAIN = 'ddp-brokerage.com'

/**
 * Domains RFC 2606 reserves for documentation and examples. Mail to them cannot
 * be delivered anywhere, by design, which is exactly what a form placeholder
 * wants — `emailOptionalPlaceholder` is `you@example.com` and is correct.
 *
 * A placeholder on a domain someone else owns would quietly route a mistyped
 * address to a stranger, so the rule is not "ignore placeholders" but "a
 * placeholder must be on a reserved domain".
 */
const RESERVED_EXAMPLE_DOMAINS = ['example.com', 'example.net', 'example.org']

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

const isPlaceholder = (address: string) =>
  RESERVED_EXAMPLE_DOMAINS.some((domain) => address.toLowerCase().endsWith(`@${domain}`))

function stringsOf(tree: Record<string, unknown>): Array<[string, string]> {
  return Object.entries(tree).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
}

/** Every address the product actually publishes, i.e. excluding placeholders. */
function publishedAddresses(tree: Record<string, unknown>): Array<[string, string]> {
  return stringsOf(tree).flatMap(([key, value]) =>
    (value.match(EMAIL) ?? []).filter((a) => !isPlaceholder(a)).map((a): [string, string] => [key, a]),
  )
}

const LANGUAGES = Object.entries(T) as Array<[string, Record<string, unknown>]>

describe('published contact channels', () => {
  it('covers every language tree, so neither can drift unchecked', () => {
    expect(LANGUAGES.map(([lang]) => lang).sort()).toEqual(['en', 'th'])
  })

  for (const [lang, tree] of LANGUAGES) {
    it(`[${lang}] every published email address is on ${CANONICAL_DOMAIN}`, () => {
      const offenders = publishedAddresses(tree)
        .filter(([, address]) => !address.toLowerCase().endsWith(`@${CANONICAL_DOMAIN}`))
        .map(([key, address]) => `${key}: ${address}`)
      expect(offenders).toEqual([])
    })

    it(`[${lang}] any placeholder address is on a reserved example domain`, () => {
      const offenders = stringsOf(tree)
        .flatMap(([key, value]) => (value.match(EMAIL) ?? []).map((address): [string, string] => [key, address]))
        .filter(([, address]) => !address.toLowerCase().endsWith(`@${CANONICAL_DOMAIN}`) && !isPlaceholder(address))
        .map(([key, address]) => `${key}: ${address}`)
      expect(offenders).toEqual([])
    })

    it(`[${lang}] the dead ${DEAD_DOMAIN} domain appears nowhere`, () => {
      const offenders = stringsOf(tree)
        .filter(([, value]) => value.includes(DEAD_DOMAIN))
        .map(([key, value]) => `${key}: ${value}`)
      expect(offenders).toEqual([])
    })
  }

  it('still publishes at least one contact address — the fix must not be a deletion', () => {
    const addresses = LANGUAGES.flatMap(([, tree]) => publishedAddresses(tree))
    expect(addresses.length).toBeGreaterThan(0)
  })

  it('publishes the same addresses in both languages', () => {
    const [[, en], [, th]] = LANGUAGES
    const addressesIn = (tree: Record<string, unknown>) =>
      [...new Set(publishedAddresses(tree).map(([, address]) => address))].sort()
    expect(addressesIn(en)).toEqual(addressesIn(th))
  })
})
