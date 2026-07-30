import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  handleResendInvitation,
  type ResendDeps,
  type AccountLookup,
  type ReissueResult,
} from '../../src/lib/serverInvitationResend.js'
import { resolveInviteRedirectUrl } from '../../src/lib/inviteRedirect.js'

// ─── DDP admin invitation-resend Vercel Function ────────────────────────────
//
// Thin adapter, mirroring api/admin/provision-farmer.ts: it reads SERVER-ONLY
// environment variables, wires a service-role Supabase client, and delegates all
// authorization and sequencing to the pure, mock-tested core
// (src/lib/serverInvitationResend.ts).
//
// The service-role key is read from process.env.SUPABASE_SERVICE_ROLE_KEY — a
// server-only variable, never bundled for the browser, never returned to the
// client. The client only ever sends its own authenticated access token.

interface VercelRequestLike {
  method?: string
  headers: Record<string, string | string[] | undefined>
  body?: unknown
}
interface VercelResponseLike {
  status(code: number): VercelResponseLike
  json(body: unknown): void
}

function headerValue(v: string | string[] | undefined): string | null {
  if (Array.isArray(v)) return v[0] ?? null
  return v ?? null
}

function bearerToken(req: VercelRequestLike): string | null {
  const raw = headerValue(req.headers['authorization'] ?? req.headers['Authorization'])
  if (!raw) return null
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim())
  return m ? m[1].trim() : null
}

const ALREADY_EXISTS_RE = /already.*(registered|exists)|email.*exists|duplicate/i

function buildDeps(): ResendDeps | null {
  const url = process.env.SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceRoleKey) return null

  const admin: SupabaseClient = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  return {
    async getCallerFromToken(token) {
      const { data, error } = await admin.auth.getUser(token)
      if (error || !data.user) return null
      return { id: data.user.id }
    },

    async getProfileRole(userId) {
      const { data, error } = await admin
        .from('profiles')
        .select('role')
        .eq('id', userId)
        .maybeSingle()
      if (error || !data) return null
      return typeof data.role === 'string' ? data.role : null
    },

    async findAccountByEmail(email): Promise<AccountLookup> {
      // profiles.email is the app's own record of who has been provisioned, and
      // it is indexed by the primary key we need. Matched case-INSENSITIVELY:
      // addresses are not case-sensitive in practice, and a case-sensitive
      // comparison here would report "no account" for a supplier who typed
      // their address with different capitalisation — sending the admin to
      // "Invite & create account", which would then fail as a duplicate.
      const { data, error } = await admin
        .from('profiles')
        .select('id')
        .ilike('email', email)
      if (error) return { kind: 'absent' }
      if (!data || data.length === 0) return { kind: 'absent' }
      // No unique constraint exists on profiles.email, so a duplicate is
      // possible. Guessing could hand one supplier's invitation to another.
      if (data.length > 1) return { kind: 'ambiguous' }

      const userId = String(data[0].id)
      const { data: userData, error: userError } = await admin.auth.admin.getUserById(userId)
      // Fail CLOSED: if the auth record cannot be read we cannot prove the
      // account is unconfirmed, and re-issuing against an unknown state is the
      // outcome worth avoiding.
      if (userError || !userData?.user) return { kind: 'absent' }
      if (userData.user.email_confirmed_at) return { kind: 'confirmed' }
      return { kind: 'unconfirmed', userId }
    },

    async reissueInvitation(email): Promise<ReissueResult> {
      const redirectTo = resolveInviteRedirectUrl(process.env)

      // Preferred path: the provider sends the mail itself.
      const { error } = await admin.auth.admin.inviteUserByEmail(email, {
        ...(redirectTo ? { redirectTo } : {}),
      })
      if (!error) return { kind: 'emailed' }

      // GoTrue refuses to invite an address it already knows. That is exactly
      // the case we are in — the account exists and is unconfirmed — so fall
      // back to minting a one-time link and let the ADMIN deliver it. Thai
      // growers are frequently reachable on LINE rather than email, so a link
      // the admin can paste is often the better channel anyway.
      if (!ALREADY_EXISTS_RE.test(error.message || '')) {
        return { kind: 'error', message: error.message || 'Invite failed.' }
      }

      const { data, error: linkError } = await admin.auth.admin.generateLink({
        type: 'invite',
        email,
        ...(redirectTo ? { options: { redirectTo } } : {}),
      })
      if (linkError || !data?.properties?.action_link) {
        return { kind: 'error', message: linkError?.message || 'Could not generate an invitation link.' }
      }
      return { kind: 'link_only', actionLink: data.properties.action_link }
    },
  }
}

export default async function handler(req: VercelRequestLike, res: VercelResponseLike): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed.' })
    return
  }
  const deps = buildDeps()
  if (!deps) {
    res.status(500).json({ ok: false, error: 'The resend endpoint is not configured.' })
    return
  }

  const result = await handleResendInvitation(deps, {
    token: bearerToken(req),
    body: req.body,
  })
  res.status(result.status).json(result.body)
}
