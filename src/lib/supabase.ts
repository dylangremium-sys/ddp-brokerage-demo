import { createClient, type SupabaseClient } from '@supabase/supabase-js'
// LOAD-BEARING IMPORT — do not remove, even though nothing here calls it.
//
// lib/authRedirect.ts captures the invite / password-recovery parameters in its
// module body. createClient() below starts supabase-js's initialise, which
// consumes that fragment and strips it from window.location. Importing the
// module here guarantees (by ES module evaluation order) that the capture runs
// first. Without it the app cannot tell an invited supplier from an ordinary
// restored session, and the set-password screen is never shown.
// Enforced by lib/setPasswordWiring.test.ts.
import './authRedirect'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const supabase: SupabaseClient | null = url && key
  ? createClient(url, key)
  : null

export const isSupabaseConfigured: boolean = !!(url && key)
