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

interface QueryResultLike {
  data: Array<Record<string, unknown>> | null
  error: { message: string } | null
}
// The update builder is chainable and ends in select(), so the wrapper can read
// back the affected row and verify the promotion actually happened.
interface UpdateBuilderLike {
  eq(column: string, value: string): UpdateBuilderLike
  select(columns: string): PromiseLike<QueryResultLike>
}

/** The narrow slice of the Supabase client this module uses. */
export interface ProvisioningClientLike {
  from(table: string): {
    update(values: Record<string, unknown>): UpdateBuilderLike
    select(columns: string): {
      eq(column: string, value: string): PromiseLike<QueryResultLike>
    }
  }
}

/**
 * Promote a *pending* account to an operational farmer. Succeeds only when the
 * caller's session is ddp_admin (enforced by the "profiles: admin update role"
 * RLS policy) AND the target profile is currently 'pending'.
 *
 * The update is constrained to `role = 'pending'` and reads back the affected id:
 * a non-admin caller (RLS-filtered), a stale/nonexistent id, or an already-
 * non-pending row all return ZERO rows WITHOUT a Supabase error. We therefore
 * verify exactly one pending profile with the requested id was promoted before
 * reporting success — mirroring the server-side promotePendingToFarmer contract.
 * It never throws for these expected authorization/zero-row outcomes.
 */
export async function provisionFarmer(
  client: ProvisioningClientLike,
  userId: string,
): Promise<ProvisionResult> {
  if (!userId) return { ok: false, error: 'A user id is required to provision a farmer.' }
  const { data, error } = await client
    .from('profiles')
    .update({ role: 'farmer' })
    .eq('id', userId)
    .eq('role', 'pending')
    .select('id')
  if (error) return { ok: false, error: error.message }
  const rows = data ?? []
  if (rows.length !== 1 || String(rows[0]?.id) !== userId) {
    return {
      ok: false,
      error:
        'No pending account was promoted — the user was not found, is not pending, or you are not permitted to promote it.',
    }
  }
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
