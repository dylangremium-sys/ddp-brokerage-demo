import React, { useState } from 'react'
import type { InventoryItem } from '../../types'
import type { ComparisonResult } from '../../lib/coaFieldComparison'
import { compareCoaFields } from '../../lib/coaFieldComparison'

interface AdminCOAReviewProps {
  item: InventoryItem
  onApprove: (notes?: string) => Promise<void>
  onRequestCorrection: (notes: string) => Promise<void>
  onReject: (notes: string) => Promise<void>
  onBack: () => void
}

export function AdminCOAReview({
  item,
  onApprove,
  onRequestCorrection,
  onReject,
  onBack,
}: AdminCOAReviewProps): React.JSX.Element {
  const [adminNotes, setAdminNotes] = useState('')
  const [isProcessing, setIsProcessing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Validate that we have both extracted and farmer entry data
  if (!item.coaExtractedJson || !item.coaFarmerEntryJson) {
    return (
      <div className="p-6 bg-red-50 border border-red-200 rounded-lg">
        <h3 className="text-red-900 font-semibold mb-2">Missing COA Data</h3>
        <p className="text-red-700 text-sm mb-4">
          This item does not have both AI extraction and farmer confirmation data. Cannot proceed with Gate 3 review.
        </p>
        <button
          onClick={onBack}
          className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700"
        >
          Back
        </button>
      </div>
    )
  }

  // Run comparison to highlight mismatches
  const comparison = compareCoaFields(item.coaExtractedJson, item.coaFarmerEntryJson)

  const handleApprove = async () => {
    setIsProcessing(true)
    setError(null)
    try {
      await onApprove(adminNotes || undefined)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to approve COA')
    } finally {
      setIsProcessing(false)
    }
  }

  const handleRequestCorrection = async () => {
    if (!adminNotes.trim()) {
      setError('Please provide feedback for the farmer about what needs correction')
      return
    }
    setIsProcessing(true)
    setError(null)
    try {
      await onRequestCorrection(adminNotes)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to request correction')
    } finally {
      setIsProcessing(false)
    }
  }

  const handleReject = async () => {
    if (!adminNotes.trim()) {
      setError('Please provide feedback for the farmer about why the COA was rejected')
      return
    }
    setIsProcessing(true)
    setError(null)
    try {
      await onReject(adminNotes)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reject COA')
    } finally {
      setIsProcessing(false)
    }
  }

  const FIELDS_TOTAL = 8
  const exactMatches = FIELDS_TOTAL - (comparison.criticalMismatches.length + comparison.warnings.length)

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="border-b pb-4">
        <h1 className="text-2xl font-bold mb-2">COA Review — Gate 3 (Admin)</h1>
        <div className="grid grid-cols-3 gap-4 text-sm">
          <div>
            <p className="text-gray-600">Product</p>
            <p className="font-semibold">{item.productName}</p>
          </div>
          <div>
            <p className="text-gray-600">Farmer</p>
            <p className="font-semibold">{item.farmerName}</p>
          </div>
          <div>
            <p className="text-gray-600">Batch #</p>
            <p className="font-semibold">{item.batchNumber}</p>
          </div>
        </div>
      </div>

      {/* Comparison Results */}
      <CoaComparisonGrid
        comparison={comparison}
        extractedData={item.coaExtractedJson}
        farmerData={item.coaFarmerEntryJson}
      />

      {/* Summary Stats */}
      <div className="grid grid-cols-3 gap-4">
        <div className="p-4 bg-green-50 border border-green-200 rounded">
          <p className="text-sm text-green-700">Exact Matches</p>
          <p className="text-2xl font-bold text-green-900">{exactMatches}</p>
        </div>
        <div className="p-4 bg-yellow-50 border border-yellow-200 rounded">
          <p className="text-sm text-yellow-700">Warnings (Tolerance)</p>
          <p className="text-2xl font-bold text-yellow-900">{comparison.warnings.length}</p>
        </div>
        <div className="p-4 bg-red-50 border border-red-200 rounded">
          <p className="text-sm text-red-700">Critical Mismatches</p>
          <p className="text-2xl font-bold text-red-900">{comparison.criticalMismatches.length}</p>
        </div>
      </div>

      {/* Admin Notes */}
      <div>
        <label className="block text-sm font-semibold mb-2">Admin Feedback / Notes</label>
        <textarea
          value={adminNotes}
          onChange={(e) => {
            setAdminNotes(e.target.value)
            setError(null)
          }}
          placeholder="Enter any notes, corrections, or feedback for the farmer..."
          className="w-full h-24 p-3 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <p className="text-xs text-gray-500 mt-1">Notes are required for corrections or rejections.</p>
      </div>

      {/* Error Display */}
      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded">
          <p className="text-red-700 text-sm">{error}</p>
        </div>
      )}

      {/* Action Buttons */}
      <div className="flex gap-3 justify-between pt-4 border-t">
        <button
          onClick={onBack}
          disabled={isProcessing}
          className="px-4 py-2 text-gray-700 bg-gray-200 rounded hover:bg-gray-300 disabled:opacity-50"
        >
          Back
        </button>

        <div className="flex gap-3">
          {/* Reject Button - Red */}
          <button
            onClick={handleReject}
            disabled={isProcessing}
            className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
          >
            {isProcessing ? 'Processing...' : 'Reject'}
          </button>

          {/* Request Correction Button - Yellow */}
          <button
            onClick={handleRequestCorrection}
            disabled={isProcessing}
            className="px-4 py-2 bg-yellow-600 text-white rounded hover:bg-yellow-700 disabled:opacity-50"
          >
            {isProcessing ? 'Processing...' : 'Request Correction'}
          </button>

          {/* Approve Button - Green */}
          <button
            onClick={handleApprove}
            disabled={isProcessing}
            className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50"
          >
            {isProcessing ? 'Processing...' : 'Approve'}
          </button>
        </div>
      </div>
    </div>
  )
}

function CoaComparisonGrid({
  comparison,
  extractedData,
  farmerData,
}: {
  comparison: ComparisonResult
  extractedData: Record<string, string | null>
  farmerData: Record<string, string | null>
}): React.JSX.Element {
  const fieldsToDisplay = [
    'sample_name',
    'batch_reference',
    'thc_pct',
    'cbd_pct',
    'moisture_pct',
    'lab_name',
    'report_number',
    'test_date',
  ]

  const getStatusColor = (fieldName: string): 'green' | 'yellow' | 'red' => {
    if (comparison.criticalMismatches.some((m) => m.fieldName === fieldName)) {
      return 'red'
    }
    if (comparison.warnings.some((w) => w.fieldName === fieldName)) {
      return 'yellow'
    }
    return 'green'
  }

  const getStatusBg = (color: string): string => {
    switch (color) {
      case 'red':
        return 'bg-red-50 border-l-4 border-red-500'
      case 'yellow':
        return 'bg-yellow-50 border-l-4 border-yellow-500'
      case 'green':
        return 'bg-green-50 border-l-4 border-green-500'
      default:
        return ''
    }
  }

  const getStatusBadge = (color: string): string => {
    switch (color) {
      case 'red':
        return 'bg-red-100 text-red-800'
      case 'yellow':
        return 'bg-yellow-100 text-yellow-800'
      case 'green':
        return 'bg-green-100 text-green-800'
      default:
        return ''
    }
  }

  return (
    <div className="space-y-3">
      <h2 className="text-lg font-semibold">Field Comparison</h2>
      {fieldsToDisplay.map((fieldName) => {
        const extracted = extractedData[fieldName] ?? '—'
        const farmer = farmerData[fieldName] ?? '—'
        const status = getStatusColor(fieldName)

        return (
          <div
            key={fieldName}
            className={`p-3 rounded ${getStatusBg(status)}`}
          >
            <div className="flex justify-between items-start mb-2">
              <div className="font-semibold text-gray-900 capitalize">
                {fieldName.replace(/_/g, ' ')}
              </div>
              <span className={`text-xs px-2 py-1 rounded font-semibold ${getStatusBadge(status)}`}>
                {status === 'red' ? 'Critical' : status === 'yellow' ? 'Warning' : 'Match'}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-gray-600">AI Extraction</p>
                <p className="font-mono text-gray-900">{extracted}</p>
              </div>
              <div>
                <p className="text-gray-600">Farmer Entry</p>
                <p className="font-mono text-gray-900">{farmer}</p>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
