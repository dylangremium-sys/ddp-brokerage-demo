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

/**
 * Public self-registration.
 *
 * A public caller may create an ACCOUNT. It must never be able to create an
 * OPERATIONAL account, and this wrapper does not give it one:
 *
 *   - No role is sent. The role is assigned server-side by the
 *     on_auth_user_created trigger (public.handle_new_user), which stamps every
 *     brand-new auth user 'pending' — never 'farmer'
 *     (21_DDP_CONTROLLED_FARMER_PROVISIONING_HARDENING.sql).
 *   - A 'pending' account cannot self-promote: RLS ("profiles: admin update
 *     role") permits a role change only for a ddp_admin.
 *   - resolvePostLoginDecision() denies 'pending' with reason
 *     'pending-approval', so the account reaches no dashboard until a DDP admin
 *     provisions it via provisionFarmer().
 *
 * So the approval gate is unchanged by this function: it is enforced in the
 * database and in routing, not by withholding the signup endpoint. Anything
 * passed here as metadata is untrusted display data only and is never read for
 * an authorization decision.
 */
export async function signUp(
  email: string,
  password: string,
  displayName?: string,
): Promise<{ needsEmailConfirmation: boolean }> {
  if (!supabase) throw new Error('Supabase not configured')
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: displayName ? { data: { display_name: displayName } } : undefined,
  })
  if (error) throw new Error(error.message)
  // With "Confirm email" enabled Supabase returns a user but no session; the
  // account exists and is 'pending' either way.
  return { needsEmailConfirmation: !data.session }
}

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
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
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
