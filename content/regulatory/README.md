# Regulatory update entries

One markdown file per published update. Adding a file publishes a page: a dated
URL, a sitemap entry and a listing on the hub. No route map is edited.

    content/regulatory/YYYY-MM-slug.md   ->   /regulatory-updates/YYYY-MM-slug

## Frontmatter

    ---
    title: Thai licence sunset
    description: Up to 160 characters. This is the result snippet.
    published: 2026-08-14
    updated: 2026-08-20        # optional; defaults to `published`
    lastVerified: 2026-08-20
    reviewer: A. Reviewer, Compliance Lead   # optional; defaults to the team
    ---

Those are the ONLY allowed fields. An unknown key fails the build, deliberately:
there is no field a supplier licence, a counterparty or a batch id could be
written into, so an internal record has nowhere to go.

The build also refuses an entry whose text merely LOOKS like internal data —
UUIDs, batch ids, non-company email addresses, internal table names,
coordinates. If a match is genuinely innocent, reword it. Do not add an
exception; see src/content/leakCanary.ts.

## What the dates mean

`lastVerified` is the date a person last confirmed the entry is still true, and
it is what the sitemap publishes and what a reader sees. On regulatory content
"still true as of" is the claim that matters, not "written on".

## Markdown

`##`/`###` headings, paragraphs, lists, `**bold**`, `` `code` `` and links.
Input is escaped before it is formatted, so raw HTML in a file appears as the
characters you typed — it cannot become markup on a public page.
