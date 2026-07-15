import { supabase } from '../lib/supabase'

// Narrowly scoped client wrapper for the DDP admin farmer-invitation endpoint.
// It calls the server-side /api/admin/provision-farmer function with the
// caller's own authenticated access token. It never handles a service-role key
// — all privileged work happens server-side behind the token check.

export interface InviteFarmerInput {
  email: string
  displayName?: string
  province?: string
  phoneNumber?: string
  lineId?: string
}

export type InviteFarmerResult =
  | { ok: true; userId: string }
  | { ok: false; error: string; stage?: string; userId?: string }

const ENDPOINT = '/api/admin/provision-farmer'

export async function inviteFarmer(input: InviteFarmerInput): Promise<InviteFarmerResult> {
  if (!supabase) return { ok: false, error: 'Supabase not configured.' }

  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token
  if (!token) return { ok: false, error: 'You must be signed in as a DDP admin.' }

  let res: Response
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        email: input.email,
        display_name: input.displayName,
        province: input.province,
        phone_number: input.phoneNumber,
        line_id: input.lineId,
      }),
    })
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Network error.' }
  }

  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (res.ok && body.ok === true) {
    return { ok: true, userId: String(body.userId ?? '') }
  }
  return {
    ok: false,
    error: typeof body.error === 'string' ? body.error : 'Provisioning failed.',
    stage: typeof body.stage === 'string' ? body.stage : undefined,
    userId: typeof body.userId === 'string' ? body.userId : undefined,
  }
}
