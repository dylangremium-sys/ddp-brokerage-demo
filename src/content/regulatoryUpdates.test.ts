import { describe, expect, it } from 'vitest'

import { parseEntry, ContentError, ALLOWED_FIELDS, DEFAULT_REVIEWER, regulatoryEntries } from './regulatoryEntries'
import { renderMarkdown } from './markdown'
import { findLeaks, canaryPatternNames } from './leakCanary'
import { parseFrontmatter, FrontmatterError } from './frontmatter'
import { isIndexable, metadataForPage } from '../lib/publicPageMetadata'
import { getInitialPageFromPath, pathForPage } from '../lib/urlRouting'
import { PUBLIC_PAGES } from '../lib/navigationGuard'

const VALID = `---
title: Thai licence sunset
description: What the sunset means for licensed producers supplying into the EU, and which documents change.
published: 2026-08-14
lastVerified: 2026-08-20
reviewer: A. Reviewer, Compliance Lead
---

## Heading

Body text with **emphasis** and a [link](/about).
`

const entry = (source = VALID, path = '/content/regulatory/2026-08-thai-licence-sunset.md') =>
  parseEntry(path, source)

describe('publishing an entry is adding a file', () => {
  it('derives a dated URL from the filename', () => {
    expect(entry().canonicalPath).toBe('/regulatory-updates/2026-08-thai-licence-sunset')
  })

  it('carries the authored dates and reviewer through', () => {
    const e = entry()
    expect(e.published).toBe('2026-08-14')
    expect(e.lastVerified).toBe('2026-08-20')
    expect(e.reviewer).toBe('A. Reviewer, Compliance Lead')
  })

  /**
   * A named individual carries more weight on regulatory content than a team
   * does, but an entry that names nobody must still say who stands behind it.
   */
  it('falls back to the team when no individual is named', () => {
    expect(entry(VALID.replace('reviewer: A. Reviewer, Compliance Lead\n', '')).reviewer).toBe(
      DEFAULT_REVIEWER,
    )
  })

  it('treats an unedited entry as updated on its publication date', () => {
    expect(entry().updated).toBe('2026-08-14')
  })
})

describe('the schema is the boundary, expressed as fields', () => {
  /**
   * There is no field for a supplier, a licence, a counterparty, a batch or a
   * COA — so an internal record has nowhere to be written. An unknown key is a
   * build failure, never something carried along unread.
   */
  it('allows only the declared fields', () => {
    expect([...ALLOWED_FIELDS]).toEqual([
      'title', 'description', 'published', 'updated', 'lastVerified', 'reviewer',
    ])
  })

  it('rejects a field that could hold an internal record', () => {
    expect(() => entry(VALID.replace('reviewer:', 'supplierLicence:'))).toThrow(
      /not an allowed field/,
    )
  })

  it('rejects nesting, which is where a structure nobody validated would live', () => {
    expect(() => parseFrontmatter('---\ntitle: x\n  nested: y\n---\nbody\n', ALLOWED_FIELDS)).toThrow(
      FrontmatterError,
    )
  })

  it('rejects a duplicated key rather than silently taking one', () => {
    expect(() => parseFrontmatter('---\ntitle: a\ntitle: b\n---\nbody\n', ALLOWED_FIELDS)).toThrow(
      /appears twice/,
    )
  })
})

describe('the leak canary', () => {
  it('checks the shapes it claims to', () => {
    expect(canaryPatternNames()).toContain('batch-id')
    expect(canaryPatternNames()).toContain('uuid')
    expect(canaryPatternNames()).toContain('internal-table-name')
  })

  it.each([
    ['batch id', 'supply from batch F4-122025 was reviewed'],
    ['uuid', 'record 3f2504e0-4f89-11d3-9a0c-0305e82c3301'],
    ['internal table', 'see watchtower_ingestion_items for detail'],
    ['counterparty address', 'contact buyer@example.com for terms'],
    ['coordinates', 'the site at 18.7883, 98.9853'],
  ])('catches a %s', (_label, text) => {
    expect(findLeaks(text).length).toBeGreaterThan(0)
  })

  it('scans field values, not only the body — a title is just as public', () => {
    expect(() => entry(VALID.replace('Thai licence sunset', 'Batch F4-122025 review'))).toThrow(
      /internal data/,
    )
  })

  it('leaves ordinary regulatory prose alone', () => {
    expect(findLeaks('Total THC must be calculated from THCA using the 0.877 factor.')).toEqual([])
  })

  /**
   * A shared /g regex carries lastIndex between calls and silently skips
   * matches on the second document scanned — which would mean the canary
   * checked the first entry of a build and waved the rest through.
   */
  it('does not go blind on the second document it scans', () => {
    const text = 'batch F4-122025'
    expect(findLeaks(text).length).toBe(findLeaks(text).length)
    expect(findLeaks(text).length).toBeGreaterThan(0)
  })
})

describe('markdown cannot inject markup', () => {
  it('escapes HTML in the source rather than passing it through', () => {
    const html = renderMarkdown('<script>alert(1)</script>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('refuses a javascript: link, leaving the literal text visible', () => {
    const html = renderMarkdown('[click](javascript:alert(1))')
    expect(html).not.toContain('href="javascript')
    expect(html).toContain('[click]')
  })

  it('refuses a data: URL', () => {
    expect(renderMarkdown('[x](data:text/html,<script>)')).not.toContain('href="data:')
  })

  it('allows an ordinary https link and a site-relative one', () => {
    expect(renderMarkdown('[a](https://example.com)')).toContain('<a href="https://example.com">')
    expect(renderMarkdown('[b](/about)')).toContain('<a href="/about">')
  })

  /** The page supplies the single <h1>; a body that emitted one would make two. */
  it('starts headings at h2', () => {
    expect(renderMarkdown('## Two\n\n### Three')).toBe('<h2>Two</h2>\n<h3>Three</h3>')
  })
})

describe('dates are checked against each other, not just for shape', () => {
  it('rejects a published date outside the month the URL claims', () => {
    expect(() => entry(VALID.replace('published: 2026-08-14', 'published: 2026-07-14'))).toThrow(
      /not in the month named/,
    )
  })

  it('rejects verification dated before publication', () => {
    expect(() => entry(VALID.replace('lastVerified: 2026-08-20', 'lastVerified: 2026-08-01'))).toThrow(
      /before/,
    )
  })

  it('rejects a date that is not a real calendar date', () => {
    expect(() => entry(VALID.replace('published: 2026-08-14', 'published: 2026-08-32'))).toThrow(
      ContentError,
    )
  })

  it('rejects a description longer than a result snippet shows', () => {
    expect(() => entry(VALID.replace(/description: .*/, `description: ${'x'.repeat(161)}`))).toThrow(
      /160/,
    )
  })
})

describe('the hub and its routes', () => {
  it('cold-loads the hub, trailing slash or not', () => {
    expect(getInitialPageFromPath('/regulatory-updates')).toBe('regulatory-hub')
    expect(getInitialPageFromPath('/regulatory-updates/')).toBe('regulatory-hub')
    expect(pathForPage('regulatory-hub')).toBe('/regulatory-updates')
  })

  it('routes any single segment under the hub to an entry', () => {
    expect(getInitialPageFromPath('/regulatory-updates/2026-08-anything')).toBe('regulatory-entry')
  })

  it('does not route a deeper path, which is not an entry shape', () => {
    expect(getInitialPageFromPath('/regulatory-updates/a/b')).toBeNull()
  })

  it('admits a signed-out visitor to both', () => {
    expect(PUBLIC_PAGES).toContain('regulatory-hub')
    expect(PUBLIC_PAGES).toContain('regulatory-entry')
  })

  /**
   * THE RULE THAT HAS TO CHANGE WHEN THE FIRST ENTRY LANDS.
   *
   * A hub listing nothing is a thin page, and publishing one spends crawl
   * attention on a promise. So the hub is indexable if and only if there is
   * something to list — and the day an entry is added this fails, which is the
   * reminder to flip the register rather than leave it noindexed by inertia.
   */
  it('is indexable if and only if at least one entry is published', () => {
    expect(isIndexable('regulatory-hub')).toBe(regulatoryEntries().length > 0)
  })

  it('publishes a title and a snippet-length description', () => {
    const meta = metadataForPage('regulatory-hub')
    expect(meta.title.length).toBeGreaterThan(10)
    expect(meta.description.length).toBeLessThanOrEqual(160)
  })
})
