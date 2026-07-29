import { isSupabaseConfigured } from '../../lib/supabase'

/**
 * The "this exists only in this browser" provenance notice (audit F2a).
 *
 * The buyer-pack decision panel already tells an operator when the record they
 * are relying on never reached the server (DDPBuyerPreview.tsx, the
 * decisionSource === 'local-cache' branch). The RISK-STATUS and
 * REQUIREMENT-STATUS overrides — the other half of the same release-gate
 * invariant, `hasBlockingIssues` — carried no such warning at all, despite being
 * written straight to localStorage in Supabase mode too, invisible to other
 * admins, and wiped by sign-out.
 *
 * This is the IMMEDIATE, no-schema half of F2. The durable half is migration 30
 * plus procurementOverrideStore.ts. Until an override surface is migrated onto
 * that store, this notice is what stops an operator believing a clearance is a
 * durable, attributable record when it is browser state.
 *
 * The wording is deliberately the decision panel's, with only the noun changed:
 * one vocabulary for one property. Inventing a second phrasing for the same
 * condition would teach operators that the two warnings mean different things.
 *
 * Rendered ONLY in Supabase mode. In demo mode localStorage IS the store, so
 * "only in this browser" is not a warning — it is the design, and saying it
 * would be noise that trains people to ignore the notice where it matters.
 */
export default function BrowserOnlyProvenanceNotice({
  count,
  subject,
  supabaseConfigured = isSupabaseConfigured,
}: {
  /** How many overrides are currently in effect. Nothing renders at 0. */
  count: number
  /** Plural noun for what is overridden, e.g. 'risk status overrides'. */
  subject: string
  /** Injectable for tests; defaults to the real environment flag. */
  supabaseConfigured?: boolean
}) {
  if (!supabaseConfigured || count <= 0) return null

  return (
    <div
      className="browser-only-provenance"
      role="status"
      style={{ marginTop: 8, fontSize: 12, color: 'var(--text-muted)' }}
    >
      ⚠ {count === 1 ? 'One' : count} {count === 1 ? subject.replace(/s$/, '') : subject} on this page
      {count === 1 ? ' exists' : ' exist'} only in this browser. {count === 1 ? 'It has' : 'They have'} no
      server-side audit record and no recorded approver, and {count === 1 ? 'it is' : 'they are'} not visible
      to other admins. Signing out clears {count === 1 ? 'it' : 'them'}.
    </div>
  )
}
