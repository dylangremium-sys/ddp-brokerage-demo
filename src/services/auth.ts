import { supabase } from '../lib/supabase'

export type UserRole = 'ddp_admin' | 'farmer'

export interface UserProfile {
  id: string
  email: string
  displayName: string
  role: UserRole
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
) {
  if (!supabase) throw new Error('Supabase not configured')
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { display_name: displayName } },
  })
  if (error) throw new Error(error.message)

  // The handle_new_user() DB trigger auto-inserts a profiles row on signup.
  // We upsert here as a safety net for environments where the trigger is not yet installed.
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

export async function signOut(): Promise<void> {
  if (!supabase) return
  await supabase.auth.signOut()
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
  return {
    id: data.id,
    email: data.email ?? user.email ?? '',
    displayName: data.display_name ?? '',
    role: data.role as UserRole,
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
      callback(
        data
          ? {
              id: data.id,
              email: data.email ?? session.user.email ?? '',
              displayName: data.display_name ?? '',
              role: data.role as UserRole,
            }
          : null,
      )
    },
  )

  return () => subscription.unsubscribe()
}
