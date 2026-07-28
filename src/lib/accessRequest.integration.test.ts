// ─── Farmer access request — end-to-end against staging ─────────────────────
//
// Proves the replacement onboarding intake works as a whole, against the real
// staging database with real authentication:
//
//   anonymous visitor submits  ->  stored server-side
//   admin sees it in the queue ->  triages it, reviewer stamped automatically
//   nobody else can read it    ->  not anon, not farmer, not pending
//
// This is the flow that previously wrote to the visitor's localStorage and
// dead-ended at a dashboard requiring a session that was never created.
//
// Skipped unless DDP_STAGING_E2E=1.
//   set -a && . ./.env.staging && set +a
//   DDP_STAGING_E2E=1 npm test -- accessRequest.integration
//
// MIGRATION 36 CHANGES THE FIRST ASSERTION. Before migration 36 an anonymous
// visitor inserts directly (migration 34's `public submit` policy). After it,
// that policy and the anon INSERT grant are both gone and submission goes through
// /api/public/access-request; a direct anon insert must then be REFUSED.
//
// Rather than leave a test that silently inverts meaning the day the migration
// lands, the expectation is selected explicitly:
//   DDP_INTAKE_MIGRATION_36_APPLIED=1   -> anon insert must be refused
//   unset                               -> anon insert must succeed (pre-36)
// Set it in the same env file as the rest of the staging configuration when the
// migration is applied there.

import { describe, it, expect, beforeAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const enabled = process.env.DDP_STAGING_E2E === '1'
const url = process.env.STAGING_SUPABASE_URL ?? ''
const anonKey = process.env.STAGING_SUPABASE_ANON_KEY ?? ''
const adminEmail = process.env.STAGING_ADMIN_EMAIL ?? ''
const adminPassword = process.env.STAGING_ADMIN_PASSWORD ?? ''
const farmerEmail = process.env.STAGING_FARMER_A_EMAIL ?? ''
const farmerPassword = process.env.STAGING_FARMER_A_PASSWORD ?? ''

const ready = enabled && !!(url && anonKey && adminEmail && adminPassword)

/** Has migration 36 been applied to the environment under test? */
const migration36Applied = process.env.DDP_INTAKE_MIGRATION_36_APPLIED === '1'

/** A signed-out visitor — exactly what the public form uses. */
function anonClient(): SupabaseClient {
  return createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
}

async function signedInClient(email: string, password: string) {
  const client = anonClient()
  const { data, error } = await client.auth.signInWithPassword({ email, password })
  if (error || !data.session) throw new Error(`sign-in failed for ${email}: ${error?.message}`)
  return {
    client: createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${data.session.access_token}` } },
    }),
    userId: data.session.user.id,
  }
}

// Unique per run so repeated runs don't collide.
const marker = `e2e-${Date.now()}`
const submission = {
  full_name: 'Somchai E2E',
  email: `${marker}@example.com`,
  phone: '+66 81 234 5678',
  province: 'Buriram',
  position: 'Farmer',
  preferred_language: 'th',
  note: 'Submitted by the access-request end-to-end test.',
  status: 'new',
}

describe.skipIf(!ready)('farmer access request — end to end', () => {
  let admin: { client: SupabaseClient; userId: string }

  beforeAll(async () => {
    admin = await signedInClient(adminEmail, adminPassword)
  }, 60_000)

  it('the anonymous submission path matches the deployed migration state', async () => {
    const { error } = await anonClient().from('farmer_access_requests').insert(submission)

    if (migration36Applied) {
      // Migration 36 revoked the anon INSERT and narrowed the policy to
      // service_role, so the browser -> Supabase path is closed. This is audit
      // fix R5: submission now goes through /api/public/access-request, which is
      // the only path an edge rate limiter can see.
      expect(error, 'anon insert must be refused once migration 36 is applied').not.toBeNull()
      expect(error?.code).toBe('42501')

      // The rest of this suite needs a row to triage, and the anon path can no
      // longer create one. Insert it as the administrator instead.
      const { error: adminInsert } = await admin.client.from('farmer_access_requests').insert(submission)
      expect(adminInsert, adminInsert?.message).toBeNull()
    } else {
      expect(error, error?.message).toBeNull()
    }
  }, 60_000)

  it('the visitor cannot read back their own request, or any other', async () => {
    // The queue holds names, emails and phone numbers. A submitter must not be
    // able to enumerate it — not even the row they just created.
    const { data, error } = await anonClient()
      .from('farmer_access_requests').select('id, email')
    expect(error ?? { message: null }).toBeTruthy()
    expect(data ?? []).toEqual([])
  }, 60_000)

  it('an administrator sees the request in the queue', async () => {
    const { data, error } = await admin.client
      .from('farmer_access_requests')
      .select('id, full_name, email, phone, province, position, preferred_language, status, reviewed_by, reviewed_at')
      .eq('email', submission.email)
      .single()

    expect(error, error?.message).toBeNull()
    expect(data).toMatchObject({
      full_name: 'Somchai E2E',
      phone: '+66 81 234 5678',
      province: 'Buriram',
      position: 'Farmer',
      preferred_language: 'th',
      status: 'new',
    })
    // It arrived unreviewed — a submission cannot pre-approve itself.
    expect(data?.reviewed_by).toBeNull()
    expect(data?.reviewed_at).toBeNull()
  }, 60_000)

  it('a farmer cannot read the queue', async () => {
    if (!farmerEmail || !farmerPassword) throw new Error('farmer credentials required')
    const farmer = await signedInClient(farmerEmail, farmerPassword)
    const { data } = await farmer.client.from('farmer_access_requests').select('id, email')
    expect(data ?? []).toEqual([])
  }, 60_000)

  it('a farmer cannot triage a request', async () => {
    const farmer = await signedInClient(farmerEmail, farmerPassword)
    await farmer.client
      .from('farmer_access_requests')
      .update({ status: 'invited' })
      .eq('email', submission.email)

    // RLS matches no rows for a non-admin, so the row is untouched.
    const { data } = await admin.client
      .from('farmer_access_requests').select('status').eq('email', submission.email).single()
    expect(data?.status).toBe('new')
  }, 60_000)

  it('an administrator triages it, and the reviewer is stamped automatically', async () => {
    const { error } = await admin.client
      .from('farmer_access_requests')
      .update({ status: 'contacted', review_note: 'Called, verified the farm.' })
      .eq('email', submission.email)
    expect(error, error?.message).toBeNull()

    const { data } = await admin.client
      .from('farmer_access_requests')
      .select('status, review_note, reviewed_by, reviewed_at')
      .eq('email', submission.email).single()

    expect(data?.status).toBe('contacted')
    expect(data?.review_note).toBe('Called, verified the farm.')
    // Stamped by the trigger, not by the client — triage is always attributable.
    expect(data?.reviewed_by).toBe(admin.userId)
    expect(data?.reviewed_at).toBeTruthy()
  }, 60_000)

  it('nobody can delete a request', async () => {
    await admin.client.from('farmer_access_requests').delete().eq('email', submission.email)
    const { data } = await admin.client
      .from('farmer_access_requests').select('id').eq('email', submission.email)
    expect((data ?? []).length, 'an enquiry is a record of who asked for access').toBe(1)
  }, 60_000)

  it('malformed submissions are refused by the database', async () => {
    const bad = await anonClient().from('farmer_access_requests')
      .insert({ ...submission, email: 'not-an-email' })
    expect(bad.error).not.toBeNull()

    const oversized = await anonClient().from('farmer_access_requests')
      .insert({ ...submission, email: `x-${marker}@example.com`, note: 'a'.repeat(2001) })
    expect(oversized.error).not.toBeNull()
  }, 60_000)

  it('a submission cannot arrive pre-approved', async () => {
    const { error } = await anonClient().from('farmer_access_requests').insert({
      ...submission,
      email: `pre-${marker}@example.com`,
      status: 'invited',
    })
    expect(error, 'anon must not be able to submit an already-approved request').not.toBeNull()
  }, 60_000)
})
