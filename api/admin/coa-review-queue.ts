import { createClient } from '@supabase/supabase-js'
import type { InventoryItem } from '../../src/types'

const supabaseUrl = process.env.SUPABASE_URL!
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
})

interface PendingCoaReview extends Omit<InventoryItem, 'id'> {
  id: string
}

/**
 * GET /api/admin/coa-review-queue
 *
 * Fetch all COA submissions pending admin review (Gate 3).
 * Requires: admin authorization via Bearer token
 *
 * Returns array of InventoryItems where:
 * - coaConfirmationStatus = 'confirmed' or 'flagged_for_review' (farmer has submitted)
 * - coaAdminStatus IS NULL or = 'needs_correction' (not yet reviewed, or needs resubmission)
 *
 * Used by AdminCOAReviewQueue to populate the list of pending reviews.
 */
export default async function handler(req: any, res: any) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    // Extract bearer token from Authorization header
    const authHeader = req.headers.authorization || ''
    const token = authHeader.replace(/^Bearer\s+/i, '')

    if (!token) {
      return res.status(401).json({ error: 'Missing authorization token' })
    }

    // Verify token and get user with admin role
    const { data: { user }, error: userError } = await supabase.auth.getUser(token)

    if (userError || !user) {
      return res.status(401).json({ error: 'Invalid or expired token' })
    }

    // Check that user has admin role
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single()

    if (profileError || !profile || profile.role !== 'ddp_admin') {
      return res.status(403).json({ error: 'Admin access required' })
    }

    // Fetch inventory items pending admin COA review
    // Query for items where:
    // 1. Farmer has submitted their confirmation: coaConfirmationStatus IN ('confirmed', 'flagged_for_review')
    // 2. Admin has not yet reviewed: coaAdminStatus IS NULL OR coaAdminStatus = 'needs_correction'
    const { data: items, error: queryError } = await supabase
      .from('inventory_items')
      .select('*')
      .in('coa_confirmation_status', ['confirmed', 'flagged_for_review'])
      .or('coa_admin_status.is.null,coa_admin_status.eq.needs_correction')
      .order('updated_at', { ascending: true })

    if (queryError) {
      console.error('Database query error:', queryError)
      return res.status(500).json({ error: 'Failed to fetch pending reviews' })
    }

    // Transform database columns to camelCase InventoryItem properties
    const reviews: PendingCoaReview[] = (items || []).map((item: any) => ({
      ...item,
      // Map snake_case database columns to camelCase if needed
      coaConfirmationStatus: item.coa_confirmation_status,
      coaAdminStatus: item.coa_admin_status,
      coaAdminNotes: item.coa_admin_notes,
      coaAdminReviewedAt: item.coa_admin_reviewed_at,
      coaExtractedJson: item.coa_extracted_json,
      coaFarmerEntryJson: item.coa_farmer_entry_json,
      coaMismatchFlags: item.coa_mismatch_flags,
      coaConfirmedAt: item.coa_confirmed_at,
    }))

    return res.status(200).json({
      items: reviews,
      count: reviews.length,
    })
  } catch (error) {
    console.error('Unexpected error in coa-review-queue:', error)
    return res.status(500).json({ error: 'Internal server error' })
  }
}
