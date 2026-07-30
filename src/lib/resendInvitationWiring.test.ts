// Resend-invitation wiring contract.
//
// src/services/adminProvisioning.ts once existed and was imported by ZERO
// components: the "Invited" button wrote a status label and created no account.
// The pure core below it was fully tested the whole time. That is the failure
// this file exists to prevent repeating — a correct, well-tested endpoint that
// nothing calls.
//
// Vitest runs environment: 'node' here with no jsdom, so .tsx is asserted as
// source text via import.meta.glob('?raw') — the convention already used by
// navigationGuard.test.ts and setPasswordWiring.test.ts.

import { describe, it, expect } from 'vitest'

function source(glob: Record<string, string>): string {
  return Object.values(glob)[0] ?? ''
}

const PAGE = source(import.meta.glob('../pages/admin/DDPAccessRequests.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)
const CLIENT = source(import.meta.glob('../services/adminProvisioning.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)
const ENDPOINT = source(import.meta.glob('../../api/admin/resend-invitation.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)

it('reads every source file it asserts on', () => {
  for (const [name, text] of Object.entries({ PAGE, CLIENT, ENDPOINT })) {
    expect(text.length, `${name} source is empty — the glob path has drifted`).toBeGreaterThan(200)
  }
})

describe('the button reaches the endpoint', () => {
  it('the admin page imports and calls resendInvitation', () => {
    expect(PAGE).toMatch(/import \{[^}]*resendInvitation[^}]*\} from '\.\.\/\.\.\/services\/adminProvisioning'/)
    expect(PAGE).toMatch(/await resendInvitation\(row\.email\)/)
  })

  it('a Resend invitation control is actually rendered', () => {
    expect(PAGE).toMatch(/Resend invitation/)
    expect(PAGE).toMatch(/resend\(row\)/)
  })

  it('the client posts to the endpoint that exists', () => {
    expect(CLIENT).toMatch(/RESEND_ENDPOINT = '\/api\/admin\/resend-invitation'/)
    expect(ENDPOINT).toMatch(/export default async function handler/)
  })

  it('the endpoint delegates to the mock-tested core', () => {
    expect(ENDPOINT).toMatch(/handleResendInvitation/)
    expect(ENDPOINT).toMatch(/from '\.\.\/\.\.\/src\/lib\/serverInvitationResend\.js'/)
  })
})

describe('the control is offered only where it makes sense', () => {
  it('shown for an already-invited enquiry, not before an account exists', () => {
    // Re-issuing for an enquiry that was never provisioned would fail with
    // no_such_account and read to the admin as a broken button.
    expect(PAGE).toMatch(/row\.status === 'invited' &&[\s\S]{0,1400}Resend invitation/)
  })

  it('the create-account button remains the not-yet-invited path', () => {
    expect(PAGE).toMatch(/row\.status !== 'invited' &&[\s\S]{0,900}Invite & create account/)
  })
})

describe('the one-time link is handled as a credential', () => {
  it('is scoped to the row it belongs to', () => {
    // A link rendered against the wrong row would invite the admin to send one
    // supplier's credential to another.
    expect(PAGE).toMatch(/resendLink\?\.rowId === row\.id/)
  })

  it('is never persisted or logged', () => {
    const code = PAGE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
    expect(code).not.toMatch(/localStorage|sessionStorage/)
    expect(code).not.toMatch(/console\.(log|info|warn|error)\([^)]*resendLink/)
  })

  it('warns the admin what they are holding', () => {
    expect(PAGE).toMatch(/Treat it like a password/i)
  })
})

describe('styling that actually applies', () => {
  it('does not use btn-secondary, which is scoped to .eo-farmer only', () => {
    // PR #90 fixed this very page rendering near-white text via className="page",
    // a class defined in no stylesheet. `.btn-secondary` is defined ONLY under
    // `.eo-farmer` (App.css), and this admin page is not inside that scope, so
    // it would render unstyled here. App.css cannot be read via ?raw — Vite's
    // CSS pipeline owns it — so this asserts the page-side choice, which is the
    // half that regresses.
    expect(PAGE).not.toMatch(/className="btn btn-secondary"/)
    expect(PAGE).toMatch(/className="btn btn-ghost"/)
  })
})
