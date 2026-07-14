import { supabase } from '../lib/supabase'
import { clearSensitiveDdpStorage } from '../lib/browserPersistence'

export type UserRole = 'ddp_admin' | 'farmer'

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

export async function signUpFarmer(
  email: string,
  password: string,
  displayName: string,
  extra?: {
    phoneNumber?: string
    lineId?: string
    preferredLang?: string
    farmerSubRole?: string
    province?: string
  },
) {
  if (!supabase) throw new Error('Supabase not configured')
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: {
        display_name: displayName,
        phone_number: extra?.phoneNumber ?? '',
        line_id: extra?.lineId ?? '',
        preferred_lang: extra?.preferredLang ?? 'th',
        farmer_sub_role: extra?.farmerSubRole ?? 'Farmer',
        province: extra?.province ?? '',
      },
    },
  })
  if (error) throw new Error(error.message)

  if (data.user) {
    const { error: profileError } = await supabase.from('profiles').upsert({
      id: data.user.id,
      email,
      display_name: displayName,
      role: 'farmer',
    })
    if (profileError) {
      console.warn('profiles upsert after signup:', profileError.message)
    }
  }

  return data
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
