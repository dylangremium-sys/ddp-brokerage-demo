#!/usr/bin/env node
// ─── Write the prerendered public documents into dist/ ──────────────────────
//
// Runs after `vite build`. It is the only part of the prerender that touches
// the filesystem; the decisions live in src/lib/prerenderDocument.ts (what a
// document contains) and src/prerender/entry.tsx (which routes exist), both of
// which are pure and unit-tested without a build.
//
// WHY THIS IS SAFE TO ADD TO AN EXISTING SPA BUILD
//   Vercel resolves static files BEFORE `vercel.json` rewrites. Writing
//   dist/about/index.html therefore takes /about away from the
//   `/((?!api/).*) -> /index.html` rewrite without changing the rewrite, and
//   every path that still has no file keeps falling through to the SPA shell
//   exactly as before. This is the same mechanism that makes public/robots.txt
//   work, which crawlPolicyFiles.test.ts already asserts.
//
// THE FAILURE THIS SCRIPT CANNOT PREVENT
//   If the Vercel project's Build Command is set to `vite build` rather than
//   `npm run build`, this step never runs in production and the deployment is
//   byte-identical to the defect it fixes — with a green build and a green
//   test suite. vercel.json sets no buildCommand, so that setting is in the
//   dashboard, outside this repo. The post-deploy check is therefore not
//   optional:
//
//       curl -s https://www.ddpbrokerage.com/about | grep -c "<h1"    # want 1
//
//   A 0 there means the build command, not this script.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(REPO_ROOT, 'dist')
const SSR_ENTRY = join(REPO_ROOT, 'dist-ssr', 'entry.js')
const SHELL = join(DIST, 'index.html')

function fail(message) {
  console.error(`\nprerender: ${message}\n`)
  process.exit(1)
}

if (!existsSync(SHELL)) {
  fail(`no build output at ${SHELL}. Run \`vite build\` first — this step rewrites its output, it does not replace it.`)
}
if (!existsSync(SSR_ENTRY)) {
  fail(`no render bundle at ${SSR_ENTRY}. It is produced by the \`prerender\` script in package.json, before this one runs.`)
}

const {
  renderPublicRoutes,
  renderRegulatoryEntryRoutes,
  renderRegulatoryFeed,
  FEED_PATH,
  buildPrerenderedDocument,
  outputPathFor,
  targetForPage,
  buildSitemapXml,
  sitemapEntries,
  indexablePages,
} = await import(pathToFileURL(SSR_ENTRY).href)


// Read once. Every document is built from the SAME built shell, so all of them
// carry the same hashed script and stylesheet the SPA would have loaded.
const shellHtml = readFileSync(SHELL, 'utf8')

const routes = renderPublicRoutes()
if (routes.length === 0) fail('the render entry produced no routes')

const digests = new Map()

// ─── inline styles the CSP will refuse ──────────────────────────────────────
//
// `style-src` on the live site is `'self' https://fonts.googleapis.com` with no
// `'unsafe-inline'`, so a `style` attribute in a prerendered document is
// blocked by the browser and its styling never applies. Measured 2026-08-12:
// six `style` props on the landing page were dead on `/`, `/de-buyer`,
// `/cs-buyer` and `/thai-supplier` from the moment they shipped in 05e042d.
//
// Nothing signalled it. The build passed, the page returned 200 and rendered,
// and the only trace was a console error on a page no build step opens. A
// `style` prop is also the most natural thing in the world to write — it works
// in dev, and it works on every client-rendered screen in this app, because
// React sets those values through the DOM where CSP does not police them. It
// is dead HERE and only here, which is exactly why it needs a build-time check
// rather than a convention.
//
// Reported all at once: told "fix this one", the natural next commit adds the
// second, and so on.
const inlineStyled = []
function collectInlineStyles(label, document) {
  for (const match of document.matchAll(/<([a-zA-Z][\w-]*)\b[^>]*?\sstyle="([^"]*)"/g)) {
    inlineStyled.push(`${label}: <${match[1]} style="${match[2]}">`)
  }
}

for (const { page, bodyHtml, feedUrl } of routes) {
  const target = targetForPage(page, feedUrl ? { feedUrl } : {})
  const relativePath = outputPathFor(target.metadata.canonicalPath)
  const absolutePath = join(DIST, relativePath)
  const document = buildPrerenderedDocument(shellHtml, target, bodyHtml)

  mkdirSync(dirname(absolutePath), { recursive: true })
  writeFileSync(absolutePath, document, 'utf8')
  collectInlineStyles(relativePath, document)

  const digest = createHash('md5').update(document).digest('hex')
  digests.set(relativePath, digest)

  const headings = (bodyHtml.match(/<h1\b/g) ?? []).length
  console.log(
    `prerender: ${relativePath.padEnd(20)} ${String(document.length).padStart(7)} bytes  h1=${headings}  ${digest.slice(0, 8)}`,
  )
}

// The defect being fixed was five URLs serving one byte-identical document.
// Identical output here would mean the fix silently did nothing, so it is an
// error rather than a warning.
const unique = new Set(digests.values())
if (unique.size !== digests.size) {
  fail(
    `prerendered documents are not distinct (${unique.size} unique of ${digests.size}) — ` +
      'this is the duplicate-document defect the step exists to remove',
  )
}

// ─── content-derived documents ──────────────────────────────────────────────
//
// These carry a target rather than a Page. Publishing an entry is adding a
// markdown file; nothing here or in any route map is edited to make it appear.
const contentRoutes = renderRegulatoryEntryRoutes()

for (const { label, target, bodyHtml } of contentRoutes) {
  const relativePath = outputPathFor(target.metadata.canonicalPath)
  const absolutePath = join(DIST, relativePath)
  const document = buildPrerenderedDocument(shellHtml, target, bodyHtml)

  mkdirSync(dirname(absolutePath), { recursive: true })
  writeFileSync(absolutePath, document, 'utf8')
  collectInlineStyles(relativePath, document)

  const digest = createHash('md5').update(document).digest('hex')
  digests.set(relativePath, digest)

  console.log(
    `entry:     ${relativePath.padEnd(46)} ${String(document.length).padStart(6)} bytes  ${digest.slice(0, 8)}  ${label}`,
  )
}

if (inlineStyled.length > 0) {
  fail(
    `${inlineStyled.length} inline style attribute(s) in prerendered documents — the CSP ` +
      'refuses every one of them, so this styling does not apply on the live site:\n  ' +
      inlineStyled.join('\n  ') +
      '\nMove the declarations into a class. See the note beside .hp-form-step in ' +
      'src/styles/publicHome.css.',
  )
}

// ─── the feed ───────────────────────────────────────────────────────────────
//
// Built from the same entries as the documents above. An entry appears here
// because it exists, not because anyone remembered to add it.
const feedPath = join(DIST, FEED_PATH.replace(/^\//, ''))
const feed = renderRegulatoryFeed()
mkdirSync(dirname(feedPath), { recursive: true })
writeFileSync(feedPath, feed, 'utf8')
console.log(
  `feed:      ${FEED_PATH.padEnd(46)} ${String(feed.length).padStart(6)} bytes  ${(feed.match(/<item>/g) ?? []).length} items`,
)

console.log(`prerender: ${digests.size} documents written, all distinct`)

// ─── sitemap.xml, from the same route list ──────────────────────────────────
//
// Written here rather than kept as a static file in public/ so that a URL
// cannot be advertised without a document existing to serve it: both come from
// `renderPublicRoutes()` above. Vercel serves this from dist/ exactly as it
// served the old public/ copy — static output, ahead of the SPA rewrite.

const indexable = indexablePages()

// Every advertised page must be one this run actually wrote a document for.
// Without this, adding a page to the register would publish a URL that Vercel
// resolves through the SPA rewrite to the landing document — indistinguishable
// from success from the outside.
const written = new Set(routes.map(({ page }) => page))
const undocumented = indexable.filter((page) => !written.has(page))
if (undocumented.length > 0) {
  fail(
    `these pages are approved for indexing but no document was rendered for them: ${undocumented.join(', ')}. ` +
      'Add them to renderPublicRoutes() in src/prerender/entry.tsx.',
  )
}

const entries = sitemapEntries()
const sitemapPath = join(DIST, 'sitemap.xml')
writeFileSync(sitemapPath, buildSitemapXml(entries), 'utf8')

for (const entry of entries) {
  console.log(`sitemap:   ${entry.loc.padEnd(40)} ${entry.lastmod ?? '(no lastmod)'}`)
}
console.log(`sitemap:   ${entries.length} URLs written to dist/sitemap.xml`)
