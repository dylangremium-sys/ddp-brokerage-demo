// DDP-controlled farmer provisioning — the admin-only path that turns a
// self-registered (or admin-invited) 'pending' account into an operational
// 'farmer'.
//
// Enforcement note: these operations only succeed for a ddp_admin caller. The
// "profiles: admin update role" RLS policy is the sole path permitted to change
// a profile's role; the "update own no role change" policy blocks any non-admin
// (including a 'pending' user) from self-promoting. This module therefore never
// needs — and must never use — a service-role key on the client; it relies on
// the caller's own ddp_admin session and the database's RLS.
//
// Kept as side-effect-free functions over a minimal injected client so the
// provisioning policy can be unit-tested without React or a live Supabase
// (same dependency-injection style as buyerPackSnapshotSupabaseStore.ts).

export type ProvisionResult =
  | { ok: true }
  | { ok: false; error: string }

export interface PendingProfile {
  id: string
  email: string
  displayName: string
}

interface MutationResultLike {
  error: { message: string } | null
}
interface QueryResultLike {
  data: Array<Record<string, unknown>> | null
  error: { message: string } | null
}

/** The narrow slice of the Supabase client this module uses. */
export interface ProvisioningClientLike {
  from(table: string): {
    update(values: Record<string, unknown>): {
      eq(column: string, value: string): PromiseLike<MutationResultLike>
    }
    select(columns: string): {
      eq(column: string, value: string): PromiseLike<QueryResultLike>
    }
  }
}

/**
 * Promote a pending account to an operational farmer. Succeeds only when the
 * caller's session is ddp_admin (enforced by RLS); otherwise Supabase returns
 * an error and this reports ok:false without changing anything.
 */
export async function provisionFarmer(
  client: ProvisioningClientLike,
  userId: string,
): Promise<ProvisionResult> {
  if (!userId) return { ok: false, error: 'A user id is required to provision a farmer.' }
  const { error } = await client.from('profiles').update({ role: 'farmer' }).eq('id', userId)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

/**
 * List the accounts awaiting DDP provisioning (role = 'pending'). Under RLS
 * this returns rows only for a ddp_admin caller.
 */
export async function listPendingProfiles(
  client: ProvisioningClientLike,
): Promise<PendingProfile[]> {
  const { data, error } = await client
    .from('profiles')
    .select('id, email, display_name, role')
    .eq('role', 'pending')
  if (error) throw new Error(error.message)
  return (data ?? []).map(row => ({
    id: String(row.id),
    email: typeof row.email === 'string' ? row.email : '',
    displayName: typeof row.display_name === 'string' ? row.display_name : '',
  }))
}
