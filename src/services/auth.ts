import { supabase } from '../lib/supabase'
import { clearSensitiveDdpStorage } from '../lib/browserPersistence'
import {
  provisionFarmer as provisionFarmerImpl,
  listPendingProfiles as listPendingProfilesImpl,
  type ProvisioningClientLike,
  type ProvisionResult,
  type PendingProfile,
} from '../lib/farmerProvisioning'

export type { ProvisionResult, PendingProfile }

// 'pending' is a NON-operational role: a self-registered or admin-invited user
// who has not yet been provisioned as a farmer by DDP. resolvePostLoginDecision
// denies pending accounts, so they cannot reach any operator dashboard.
export type UserRole = 'ddp_admin' | 'farmer' | 'pending'

export interface UserProfile {
  id: string
  email: string
  displayName: string
  role: UserRole
  phoneNumber?: string
  lineId?: string
  preferredLang?: 'th' | 'en'
  farmerSubRole?: string
  province?: string
}

export async function getCurrentUser() {
  if (!supabase) return null
  const { data: { user } } = await supabase.auth.getUser()
  return user
}

export async function getSession() {
  if (!supabase) return null
  const { data: { session } } = await supabase.auth.getSession()
  return session
}

export async function signIn(email: string, password: string) {
  if (!supabase) throw new Error('Supabase not configured')
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) throw new Error(error.message)
  return data
}

// NOTE: public self-registration has been removed. There is deliberately no
// client wrapper around the Supabase Auth public sign-up endpoint — a public
// caller must never be able to create an operational account. Farmers are
// provisioned exclusively by a DDP admin via the server-side endpoint
// (src/services/adminProvisioning.ts -> api/admin/provision-farmer.ts), which
// invites the user with Admin Auth and then promotes the resulting 'pending'
// profile to 'farmer'.

/**
 * Signs the user out AND clears the DDP data left in this browser.
 *
 * Sign-out previously ended the Supabase session and nothing else, so a signed-out
 * browser still held the previous operator's inventory, farm profiles, buyer-pack
 * snapshots and procurement decisions — readable from devtools by whoever used the
 * machine next. The keys are cleared from an explicit allowlist
 * (SENSITIVE_DDP_KEYS), never via localStorage.clear(), so unrelated preferences
 * and other apps on the same origin are untouched.
 *
 * Storage is cleared even if the Supabase sign-out call fails or Supabase is not
 * configured: leaving the data behind is the worse failure.
 */
export async function signOut(): Promise<void> {
  try {
    if (supabase) await supabase.auth.signOut()
  } finally {
    clearSensitiveDdpStorage()
  }
}

export async function getCurrentProfile(): Promise<UserProfile | null> {
  if (!supabase) return null
  // getSession() reads the session that signInWithPassword persisted synchronously
  // before it resolved — no network round-trip, and no race in which a token that
  // was just issued is not yet visible to /auth/v1/user (that race made the first
  // post-login profile read return null and forced a manual refresh).
  // Authorization is unchanged: the profiles row below is still read under RLS,
  // which validates the JWT server-side. This only removes a redundant hop.
  const { data: { session } } = await supabase.auth.getSession()
  const user = session?.user
  if (!user) return null
  const { data, error } = await supabase
    .from('profiles')
    .select('id,email,display_name,role')
    .eq('id', user.id)
    .single()
  if (error || !data) return null
  const m = user.user_metadata ?? {}
  return {
    id: data.id,
    email: data.email ?? user.email ?? '',
    displayName: data.display_name ?? '',
    role: data.role as UserRole,
    phoneNumber: m.phone_number,
    lineId: m.line_id,
    preferredLang: m.preferred_lang,
    farmerSubRole: m.farmer_sub_role,
    province: m.province,
  }
}

export async function isAdmin(): Promise<boolean> {
  const p = await getCurrentProfile()
  return p?.role === 'ddp_admin'
}

export async function isFarmer(): Promise<boolean> {
  const p = await getCurrentProfile()
  return p?.role === 'farmer'
}

// Subscribe to Supabase auth state changes.
// The callback fires immediately with the current session (INITIAL_SESSION event),
// then again on every login/logout. Returns an unsubscribe function.
export function subscribeToAuthChanges(
  callback: (profile: UserProfile | null) => void,
): () => void {
  if (!supabase) return () => {}

  const { data: { subscription } } = supabase.auth.onAuthStateChange(
    async (_event, session) => {
      if (!session?.user) {
        callback(null)
        return
      }
      const { data } = await supabase!
        .from('profiles')
        .select('*')
        .eq('id', session.user.id)
        .single()
      const m = session.user.user_metadata ?? {}
      callback(
        data
          ? {
              id: data.id,
              email: data.email ?? session.user.email ?? '',
              displayName: data.display_name ?? '',
              role: data.role as UserRole,
              phoneNumber: m.phone_number,
              lineId: m.line_id,
              preferredLang: m.preferred_lang,
              farmerSubRole: m.farmer_sub_role,
              province: m.province,
            }
          : null,
      )
    },
  )

  return () => subscription.unsubscribe()
}

// ── DDP-controlled farmer provisioning ──────────────────────────────────────
// The admin-only path to turn a 'pending' account into an operational farmer.
// Both calls run as the caller's own session; RLS ("profiles: admin update
// role") permits them only for a ddp_admin, so no service-role key is needed
// or used on the client.

export function provisionFarmer(userId: string): Promise<ProvisionResult> {
  if (!supabase) {
    return Promise.resolve({ ok: false, error: 'Supabase not configured' })
  }

  return provisionFarmerImpl(
    supabase as unknown as ProvisioningClientLike,
    userId,
  )
}

export function listPendingProfiles(): Promise<PendingProfile[]> {
  if (!supabase) return Promise.resolve([])

  return listPendingProfilesImpl(
    supabase as unknown as ProvisioningClientLike,
  )
}
