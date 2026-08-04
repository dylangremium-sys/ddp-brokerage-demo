import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * Gate 3: Admin COA Review API Persistence
 *
 * Handles three admin actions on COA submissions:
 * - approve: Accept the COA submission
 * - request_correction: Ask farmer to fix and resubmit
 * - reject: Reject the submission entirely
 *
 * All actions persist to the inventory item and audit log.
 */

interface VercelRequestLike {
  method?: string
  headers: Record<string, string | string[] | undefined>
  body?: unknown
}

interface VercelResponseLike {
  status(code: number): VercelResponseLike
  json(body: unknown): void
}

function headerValue(v: string | string[] | undefined): string | null {
  if (Array.isArray(v)) return v[0] ?? null
  return v ?? null
}

function bearerToken(req: VercelRequestLike): string | null {
  const raw = headerValue(req.headers['authorization'] ?? req.headers['Authorization'])
  if (!raw) return null
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim())
  return m ? m[1].trim() : null
}

function buildAdmin(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceRoleKey) return null

  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

export default async function handler(req: VercelRequestLike, res: VercelResponseLike) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { itemId, action, adminNotes } = req.body as {
    itemId?: string
    action?: string
    adminNotes?: string
  } | null | undefined ?? {}

  if (!itemId || !action) {
    return res.status(400).json({ error: 'itemId and action are required' })
  }

  if (!['approve', 'request_correction', 'reject'].includes(action)) {
    return res.status(400).json({ error: 'Invalid action' })
  }

  const token = bearerToken(req)
  if (!token) {
    return res.status(401).json({ error: 'Authorization required' })
  }

  const admin = buildAdmin()
  if (!admin) {
    return res.status(500).json({ error: 'Database configuration missing' })
  }

  try {
    // 1. Verify user is admin
    const { data: user, error: authError } = await admin.auth.getUser(token)
    if (authError || !user.user) {
      return res.status(401).json({ error: 'Invalid or expired token' })
    }

    // 2. Check if user has admin role (RLS will enforce this, but verify early)
    const { data: profile, error: profileError } = await admin
      .from('profiles')
      .select('role')
      .eq('id', user.user.id)
      .single()

    if (profileError || profile?.role !== 'ddp_admin') {
      return res.status(403).json({ error: 'Only admins can review COAs' })
    }

    // 3. Fetch inventory item and verify it's ready for review
    const { data: item, error: itemError } = await admin
      .from('inventory_items')
      .select('id, coa_confirmation_status, coa_extracted_json, coa_farmer_entry_json')
      .eq('id', itemId)
      .single()

    if (itemError || !item) {
      return res.status(404).json({ error: 'Inventory item not found' })
    }

    // Verify COA is ready for admin review
    if (!['confirmed', 'flagged_for_review', 'needs_correction'].includes(item.coa_confirmation_status)) {
      return res.status(400).json({
        error: `COA status ${item.coa_confirmation_status} is not eligible for admin review`,
      })
    }

    // 4. Update inventory item with admin decision
    const adminStatusMap: Record<string, string> = {
      approve: 'approved',
      request_correction: 'needs_correction',
      reject: 'rejected',
    }

    const newAdminStatus = adminStatusMap[action]
    const now = new Date().toISOString()

    // Prepare updates
    const updates: Record<string, unknown> = {
      coa_admin_status: newAdminStatus,
      coa_admin_notes: adminNotes || null,
      coa_admin_reviewed_at: now,
    }

    // If requesting correction, allow farmer to resubmit (reset confirmation status)
    if (action === 'request_correction') {
      updates.coa_confirmation_status = 'pending_confirmation'
    }

    const { error: updateError } = await admin
      .from('inventory_items')
      .update(updates)
      .eq('id', itemId)

    if (updateError) {
      console.error('Failed to update inventory item:', updateError)
      return res.status(500).json({ error: 'Failed to save admin decision' })
    }

    // 5. Audit log the action
    const { error: auditError } = await admin
      .from('audit_log')
      .insert({
        user_id: user.user.id,
        action: `coa_review_${action}`,
        resource_type: 'inventory_item',
        resource_id: itemId,
        details: {
          coa_admin_status: newAdminStatus,
          admin_notes: adminNotes || null,
          timestamp: now,
        },
      })

    if (auditError) {
      console.warn('Failed to log audit event:', auditError)
      // Don't fail the request — logging failure shouldn't block the update
    }

    // 6. TODO: Notify farmer if correction/rejection
    // This would require sending an email/notification to the farmer
    // Implementation depends on notification service choice

    res.status(200).json({
      success: true,
      itemId,
      action,
      newStatus: newAdminStatus,
      timestamp: now,
      message:
        action === 'approve'
          ? 'COA approved successfully'
          : action === 'request_correction'
            ? 'Farmer requested to correct and resubmit'
            : 'COA rejected',
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('COA review error:', message)
    res.status(500).json({ error: `Failed to process COA review: ${message}` })
  }
}
