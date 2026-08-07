import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  handleProvisionBuyer,
  type BuyerProvisioningDeps,
} from '../../src/lib/serverBuyerProvisioning.js'
import { resolveInviteRedirectUrl } from '../../src/lib/inviteRedirect.js'

// ─── DDP admin buyer-invitation Vercel Function ─────────────────────────────
//
// Thin adapter, same shape as api/admin/provision-farmer.ts: it reads
// SERVER-ONLY environment variables, wires a service-role Supabase client, and
// delegates all authorization and sequencing to the pure, mock-tested core
// (src/lib/serverBuyerProvisioning.ts).
//
// The service-role key is read from process.env.SUPABASE_SERVICE_ROLE_KEY — a
// server-only variable. It is never a client-exposed (browser-bundled) value,
// never imported into src/, and never returned to the client.
//
// NOTE ON THE IMPORT EXTENSIONS ABOVE. `api/` is deployed as unbundled Node
// ESM: a relative import WITHOUT the `.js` extension resolves in the local
// TypeScript editor and then fails at runtime on Vercel, shipping a dead
// endpoint past a green build and a green CI. Both relative imports here carry
// `.js` deliberately. Verify after deploy by GETting this route — a POST-only
// endpoint that is alive answers 405, whereas a dead one answers 404 or 500.

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
  const bearerMatch = /^Bearer\s+(.+)$/i.exec(raw.trim())
  return bearerMatch ? bearerMatch[1].trim() : null
}

const ALREADY_EXISTS_RE = /already.*(registered|exists)|email.*exists|duplicate/i

function buildDeps(): BuyerProvisioningDeps | null {
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

    async resolveOrCreateOrganisation(input) {
      if (input.kind === 'existing') {
        // `.eq('org_type', 'buyer')` is load-bearing, not defensive tidiness: a
        // valid organisation id belonging to a FARM would otherwise attach a
        // buyer account to a farm's organisation, which is precisely the
        // double-blind the product exists to preserve.
        const { data, error } = await admin
          .from('organisations')
          .select('id')
          .eq('id', input.organisationId)
          .eq('org_type', 'buyer')
          .maybeSingle()
        if (error) return { kind: 'error', message: error.message }
        if (!data) return { kind: 'not_found' }
        return { kind: 'resolved', organisationId: String(data.id), created: false }
      }

      // verification_state is deliberately omitted so the column default
      // ('unverified') applies. This endpoint never verifies an organisation:
      // `organisations_verified_requires_evidence` requires verified_by and
      // verified_at, which are a named human decision, not a request parameter.
      const { data, error } = await admin
        .from('organisations')
        .insert({
          org_type: 'buyer',
          legal_name: input.legalName,
          display_name: input.displayName ?? null,
          country_code: input.countryCode,
        })
        .select('id')
        .maybeSingle()
      if (error) return { kind: 'error', message: error.message }
      if (!data) return { kind: 'error', message: 'Organisation insert returned no row.' }
      return { kind: 'resolved', organisationId: String(data.id), created: true }
    },

    async inviteBuyer(input) {
      // Same redirect resolution as the farmer invite: the emailed link must
      // reach the app that renders the set-password screen, or the account dies
      // with the transient session.
      const redirectTo = resolveInviteRedirectUrl(process.env)
      const { data, error } = await admin.auth.admin.inviteUserByEmail(input.email, {
        ...(redirectTo ? { redirectTo } : {}),
        data: {
          display_name: input.displayName ?? '',
          phone_number: input.phoneNumber ?? '',
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

    async promotePendingToBuyer(userId) {
      // Only elevate a row that is currently 'pending' — never overwrite an
      // existing farmer/admin/buyer. Returns whether exactly such a row changed.
      const { data, error } = await admin
        .from('profiles')
        .update({ role: 'buyer' })
        .eq('id', userId)
        .eq('role', 'pending')
        .select('id')
      if (error) return false
      return Array.isArray(data) && data.length > 0
    },

    async recordMembership(organisationId, userId, orgRole) {
      // upsert on the composite key so a retry after a partial failure
      // converges instead of erroring on a duplicate.
      const { data, error } = await admin
        .from('organisation_memberships')
        .upsert(
          { organisation_id: organisationId, user_id: userId, org_role: orgRole },
          { onConflict: 'organisation_id,user_id' },
        )
        .select('user_id')
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
  const outcome = await handleProvisionBuyer(deps, { token: bearerToken(req), body: req.body })
  res.status(outcome.status).json(outcome.body)
}
