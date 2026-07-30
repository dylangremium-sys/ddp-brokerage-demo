import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  handleProvisionFarmer,
  type ProvisioningDeps,
} from '../../src/lib/serverFarmerProvisioning.js'
import { resolveInviteRedirectUrl } from '../../src/lib/inviteRedirect.js'

// ─── DDP admin farmer-invitation Vercel Function ────────────────────────────
//
// Thin adapter: it reads SERVER-ONLY environment variables, wires a
// service-role Supabase client, and delegates all authorization and sequencing
// to the pure, mock-tested core (src/lib/serverFarmerProvisioning.ts).
//
// The service-role key is read from process.env.SUPABASE_SERVICE_ROLE_KEY — a
// server-only variable. It is never a client-exposed (browser-bundled) value,
// never imported into src/, and never returned to the client. The client only
// ever sends its own authenticated access token (Authorization: Bearer token).

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

function buildDeps(): ProvisioningDeps | null {
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

    async inviteFarmer(input) {
      // Where the emailed link returns to. Previously omitted entirely, which
      // sent every invitation to the Supabase project's Site URL — a dashboard
      // setting invisible from this repo. The link MUST reach the app that
      // renders the set-password screen, or the supplier lands somewhere that
      // cannot set a password and the account dies with the session.
      //
      // Undefined when APP_PUBLIC_URL is unset or unusable, in which case the
      // key is omitted below and the previous Site URL behaviour is restored
      // exactly — a mistyped variable must not stop invitations being sent.
      const redirectTo = resolveInviteRedirectUrl(process.env)

      const { data, error } = await admin.auth.admin.inviteUserByEmail(input.email, {
        ...(redirectTo ? { redirectTo } : {}),
        data: {
          display_name: input.displayName ?? '',
          province: input.province ?? '',
          phone_number: input.phoneNumber ?? '',
          line_id: input.lineId ?? '',
        },
      })
      if (error) {
        const message = error.message || 'Invite failed.'
        if (ALREADY_EXISTS_RE.test(message)) return { kind: 'already_exists' }
        return { kind: 'error', message }
      }
      if (!data.user) return { kind: 'error', message: 'Invite returned no user.' }
      return { kind: 'invited', userId: data.user.id }
    },

    async promotePendingToFarmer(userId) {
      // Only elevate a row that is currently 'pending' — never overwrite an
      // existing farmer/admin. Returns whether exactly such a row changed.
      const { data, error } = await admin
        .from('profiles')
        .update({ role: 'farmer' })
        .eq('id', userId)
        .eq('role', 'pending')
        .select('id')
      if (error) return false
      return Array.isArray(data) && data.length > 0
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
    res.status(500).json({ ok: false, error: 'Provisioning endpoint is not configured.' })
    return
  }
  const outcome = await handleProvisionFarmer(deps, { token: bearerToken(req), body: req.body })
  res.status(outcome.status).json(outcome.body)
}
