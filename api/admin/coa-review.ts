/**
 * Gate 3: Admin COA Review API
 *
 * Handles three actions:
 * - approve: Accept the COA and mark as approved
 * - request_correction: Ask farmer to resubmit with corrections
 * - reject: Reject the COA submission entirely
 *
 * All actions save to inventory_coa_reviews table with admin decision + timestamp.
 */

export default async function handler(
  req: { method?: string; body?: { itemId?: string; action?: string; adminNotes?: string } },
  res: { status: (code: number) => { json: (data: unknown) => void } },
) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { itemId, action, adminNotes } = req.body ?? {}

  if (!itemId || !action) {
    return res.status(400).json({ error: 'itemId and action are required' })
  }

  if (!['approve', 'request_correction', 'reject'].includes(action)) {
    return res.status(400).json({ error: 'Invalid action' })
  }

  try {
    // TODO: Implement based on database schema
    // This should:
    // 1. Verify user is admin
    // 2. Fetch the inventory item with coaConfirmationStatus = 'pending_admin_review'
    // 3. Update coaAdminStatus, coaAdminNotes, coaAdminReviewedAt
    // 4. If request_correction: set coaConfirmationStatus back to 'pending_confirmation'
    // 5. Audit log the action
    // 6. Notify farmer if correction/rejection
    //
    // For now, return success to allow UI testing

    const statusMap: Record<string, string> = {
      approve: 'approved',
      request_correction: 'needs_correction',
      reject: 'rejected',
    }

    res.status(200).json({
      success: true,
      itemId,
      action,
      newStatus: statusMap[action],
      timestamp: new Date().toISOString(),
      adminNotes: adminNotes || null,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    res.status(500).json({ error: `Failed to process COA review: ${message}` })
  }
}
