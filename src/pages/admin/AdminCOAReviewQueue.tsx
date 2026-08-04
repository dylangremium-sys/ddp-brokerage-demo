import React, { useState } from 'react'
import type { InventoryItem } from '../../types'
import { AdminCOAReview } from './AdminCOAReview'
import { useAdminCoaReview } from '../../lib/useAdminCoaReview'

interface AdminCOAReviewQueueProps {
  onBack: () => void
}

/**
 * Admin COA Review Queue
 *
 * Displays a list of COA submissions pending admin review (Gate 3).
 * Admin can select an item to review, then approve, request correction, or reject.
 *
 * TODO: Wire database query to fetch items with:
 * - coaConfirmationStatus = 'confirmed' or 'flagged_for_review'
 * - coaAdminStatus is null or 'needs_correction'
 *
 * For now, renders a placeholder.
 */
export function AdminCOAReviewQueue({ onBack }: AdminCOAReviewQueueProps): React.JSX.Element {
  const [selectedItem, setSelectedItem] = useState<InventoryItem | null>(null)
  const { state, approveCoA, requestCorrection, rejectCoA, clearState } = useAdminCoaReview()

  if (selectedItem) {
    return (
      <AdminCOAReview
        item={selectedItem}
        onApprove={async (notes) => {
          await approveCoA(selectedItem, notes)
          if (state.reviewSuccess) {
            // Reset for next item or show confirmation
            setSelectedItem(null)
            clearState()
          }
        }}
        onRequestCorrection={async (notes) => {
          await requestCorrection(selectedItem, notes)
          if (state.reviewSuccess) {
            setSelectedItem(null)
            clearState()
          }
        }}
        onReject={async (notes) => {
          await rejectCoA(selectedItem, notes)
          if (state.reviewSuccess) {
            setSelectedItem(null)
            clearState()
          }
        }}
        onBack={() => {
          setSelectedItem(null)
          clearState()
        }}
      />
    )
  }

  return (
    <div className="space-y-6 p-6">
      <div className="border-b pb-4">
        <h1 className="text-3xl font-bold">COA Review Queue</h1>
        <p className="text-gray-600 mt-2">Gate 3: Admin verification of farmer COA submissions</p>
      </div>

      {/* TODO: Show pending items list */}
      <div className="p-6 bg-blue-50 border border-blue-200 rounded-lg">
        <h3 className="text-blue-900 font-semibold mb-2">Queue Ready for Integration</h3>
        <p className="text-blue-700 text-sm mb-4">
          This page needs a database query to fetch pending COA reviews. The AdminCOAReview component
          is ready to use. Query items where:
        </p>
        <pre className="bg-white p-3 rounded text-xs border border-blue-200 mb-4">
{`coaConfirmationStatus IN ('confirmed', 'flagged_for_review')
AND (coaAdminStatus IS NULL OR coaAdminStatus = 'needs_correction')`}
        </pre>
        <p className="text-blue-700 text-sm">
          Once items are loaded, render them in a list. Clicking an item calls AdminCOAReview.
        </p>
      </div>

      <div className="flex gap-3">
        <button
          onClick={onBack}
          className="px-4 py-2 text-gray-700 bg-gray-200 rounded hover:bg-gray-300"
        >
          Back
        </button>
      </div>
    </div>
  )
}
