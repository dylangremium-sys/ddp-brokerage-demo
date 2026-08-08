#!/usr/bin/env node
// ─── Post-deploy check: does production actually serve prerendered documents ──
//
// WHY THIS CANNOT BE A UNIT TEST
//   Everything about the prerender is asserted offline — the document builder
//   in src/lib/prerenderDocument.test.ts, the rendered routes in
//   src/prerender/prerenderRoutes.test.ts, the crawl-policy files in
//   src/lib/crawlPolicyFiles.test.ts. All of it can be green while production
//   serves the original defect, because two things stand between this repo and
//   the deployed bytes and neither is in it:
//
//     1. THE BUILD COMMAND. `vercel.json` sets no `buildCommand`, so the
//        Vercel dashboard decides. If it is `vite build` rather than
//        `npm run build`, the prerender step never runs and the deployment is
//        byte-identical to the defect, with a green build and a green suite.
//
//     2. HOW VERCEL RESOLVES A DIRECTORY INDEX. The prerender writes
//        dist/about/index.html and relies on `/about` resolving to it from the
//        filesystem, ahead of the `/((?!api/).*)` rewrite. That is the same
//        ordering public/robots.txt already depends on, and it is standard
//        static-hosting behaviour — but it is the host's behaviour, not this
//        repo's, so it is asserted against the host.
//
//   Run it against production after a deploy:
//
//       node scripts/verify-prerender-deployed.mjs
//       node scripts/verify-prerender-deployed.mjs https://some-preview.vercel.app
//
// WHAT A FAILURE MEANS
//   Distinct documents but no <h1>  -> the build command is not `npm run build`
//   Identical documents             -> the same, or the deploy has not landed
//   404 on a corporate page         -> directory-index resolution, see (2)

/** The origin to FETCH from. May be a preview deployment or a local server. */
const origin = (process.argv[2] ?? 'https://www.ddpbrokerage.com').replace(/\/$/, '')

/**
 * The origin the documents must CLAIM, which is not the same thing.
 *
 * publicPageMetadata.ts hardcodes the production host, so a preview deployment
 * canonicalises to production on purpose — that is what stops a preview URL
 * from competing with the real page in an index. Asserting the canonical
 * against `origin` would therefore fail every run that is not production, and
 * would have been a check that only ever passed where it was least needed.
 */
const CANONICAL_ORIGIN = 'https://www.ddpbrokerage.com'

/** Path -> the exact canonical URL its document must claim. */
const EXPECTED = new Map([
  ['/', `${CANONICAL_ORIGIN}/`],
  ['/about', `${CANONICAL_ORIGIN}/about`],
  ['/contact', `${CANONICAL_ORIGIN}/contact`],
  ['/privacy', `${CANONICAL_ORIGIN}/privacy`],
  ['/terms', `${CANONICAL_ORIGIN}/terms`],
])

const failures = []
const digests = new Map()

for (const [path, canonical] of EXPECTED) {
  const url = `${origin}${path}`
  let response
  let body = ''

  try {
    // No browser, no JavaScript — deliberately. This is the client the fix is
    // for: the crawlers and unfurlers that never execute a bundle.
    response = await fetch(url, { headers: { 'user-agent': 'ddp-prerender-check' } })
    body = await response.text()
  } catch (error) {
    failures.push(`${path}: request failed — ${error.message}`)
    continue
  }

  const headings = (body.match(/<h1[\s>]/g) ?? []).length
  const claimed = body.match(/<link rel="canonical" href="([^"]*)"/)?.[1]
  const title = body.match(/<title>([^<]*)<\/title>/)?.[1] ?? '(none)'

  digests.set(path, body.length + ':' + title)

  if (response.status !== 200) failures.push(`${path}: HTTP ${response.status}`)
  if (headings !== 1) failures.push(`${path}: expected exactly one <h1>, found ${headings}`)
  if (claimed !== canonical) failures.push(`${path}: canonical is ${claimed ?? '(none)'}, want ${canonical}`)

  console.log(
    `${path.padEnd(10)} ${String(response.status)}  ${String(body.length).padStart(6)} bytes  h1=${headings}  ${title}`,
  )
}

// The measured defect: five URLs, one byte-identical document.
if (new Set(digests.values()).size !== digests.size) {
  failures.push('the public URLs are still serving the same document as each other')
}

// /farmer must stay excluded, and now says so in its own served bytes.
try {
  const farmer = await fetch(`${origin}/farmer`)
  const body = await farmer.text()
  const header = farmer.headers.get('x-robots-tag') ?? ''

  if (!/noindex/i.test(header)) failures.push(`/farmer: X-Robots-Tag is "${header}", want noindex`)
  if (!/name="robots" content="noindex/.test(body)) {
    failures.push('/farmer: served bytes carry no noindex meta tag')
  }
  console.log(`/farmer    ${farmer.status}  header="${header}"  meta-noindex=${/name="robots" content="noindex/.test(body)}`)
} catch (error) {
  failures.push(`/farmer: request failed — ${error.message}`)
}

// ─── the crawl-policy files ─────────────────────────────────────────────────
//
// sitemap.xml is generated at build time rather than kept in public/, so it is
// the file most exposed to a build step that did not run: nothing is left
// behind, and /sitemap.xml goes back to returning the SPA shell with a 200.
// A 200 is exactly the trap — a crawler handed HTML where XML belongs does not
// retry and does not warn.
for (const [path, wantType, wantContent] of [
  ['/sitemap.xml', /xml/, '<urlset'],
  ['/robots.txt', /text\/plain/, 'Sitemap:'],
]) {
  try {
    const response = await fetch(`${origin}${path}`)
    const type = response.headers.get('content-type') ?? ''
    const body = await response.text()

    if (response.status !== 200) failures.push(`${path}: HTTP ${response.status}`)
    if (!wantType.test(type)) {
      failures.push(`${path}: content-type is "${type}" — the SPA shell is being served in its place`)
    }
    if (!body.includes(wantContent)) failures.push(`${path}: body does not contain "${wantContent}"`)

    if (path === '/sitemap.xml') {
      const locs = [...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim())
      const wanted = [...EXPECTED.values()]

      const missing = wanted.filter((url) => !locs.includes(url))
      if (missing.length > 0) failures.push(`/sitemap.xml: missing ${missing.join(', ')}`)

      const extra = locs.filter((url) => !wanted.includes(url))
      if (extra.length > 0) failures.push(`/sitemap.xml: advertises unapproved URLs ${extra.join(', ')}`)

      // Test the <loc> values, NOT the raw body. The generated file explains in
      // prose that farmer onboarding is out of scope by policy, and a naive
      // scan for "farmer" matches that sentence — failing on the documentation
      // of the rule it is checking. The same trap crawlPolicyFiles.test.ts
      // records for `rel="canonical"`.
      const excluded = locs.filter((url) =>
        /\/(farmer|admin|api|login|set-password|forgot-password)/i.test(url),
      )
      if (excluded.length > 0) {
        failures.push(`/sitemap.xml: advertises excluded paths ${excluded.join(', ')}`)
      }

      // Dates are all-or-nothing by construction. A partial set means something
      // wrote this file that was not the generator.
      const dates = [...body.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map((m) => m[1])
      if (dates.length > 0 && dates.length !== locs.length) {
        failures.push(`/sitemap.xml: ${dates.length} lastmod for ${locs.length} URLs — must be all or none`)
      }
      const malformed = dates.filter((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d))
      if (malformed.length > 0) failures.push(`/sitemap.xml: malformed lastmod ${malformed.join(', ')}`)

      console.log(
        `/sitemap.xml  ${response.status}  ${locs.length} URLs  ${dates.length ? `lastmod ${[...new Set(dates)].join(',')}` : 'no lastmod'}`,
      )
    } else {
      console.log(`/robots.txt   ${response.status}  ${type}`)
    }
  } catch (error) {
    failures.push(`${path}: request failed — ${error.message}`)
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} problem(s) against ${origin}:`)
  for (const failure of failures) console.error(`  ✗ ${failure}`)
  console.error('')
  process.exit(1)
}

console.log(`\n✓ ${origin} serves a distinct, readable document for every public URL`)
