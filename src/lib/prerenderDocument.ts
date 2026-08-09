// ─── Prerendered document builder ───────────────────────────────────────────
//
// WHAT THIS FIXES
//   Measured against production on 8 August 2026, every public URL on this site
//   returned the SAME 1,593-byte document — byte-identical, md5 04215a41…, for
//   `/`, `/about`, `/contact`, `/privacy` and `/terms` alike:
//
//       curl -s https://www.ddpbrokerage.com/about | grep -c "<h1"   ->  0
//       curl -sA "Googlebot/2.1 …" … | wc -c                        ->  1593
//
//   The Googlebot response was identical to the browser response, so nothing
//   was blocking anything — the shell simply IS the whole served document, and
//   `<div id="root"></div>` is all a crawler ever receives. The heading, the
//   copy and the per-page metadata that publicPageMetadata.ts writes all arrive
//   afterwards, from JavaScript, and only for a client that runs it.
//
//   Three consumers never run it, and all three matter here:
//     • the non-Google search crawlers (Bing, and every AI crawler — GPTBot,
//       ClaudeBot, PerplexityBot), which fetch and parse and do not come back;
//     • the link unfurlers behind LinkedIn, Slack and WhatsApp, which is why a
//       shared link renders bare;
//     • Google's own first pass, which defers JS rendering to a separate queue
//       that a domain with no authority does not get priority in.
//
//   So the five sitemap URLs were being offered to those consumers as five
//   copies of one empty page. That is not a ranking problem, it is a duplicate
//   -content problem, and it was true of the exact URLs sitemap.xml advertises.
//
// WHY A STRING BUILDER AND NOT A FRAMEWORK
//   The whole fix rests on one property of the host, and this repo already
//   depends on it elsewhere: VERCEL SERVES STATIC FILES BEFORE `rewrites`. That
//   is the documented reason `public/robots.txt` and `public/sitemap.xml` win
//   over the `/((?!api/).*) -> /index.html` rewrite instead of being swallowed
//   by it (see the comment at the head of public/robots.txt, and
//   crawlPolicyFiles.test.ts, which asserts it).
//
//   A real `dist/about/index.html` therefore wins over the rewrite by exactly
//   the same mechanism. No router, no framework migration and no `vercel.json`
//   change is required — the rewrite stays as the fallback for every path that
//   still has no file, which is what keeps unmapped paths rendering the landing
//   page the way the SPA already does.
//
// WHAT THIS MODULE IS AND IS NOT
//   It is pure: HTML in, HTML out, no filesystem and no DOM, so the whole
//   contract is testable in the repo's default `environment: 'node'` suite
//   without a build. scripts/prerender-public-routes.mjs is the thin part that
//   reads and writes files.
//
//   It PUBLISHES NO NEW WORDS. Every title, description and canonical path it
//   emits is read from publicPageMetadata.ts, and the body markup is rendered
//   from the page components already on `main`. There is no parameter through
//   which a caller could pass a string of its own — the same safety property
//   the register documents, extended to the prerendered output. Prerendering
//   changes WHEN the approved copy is available, never WHAT it says.

import type { Page } from '../types'
import { CANONICAL_ORIGIN, languageAlternatesFor, metadataForPage } from './publicPageMetadata'

/** Where a page's prerendered document is written, relative to `dist/`. */
export function outputPathForPage(page: Page): string {
  const { canonicalPath } = metadataForPage(page)
  // Derived from the register's own canonicalPath rather than a second list, so
  // a file can never be written to a path the canonical tag does not claim.
  // `/` is the SPA entry document Vite emits; everything else gets a directory
  // index, which is how Vercel resolves `/about` to `about/index.html`.
  return canonicalPath === '/' ? 'index.html' : `${canonicalPath.replace(/^\//, '')}/index.html`
}

/** Minimal HTML-attribute escaping for values that go inside `content="…"`. */
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Minimal escaping for text placed between tags. */
function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * The head tags this module owns, and therefore the ones it strips before
 * writing its own. Anything not listed here — charset, viewport, the favicon,
 * the font preconnects, and Vite's hashed script and stylesheet — is left
 * exactly as the build emitted it.
 */
const MANAGED_HEAD_PATTERNS: RegExp[] = [
  /<title\b[^>]*>[\s\S]*?<\/title>\s*/gi,
  /<meta\b[^>]*\bname=["']description["'][^>]*>\s*/gi,
  /<meta\b[^>]*\bname=["']robots["'][^>]*>\s*/gi,
  /<meta\b[^>]*\bproperty=["']og:[^"']*["'][^>]*>\s*/gi,
  /<meta\b[^>]*\bname=["']twitter:[^"']*["'][^>]*>\s*/gi,
  /<link\b[^>]*\brel=["']canonical["'][^>]*>\s*/gi,
  /<link\b[^>]*\brel=["']alternate["'][^>]*\bhreflang=[^>]*>\s*/gi,
]

/**
 * Builds the head block for `page` from the register, and nothing else.
 *
 * OPEN GRAPH IS DERIVED, NOT AUTHORED. og:title and og:description are the
 * register's own approved strings verbatim and og:url is the canonical URL, so
 * a link preview can state nothing the page does not already state. There is
 * deliberately no `og:image` (no approved asset exists) and deliberately no
 * JSON-LD: `Organization` schema asserts legal-entity facts — registered name,
 * address, affiliations — and what this company may assert about itself is a
 * decision for its officers, not a side effect of a rendering fix.
 */
export function buildHeadTags(page: Page): string {
  const meta = metadataForPage(page)
  const canonicalUrl = `${CANONICAL_ORIGIN}${meta.canonicalPath}`

  const tags = [
    `<title>${escapeText(meta.title)}</title>`,
    `<link rel="canonical" href="${escapeAttribute(canonicalUrl)}" />`,
    `<meta name="robots" content="${escapeAttribute(meta.robots)}" />`,
  ]

  // An empty description removes the tag rather than publishing an empty one —
  // the same rule applyPublicPageMetadata follows at runtime.
  if (meta.description) {
    tags.push(`<meta name="description" content="${escapeAttribute(meta.description)}" />`)
  }

  tags.push(
    `<meta property="og:type" content="website" />`,
    `<meta property="og:url" content="${escapeAttribute(canonicalUrl)}" />`,
    `<meta property="og:title" content="${escapeAttribute(meta.title)}" />`,
  )
  if (meta.description) {
    tags.push(`<meta property="og:description" content="${escapeAttribute(meta.description)}" />`)
  }
  tags.push(`<meta name="twitter:card" content="summary" />`)

  // Reciprocal by construction — languageAlternatesFor returns every member of
  // the translation group including this page, because a one-way hreflang is
  // ignored outright.
  for (const alternate of languageAlternatesFor(page)) {
    tags.push(
      `<link rel="alternate" hreflang="${escapeAttribute(alternate.hreflang)}" href="${escapeAttribute(alternate.href)}" />`,
    )
  }

  return tags.join('\n    ')
}

/**
 * Produces the document to write for `page`.
 *
 * `shellHtml` is the built `dist/index.html` — taken from the build output, not
 * from the source template, so Vite's hashed asset URLs come along unchanged
 * and the prerendered document loads exactly the bundle the SPA would.
 *
 * `bodyHtml` is the page rendered to static markup, or '' for a route that is
 * prerendered for its head alone (see the /farmer note in the entry module).
 */
export function buildPrerenderedDocument(shellHtml: string, page: Page, bodyHtml: string): string {
  if (!shellHtml.includes('<div id="root">')) {
    throw new Error(
      'shell HTML has no <div id="root"> to render into — the build output is not the SPA shell this expects',
    )
  }

  // Comments are stripped from the OUTPUT only. The decision records in the
  // source index.html stay where reviewers read them; there is no reason to
  // ship them to every visitor, and leaving them in would let a stale mention
  // of `<link rel="canonical">` inside a comment be matched as a real tag.
  let doc = shellHtml.replace(/<!--[\s\S]*?-->\s*/g, '')

  for (const pattern of MANAGED_HEAD_PATTERNS) {
    doc = doc.replace(pattern, '')
  }

  // The shell is built from index.html, which declares lang="en". A German
  // document that still claims English is not cosmetic: it is what a screen
  // reader uses to choose a voice and what a search engine uses to decide whose
  // results the page belongs in.
  const lang = metadataForPage(page).lang ?? 'en'
  doc = doc.replace(/<html\b[^>]*\blang=["'][^"']*["']/i, `<html lang="${escapeAttribute(lang)}"`)

  doc = doc.replace('</head>', `  ${buildHeadTags(page)}\n  </head>`)

  if (bodyHtml) {
    doc = doc.replace('<div id="root"></div>', `<div id="root">${bodyHtml}</div>`)
  }

  return doc
}
