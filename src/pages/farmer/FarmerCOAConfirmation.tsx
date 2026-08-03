/**
 * FarmerCOAConfirmation.tsx
 *
 * Gate 2: Farmer entry + AI cross-check (before admin review)
 *
 * When a farmer uploads a COA PDF and fills in their inventory form,
 * this screen:
 * 1. Shows their entered values side-by-side with AI-extracted values
 * 2. Flags exact mismatches (especially strain name, batch reference)
 * 3. Lets them confirm, edit, or flag for admin review
 *
 * The farmer does NOT see the extracted values until this point.
 * The AI extraction happened silently in Gate 1.
 *
 * Business rule: exact match on sample_name required for medical compliance.
 * "Jell Breath" != "Gelato" → must be caught here.
 */

import React, { useState } from 'react'
import {
  compareCoaFields,
  shouldBlockSubmission,
  formatFieldForDisplay,
  type ComparisonResult,
  type FieldMismatch,
} from '../../lib/coaFieldComparison'

export interface FarmerCOAConfirmationProps {
  /** Farmer's entered form values */
  farmerValues: Record<string, string | null>
  /** AI-extracted values from the PDF (Gate 1 output) */
  extractedValues: Record<string, string | null>
  /** Called when farmer confirms and proceeds to persistence */
  onConfirm: (flaggedForReview: boolean) => Promise<void>
  /** Called when farmer wants to go back and edit */
  onCancel: () => void
  isLoading?: boolean
  errorMessage?: string
}

export const FarmerCOAConfirmation: React.FC<FarmerCOAConfirmationProps> = ({
  farmerValues,
  extractedValues,
  onConfirm,
  onCancel,
  isLoading = false,
  errorMessage,
}) => {
  const [comparison] = useState<ComparisonResult>(() =>
    compareCoaFields(farmerValues, extractedValues),
  )
  const [flagForReview, setFlagForReview] = useState(false)
  const [userConfirmedMismatch, setUserConfirmedMismatch] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const hasBlockingMismatches = shouldBlockSubmission(comparison)

  const handleConfirm = async () => {
    setSubmitting(true)
    try {
      await onConfirm(flagForReview)
      // Navigation happens in parent; just await the persistence
    } finally {
      setSubmitting(false)
    }
  }

  // Field pairs to display (most critical fields first)
  const fieldsToCompare = [
    {
      label: 'Sample Name (Strain)',
      farmerField: 'sample_name',
      isCritical: true,
    },
    {
      label: 'Batch Reference',
      farmerField: 'batch_reference',
      isCritical: true,
    },
    {
      label: 'Total THC (%)',
      farmerField: 'total_thc',
      isCritical: false,
    },
    {
      label: 'Total CBD (%)',
      farmerField: 'total_cbd',
      isCritical: false,
    },
    {
      label: 'Moisture (%)',
      farmerField: 'moisture_pct',
      isCritical: false,
    },
  ]

  return (
    <div className="w-full max-w-4xl mx-auto p-6 bg-white rounded-lg shadow">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">
          Review Your Certificate of Analysis
        </h1>
        <p className="mt-2 text-gray-600">
          Please verify that your entered information matches the PDF you uploaded.
          <strong> We need exact matches on strain name and batch reference for medical compliance.</strong>
        </p>
      </div>

      {/* Comparison summary banner */}
      <div
        className={`mb-6 p-4 rounded-lg border ${
          comparison.hasMismatches
            ? hasBlockingMismatches
              ? 'bg-red-50 border-red-300'
              : 'bg-yellow-50 border-yellow-300'
            : 'bg-green-50 border-green-300'
        }`}
      >
        <p
          className={`font-medium ${
            comparison.hasMismatches
              ? hasBlockingMismatches
                ? 'text-red-800'
                : 'text-yellow-800'
              : 'text-green-800'
          }`}
        >
          {comparison.summary}
        </p>
      </div>

      {/* Critical mismatches warning */}
      {comparison.criticalMismatches.length > 0 && (
        <div className="mb-6 p-4 bg-red-100 border-l-4 border-red-600 rounded">
          <h3 className="text-lg font-semibold text-red-800 mb-3">
            ⚠️ Critical Mismatches Found
          </h3>
          <div className="space-y-2">
            {comparison.criticalMismatches.map((m: FieldMismatch) => (
              <div key={m.fieldName} className="text-red-700 text-sm">
                <strong>{m.fieldName}:</strong> {m.reason}
              </div>
            ))}
          </div>
          <label className="mt-4 flex items-center gap-2 text-red-700 font-medium">
            <input
              type="checkbox"
              checked={userConfirmedMismatch}
              onChange={(e) => setUserConfirmedMismatch(e.target.checked)}
              className="w-4 h-4"
            />
            I understand the mismatch and want to proceed anyway
          </label>
        </div>
      )}

      {/* Warnings (non-blocking mismatches) */}
      {comparison.warnings.length > 0 && (
        <div className="mb-6 p-4 bg-yellow-50 border border-yellow-200 rounded">
          <h3 className="text-sm font-semibold text-yellow-800 mb-2">
            ℹ️ Small Variations Found
          </h3>
          <div className="space-y-1">
            {comparison.warnings.map((w: FieldMismatch) => (
              <div key={w.fieldName} className="text-yellow-700 text-xs">
                {w.reason}
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-yellow-700">
            These differences are within acceptable tolerances for testing precision.
          </p>
        </div>
      )}

      {/* Side-by-side comparison table */}
      <div className="mb-6 overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="bg-gray-100 border-b">
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Field</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Your Entry</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700">PDF Extract</th>
              <th className="px-4 py-3 text-center font-semibold text-gray-700 w-12">
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {fieldsToCompare.map((field) => {
              const farmerVal = formatFieldForDisplay(
                farmerValues[field.farmerField],
              )
              const extractedVal = formatFieldForDisplay(
                extractedValues[field.farmerField],
              )
              const isMismatch = farmerVal !== extractedVal && farmerVal !== '—' && extractedVal !== '—'
              const isCriticalMismatch =
                field.isCritical &&
                comparison.criticalMismatches.some((m) => m.fieldName === field.farmerField)
              const isWarning =
                !field.isCritical && comparison.warnings.some((w) => w.fieldName === field.farmerField)

              return (
                <tr
                  key={field.farmerField}
                  className={`border-b ${
                    isCriticalMismatch
                      ? 'bg-red-50'
                      : isWarning
                        ? 'bg-yellow-50'
                        : isMismatch
                          ? 'bg-orange-50'
                          : ''
                  }`}
                >
                  <td className="px-4 py-3 font-medium text-gray-800">{field.label}</td>
                  <td className="px-4 py-3 text-gray-700">{farmerVal}</td>
                  <td className="px-4 py-3 text-gray-700">{extractedVal}</td>
                  <td className="px-4 py-3 text-center">
                    {isCriticalMismatch ? (
                      <span className="inline-block px-3 py-1 bg-red-600 text-white text-xs font-semibold rounded-full">
                        ✕
                      </span>
                    ) : isWarning ? (
                      <span className="inline-block px-3 py-1 bg-yellow-500 text-white text-xs font-semibold rounded-full">
                        ⚠
                      </span>
                    ) : isMismatch ? (
                      <span className="inline-block px-3 py-1 bg-orange-400 text-white text-xs font-semibold rounded-full">
                        ~
                      </span>
                    ) : (
                      <span className="inline-block px-3 py-1 bg-green-600 text-white text-xs font-semibold rounded-full">
                        ✓
                      </span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Error message if submission failed */}
      {errorMessage && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
          {errorMessage}
        </div>
      )}

      {/* Flag for review checkbox */}
      {!hasBlockingMismatches && (
        <label className="mb-6 flex items-start gap-3 p-4 bg-blue-50 border border-blue-200 rounded">
          <input
            type="checkbox"
            checked={flagForReview}
            onChange={(e) => setFlagForReview(e.target.checked)}
            className="mt-1 w-4 h-4"
          />
          <div>
            <div className="font-semibold text-blue-900">Flag for admin review</div>
            <div className="text-sm text-blue-700">
              Check this if you want an admin to review this batch extra carefully,
              even though the values match.
            </div>
          </div>
        </label>
      )}

      {/* Action buttons */}
      <div className="flex gap-4 justify-end">
        <button
          onClick={onCancel}
          disabled={submitting || isLoading}
          className="px-6 py-2 border border-gray-300 rounded-lg text-gray-700 font-medium hover:bg-gray-50 disabled:opacity-50"
        >
          Cancel & Edit
        </button>

        {hasBlockingMismatches && !userConfirmedMismatch && (
          <button
            onClick={() => {
              /* Do nothing — flag for review button should be visible instead */
            }}
            disabled
            className="px-6 py-2 bg-gray-400 text-white rounded-lg font-medium opacity-50 cursor-not-allowed"
          >
            Confirm & Submit
          </button>
        )}

        {hasBlockingMismatches && userConfirmedMismatch && (
          <>
            <button
              onClick={() => {
                setFlagForReview(true)
                handleConfirm()
              }}
              disabled={submitting || isLoading}
              className="px-6 py-2 bg-yellow-600 text-white rounded-lg font-medium hover:bg-yellow-700 disabled:opacity-50"
            >
              {submitting || isLoading ? 'Flagging…' : 'Flag for Review'}
            </button>
            <button
              onClick={handleConfirm}
              disabled={submitting || isLoading}
              className="px-6 py-2 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              {submitting || isLoading ? 'Confirming…' : 'Confirm & Submit'}
            </button>
          </>
        )}

        {!hasBlockingMismatches && (
          <button
            onClick={handleConfirm}
            disabled={submitting || isLoading}
            className="px-6 py-2 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700 disabled:opacity-50"
          >
            {submitting || isLoading ? 'Submitting…' : 'Confirm & Submit'}
          </button>
        )}
      </div>
    </div>
  )
}

export default FarmerCOAConfirmation
