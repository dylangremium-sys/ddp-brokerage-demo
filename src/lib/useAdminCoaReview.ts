import { useState } from 'react'
import type { InventoryItem } from '../types'

interface UseAdminCoaReviewReturn {
  state: {
    isReviewing: boolean
    reviewError: string | null
    reviewSuccess: boolean
  }
  startReview: (item: InventoryItem) => void
  approveCoA: (item: InventoryItem, notes?: string) => Promise<void>
  requestCorrection: (item: InventoryItem, notes: string) => Promise<void>
  rejectCoA: (item: InventoryItem, notes: string) => Promise<void>
  clearState: () => void
}

/**
 * Manages the admin Gate 3 COA review workflow.
 * Handles approval, correction requests, and rejections with persistence.
 */
export function useAdminCoaReview(): UseAdminCoaReviewReturn {
  const [isReviewing, setIsReviewing] = useState(false)
  const [reviewError, setReviewError] = useState<string | null>(null)
  const [reviewSuccess, setReviewSuccess] = useState(false)

  const startReview = (item: InventoryItem) => {
    if (!item.coaExtractedJson || !item.coaFarmerEntryJson) {
      setReviewError('Missing COA data for review')
      return
    }
    setIsReviewing(true)
    setReviewError(null)
    setReviewSuccess(false)
  }

  const approveCoA = async (item: InventoryItem, notes?: string) => {
    setReviewError(null)
    try {
      const response = await fetch('/api/admin/coa-review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          itemId: item.id,
          action: 'approve',
          adminNotes: notes || null,
        }),
      })

      if (!response.ok) {
        throw new Error(`Failed to approve COA: ${response.statusText}`)
      }

      setReviewSuccess(true)
      setIsReviewing(false)
    } catch (err) {
      setReviewError(err instanceof Error ? err.message : 'Failed to approve COA')
      throw err
    }
  }

  const requestCorrection = async (item: InventoryItem, notes: string) => {
    if (!notes.trim()) {
      throw new Error('Correction feedback is required')
    }

    setReviewError(null)
    try {
      const response = await fetch('/api/admin/coa-review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          itemId: item.id,
          action: 'request_correction',
          adminNotes: notes,
        }),
      })

      if (!response.ok) {
        throw new Error(`Failed to request correction: ${response.statusText}`)
      }

      setReviewSuccess(true)
      setIsReviewing(false)
    } catch (err) {
      setReviewError(err instanceof Error ? err.message : 'Failed to request correction')
      throw err
    }
  }

  const rejectCoA = async (item: InventoryItem, notes: string) => {
    if (!notes.trim()) {
      throw new Error('Rejection reason is required')
    }

    setReviewError(null)
    try {
      const response = await fetch('/api/admin/coa-review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          itemId: item.id,
          action: 'reject',
          adminNotes: notes,
        }),
      })

      if (!response.ok) {
        throw new Error(`Failed to reject COA: ${response.statusText}`)
      }

      setReviewSuccess(true)
      setIsReviewing(false)
    } catch (err) {
      setReviewError(err instanceof Error ? err.message : 'Failed to reject COA')
      throw err
    }
  }

  const clearState = () => {
    setIsReviewing(false)
    setReviewError(null)
    setReviewSuccess(false)
  }

  return {
    state: {
      isReviewing,
      reviewError,
      reviewSuccess,
    },
    startReview,
    approveCoA,
    requestCorrection,
    rejectCoA,
    clearState,
  }
}
