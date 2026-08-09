import type { Page } from '../../types'
import { DDPMonogramLogo } from '../../components/logos'
import { pathForPage } from '../../lib/urlRouting'
import { shouldInterceptAnchorClick } from '../../lib/anchorNavigation'
import { metadataForPage } from '../../lib/publicPageMetadata'
import { regulatoryEntries, type RegulatoryEntry } from '../../content/regulatoryEntries'

/* ────────────────────────────────────────────────────────────────────────────
   /regulatory-updates — the hub, and /regulatory-updates/<slug> — one entry.

   WHY BOTH LIVE IN ONE FILE
     They share their chrome and, more importantly, they share how a date and a
     reviewer are displayed. Those two things are the credibility of a page
     about regulation, and two copies of them would eventually disagree.

   WHY THE DATES ARE VISIBLE, NOT JUST IN SCHEMA
     Structured data is for machines. A compliance officer deciding whether to
     trust a threshold needs to see, without clicking anything, when the entry
     was published, when it was last changed, when a person last confirmed it is
     still true, and who that person was. An entry whose dates live only in
     JSON-LD is asking to be trusted on the strength of markup nobody reads.

   WHAT THIS FILE MAY NOT DO
     Reach any internal data. It imports the content loader and nothing else
     that touches data; publishingBoundary.test.ts walks the import graph from
     the content modules and fails if a Supabase client, the services layer, an
     api/ function or watchtower code becomes reachable.
──────────────────────────────────────────────────────────────────────────── */

function InternalLink({
  target, onNavigate, className, children,
}: {
  target: Page
  onNavigate: (page: Page) => void
  className?: string
  children: React.ReactNode
}) {
  return (
    <a
      href={pathForPage(target)}
      className={className}
      onClick={(e) => { if (!shouldInterceptAnchorClick(e)) return; e.preventDefault(); onNavigate(target) }}
    >
      {children}
    </a>
  )
}

/** Shared chrome, so the hub and an entry cannot drift apart visually. */
function Shell({
  onNavigate, children,
}: {
  onNavigate: (page: Page) => void
  children: React.ReactNode
}) {
  return (
    <div className="corp-shell">
      <header className="corp-nav">
        <div className="corp-nav-inner">
          <InternalLink target="landing" onNavigate={onNavigate} className="corp-brand">
            <DDPMonogramLogo height={44} color="#C6A24C" />
            <span className="corp-brand-descriptor">Regulated Supply Intelligence</span>
          </InternalLink>
          <nav className="corp-nav-menu" aria-label="Regulatory updates">
            <InternalLink target="regulatory-hub" onNavigate={onNavigate} className="corp-nav-link">
              All updates
            </InternalLink>
            <InternalLink target="contact" onNavigate={onNavigate} className="corp-nav-link">Contact</InternalLink>
          </nav>
        </div>
      </header>

      <main className="corp-main" id="main">
        <article className="corp-doc">{children}</article>
      </main>

      <footer className="corp-footer">
        <div className="corp-footer-inner">
          <nav className="corp-footer-links" aria-label="Related pages">
            <InternalLink target="landing" onNavigate={onNavigate} className="corp-footer-link">Home</InternalLink>
            <InternalLink target="about" onNavigate={onNavigate} className="corp-footer-link">About</InternalLink>
            <InternalLink target="privacy" onNavigate={onNavigate} className="corp-footer-link">Privacy Policy</InternalLink>
            <InternalLink target="terms" onNavigate={onNavigate} className="corp-footer-link">Terms of Use</InternalLink>
          </nav>
          <p className="corp-copyright">© 2026 DDP Brokerage Co., Ltd. All rights reserved.</p>
        </div>
      </footer>
    </div>
  )
}

/**
 * The provenance block a reader actually looks at.
 *
 * Published, updated where it differs, last verified, and who verified it.
 * `updated` is shown only when it is not the publication date, because "updated
 * on the day it was published" is noise that makes the real updates harder to
 * notice.
 */
function EntryProvenance({ entry }: { entry: RegulatoryEntry }) {
  return (
    <p className="corp-provenance">
      <span>Published: <time dateTime={entry.published}>{entry.published}</time></span>
      {entry.updated !== entry.published && (
        <>
          <span className="corp-provenance-sep" aria-hidden="true">·</span>
          <span>Updated: <time dateTime={entry.updated}>{entry.updated}</time></span>
        </>
      )}
      <span className="corp-provenance-sep" aria-hidden="true">·</span>
      <span>Last verified: <strong><time dateTime={entry.lastVerified}>{entry.lastVerified}</time></strong></span>
      <span className="corp-provenance-sep" aria-hidden="true">·</span>
      <span>Reviewed by: <strong>{entry.reviewer}</strong></span>
    </p>
  )
}

/** The hub: every entry, newest first. */
export function RegulatoryHubPage({ onNavigate }: { onNavigate: (page: Page) => void }) {
  const entries = regulatoryEntries()

  return (
    <Shell onNavigate={onNavigate}>
      <h1 className="corp-heading">Regulatory updates</h1>

      <p className="corp-provenance">
        <span>Content owner: <strong>DDP Brokerage — Compliance &amp; Operations</strong></span>
        <span className="corp-provenance-sep" aria-hidden="true">·</span>
        <span>
          Last reviewed:{' '}
          <time dateTime={metadataForPage('regulatory-hub').lastReviewed}>
            {metadataForPage('regulatory-hub').lastReviewed}
          </time>
        </span>
      </p>

      <p>
        Notes on regulatory developments affecting licensed cannabis supply, published as they
        are reviewed. Each entry carries the date it was last verified and the reviewer
        responsible for it.
      </p>

      {entries.length === 0 ? (
        // Honest rather than decorative: an empty hub says so plainly instead of
        // implying activity that has not happened. It is also why the register
        // keeps this page out of search until the first entry exists.
        <p><em>No updates have been published yet.</em></p>
      ) : (
        <ol className="corp-entry-list">
          {entries.map((entry) => (
            <li key={entry.slug}>
              <h2>
                <a href={entry.canonicalPath}>{entry.title}</a>
              </h2>
              <p className="corp-provenance">
                <span><time dateTime={entry.published}>{entry.published}</time></span>
                <span className="corp-provenance-sep" aria-hidden="true">·</span>
                <span>Last verified: <time dateTime={entry.lastVerified}>{entry.lastVerified}</time></span>
              </p>
              <p>{entry.description}</p>
            </li>
          ))}
        </ol>
      )}
    </Shell>
  )
}

/** One entry. The body is already-rendered, already-escaped HTML. */
export function RegulatoryEntryPage({
  entry, onNavigate,
}: {
  entry: RegulatoryEntry
  onNavigate: (page: Page) => void
}) {
  return (
    <Shell onNavigate={onNavigate}>
      <h1 className="corp-heading">{entry.title}</h1>

      <EntryProvenance entry={entry} />

      {/* The body is produced by content/markdown.ts, which ESCAPES its input
          before formatting it. There is no path by which markup in a source
          file becomes markup here, which is what makes this safe on a site
          whose CSP is otherwise closed. */}
      <div dangerouslySetInnerHTML={{ __html: entry.html }} />

      <p>
        <InternalLink target="regulatory-hub" onNavigate={onNavigate}>
          All regulatory updates
        </InternalLink>
      </p>
    </Shell>
  )
}
