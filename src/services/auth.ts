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
//
// 'buyer' has been a legal value of profiles.role in production since migration
// 39 — verified against the live CHECK — while this union omitted it. A buyer
// account could therefore exist in the database and be signed out on every
// login attempt, because the routing switch had no case for it. Buyers remain
// DDP-provisioned only: nothing here creates one, and self-registration cannot
// produce this role.
export type UserRole = 'ddp_admin' | 'farmer' | 'pending' | 'buyer'

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
 * Sets the password of the CURRENTLY AUTHENTICATED user.
 *
 * This is the last step of both onboarding paths. An admin-provisioned supplier
 * arrives from the invite email holding a transient session and no password; a
 * user who forgot theirs arrives from a recovery link the same way. Supabase's
 * updateUser applies to whoever the session belongs to — there is no user id
 * parameter and none can be supplied, so this can never change another
 * account's password even if the caller wanted to.
 *
 * Fails loudly. The single most damaging outcome here is a screen that says
 * "password saved" when it was not: the user closes the tab, the transient
 * session expires, and the account becomes permanently unreachable. So the
 * error is thrown, never swallowed, and the caller must not navigate until this
 * resolves.
 */
export async function setPassword(password: string): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured')
  const { data, error } = await supabase.auth.updateUser({ password })
  if (error) throw new Error(error.message)
  // updateUser resolves with the updated user. A resolution carrying no user is
  // not a success this function is willing to report as one.
  if (!data?.user) throw new Error('Password update did not return a user.')
}

/**
 * Sends a password-reset email.
 *
 * `redirectTo` points at this app's own origin so the recovery link returns
 * here rather than to whatever the Supabase project's Site URL happens to be —
 * the app is served from three hostnames (apex, www, and the vercel.app
 * domain), and a user who started on one should come back to it. Supabase only
 * honours a redirect that is on its allow-list and otherwise falls back to the
 * Site URL, so an unlisted origin degrades to a working link rather than a
 * broken one.
 *
 * Resolves on success. Note that a nonexistent address is a SUCCESS as far as
 * Supabase is concerned — it deliberately does not reveal whether an account
 * exists — so the caller must show the same neutral confirmation either way and
 * must never present this as proof an account was found.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured')
  const redirectTo = typeof window === 'undefined' ? undefined : window.location.origin
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo })
  if (error) throw new Error(error.message)
}

/**
 * The user id of the current session, or null if there is none.
 *
 * The set-password screen uses this to tell "your invite is ready, choose a
 * password" apart from "this link has already been used or has expired" — and,
 * critically, to check WHICH account the session belongs to.
 *
 * It returns the id rather than a boolean on purpose. A yes/no answer was not
 * enough: an admin already signed in on the same browser who opened a spent
 * invite link satisfied "a session exists", and the form then changed THAT
 * account's password instead of the invited one. The caller compares this id
 * against the identity named by the link itself.
 *
 * Read from the local session rather than getUser() so an expired link is
 * reported as expired instead of as a network failure.
 */
export async function getSessionUserId(): Promise<string | null> {
  if (!supabase) return null
  const { data: { session } } = await supabase.auth.getSession()
  return session?.user?.id ?? null
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
/**
 * Per-attempt budget for the profile lookup that follows an auth event.
 *
 * Deliberately HALF the previous single-shot 8s, because there are now two
 * attempts: the worst case is unchanged, but a transient stall self-heals.
 * Must stay comfortably under AUTH_BOOTSTRAP_TIMEOUT_MS (lib/authBootstrapGuard.ts)
 * so both attempts complete before the app gives up and renders signed-out.
 */
export const PROFILE_LOOKUP_TIMEOUT_MS = 4000

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
      try {
        // A TIMEOUT IS NOT EVIDENCE OF "NO SESSION" — retry before concluding that.
        //
        // Observed in production 2026-07-30: on the first load after the tab has
        // been idle, this query hangs. The old code raced it against a single 8s
        // timeout and, on expiry, reported `null` — which the app renders as
        // SIGNED OUT. An administrator with a perfectly valid session was shown
        // the blue loading screen and then the logged-out marketing page.
        //
        // The user's own workaround was to reload, and reloading fixed it. That
        // is precisely a manual retry: the second attempt succeeds (verified —
        // the retry load returned HTTP 200 for the same query in ~1s). So the
        // right fix is to perform that retry ourselves rather than making a
        // person do it.
        //
        // Two attempts at 4s rather than one at 8s: the same worst-case wait, but
        // a transient stall now self-heals instead of logging the operator out.
        // Both attempts must finish inside App's bootstrap guard, or the guard
        // renders the signed-out app while the retry is still in flight — see
        // AUTH_BOOTSTRAP_TIMEOUT_MS in lib/authBootstrapGuard.ts.
        const attemptProfileLookup = async () => {
          const profileQuery = supabase!
            .from('profiles')
            .select('*')
            .eq('id', session.user.id)
            .single()

          const timeout = new Promise<never>((_, reject) => {
            setTimeout(
              () => reject(new Error('profiles lookup timed out')),
              PROFILE_LOOKUP_TIMEOUT_MS,
            )
          })

          return Promise.race([profileQuery, timeout])
        }

        let result: Awaited<ReturnType<typeof attemptProfileLookup>>
        try {
          result = await attemptProfileLookup()
        } catch (firstErr) {
          // Only a TIMEOUT is retried. A rejection for any other reason is a real
          // failure and retrying it would just double the delay before the same
          // outcome.
          if (!(firstErr instanceof Error) || !/timed out/.test(firstErr.message)) throw firstErr
          console.warn('profiles lookup timed out — retrying once before treating the session as absent')
          result = await attemptProfileLookup()
        }

        const { data, error } = result

        // A returned `error`, or a missing row, is authoritative: this identity
        // has no readable profile, so it gets no operator permissions. That is
        // NOT the timeout case and must not be retried.
        if (error || !data) {
          callback(null)
          return
        }

        const m = session.user.user_metadata ?? {}
        callback({
          id: data.id,
          email: data.email ?? session.user.email ?? '',
          displayName: data.display_name ?? '',
          role: data.role as UserRole,
          phoneNumber: m.phone_number,
          lineId: m.line_id,
          preferredLang: m.preferred_lang,
          farmerSubRole: m.farmer_sub_role,
          province: m.province,
        })
      } catch (err) {
        console.warn('Auth bootstrap profile lookup failed:', err)
        // Fail closed: no profile means no operator permissions.
        callback(null)
      }
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
