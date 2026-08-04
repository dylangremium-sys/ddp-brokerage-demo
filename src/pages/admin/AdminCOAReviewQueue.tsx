import React, { useEffect, useState } from 'react'
import type { InventoryItem } from '../../types'
import { AdminCOAReview } from './AdminCOAReview'
import { useAdminCoaReview } from '../../lib/useAdminCoaReview'

interface AdminCOAReviewQueueProps {
  onBack: () => void
}

interface QueueState {
  items: InventoryItem[]
  loading: boolean
  error: string | null
}

/**
 * Admin COA Review Queue
 *
 * Displays a list of COA submissions pending admin review (Gate 3).
 * Admin can select an item to review, then approve, request correction, or reject.
 *
 * Fetches from /api/admin/coa-review-queue:
 * - coaConfirmationStatus = 'confirmed' or 'flagged_for_review' (farmer submitted)
 * - coaAdminStatus IS NULL or = 'needs_correction' (not yet reviewed, or needs correction)
 */
export function AdminCOAReviewQueue({ onBack }: AdminCOAReviewQueueProps): React.JSX.Element {
  const [selectedItem, setSelectedItem] = useState<InventoryItem | null>(null)
  const [queue, setQueue] = useState<QueueState>({ items: [], loading: true, error: null })
  const { state, approveCoA, requestCorrection, rejectCoA, clearState } = useAdminCoaReview()

  // Fetch pending COA reviews when component mounts
  useEffect(() => {
    const fetchQueue = async () => {
      try {
        setQueue({ items: [], loading: true, error: null })

        // Get auth token from localStorage (set by Supabase auth)
        const token = localStorage.getItem('sb_auth_token')
        if (!token) {
          setQueue({ items: [], loading: false, error: 'Authentication required' })
          return
        }

        const response = await fetch('/api/admin/coa-review-queue', {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        })

        if (!response.ok) {
          const data = await response.json()
          throw new Error(data.error || `HTTP ${response.status}`)
        }

        const data = await response.json()
        setQueue({ items: data.items || [], loading: false, error: null })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to fetch queue'
        setQueue({ items: [], loading: false, error: message })
      }
    }

    void fetchQueue()
  }, [])

  // Refresh queue after successful review action
  useEffect(() => {
    if (state.reviewSuccess && selectedItem) {
      // Trigger refetch by clearing and reloading
      setSelectedItem(null)
      clearState()

      // Refetch queue
      const timer = setTimeout(() => {
        window.location.reload() // Simple approach; production could use proper refetch
      }, 1000)

      return () => clearTimeout(timer)
    }
  }, [state.reviewSuccess, selectedItem, clearState])

  // Show detail view if item selected
  if (selectedItem) {
    return (
      <AdminCOAReview
        item={selectedItem}
        onApprove={async (notes) => {
          await approveCoA(selectedItem, notes)
          if (state.reviewSuccess) {
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

  // Show queue list
  return (
    <div className="space-y-6 p-6">
      <div className="border-b pb-4">
        <h1 className="text-3xl font-bold">COA Review Queue</h1>
        <p className="text-gray-600 mt-2">Gate 3: Admin verification of farmer COA submissions</p>
      </div>

      {/* Loading state */}
      {queue.loading && (
        <div className="p-6 bg-blue-50 border border-blue-200 rounded-lg">
          <p className="text-blue-900">Loading pending reviews...</p>
        </div>
      )}

      {/* Error state */}
      {queue.error && (
        <div className="p-6 bg-red-50 border border-red-200 rounded-lg">
          <h3 className="text-red-900 font-semibold mb-2">Error loading queue</h3>
          <p className="text-red-700 text-sm">{queue.error}</p>
        </div>
      )}

      {/* Empty state */}
      {!queue.loading && !queue.error && queue.items.length === 0 && (
        <div className="p-6 bg-green-50 border border-green-200 rounded-lg">
          <h3 className="text-green-900 font-semibold mb-2">Queue is empty</h3>
          <p className="text-green-700 text-sm">All pending COA reviews have been completed.</p>
        </div>
      )}

      {/* Queue list */}
      {!queue.loading && queue.items.length > 0 && (
        <div className="space-y-3">
          <div className="text-sm text-gray-600 mb-3">
            {queue.items.length} item{queue.items.length !== 1 ? 's' : ''} pending review
          </div>
          {queue.items.map((item) => (
            <button
              key={item.id}
              onClick={() => setSelectedItem(item)}
              className="w-full text-left p-4 border rounded-lg hover:border-blue-500 hover:bg-blue-50 transition"
            >
              <div className="flex justify-between items-start">
                <div className="flex-1">
                  <h3 className="font-semibold text-gray-900">{item.farmerName || 'Unknown Farmer'}</h3>
                  <p className="text-sm text-gray-600 mt-1">
                    Status: <span className="font-medium">{item.coaConfirmationStatus}</span>
                  </p>
                  {item.coaMismatchFlags && item.coaMismatchFlags.length > 0 && (
                    <p className="text-sm text-red-600 mt-1">
                      {item.coaMismatchFlags.length} mismatch{item.coaMismatchFlags.length !== 1 ? 'es' : ''}
                    </p>
                  )}
                </div>
                <div className="text-xs text-gray-500 text-right">
                  {item.coaConfirmedAt && (
                    <div>{new Date(item.coaConfirmedAt).toLocaleDateString()}</div>
                  )}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      <div className="flex gap-3 pt-6 border-t">
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
