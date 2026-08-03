import React, { useState, useEffect } from 'react'

interface DocumentExtraction {
  id: string
  document_id: string
  report_number: string | null
  field_name: string
  field_value_text: string | null
  confidence_score: number
  extracted_at: string
  needs_review: boolean
}

interface ReviewState {
  extractedFields: DocumentExtraction[]
  selectedValues: Record<string, string | null>
  saved: boolean
  error: string | null
}

const CONFIDENCE_THRESHOLD = 0.7

export function DDPCoaReview({
  documentId,
  onBack,
  onAccept,
  onGetExtractions,
}: {
  documentId: string
  onBack: () => void
  onAccept: (acceptedFields: Record<string, string | null>) => Promise<void>
  onGetExtractions: (documentId: string) => Promise<DocumentExtraction[]>
}): React.JSX.Element {
  const [state, setState] = useState<ReviewState>({
    extractedFields: [],
    selectedValues: {},
    saved: false,
    error: null,
  })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const load = async () => {
      try {
        const extractions = await onGetExtractions(documentId)
        setState((s) => ({
          ...s,
          extractedFields: extractions,
          selectedValues: Object.fromEntries(
            extractions.map((f) => [f.field_name, f.field_value_text]),
          ),
        }))
      } catch {
        setState((s) => ({
          ...s,
          error: 'Failed to load extracted values.',
        }))
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [documentId, onGetExtractions])

  const handleAccept = async () => {
    setSaving(true)
    try {
      await onAccept(state.selectedValues)
      setState((s) => ({ ...s, saved: true, error: null }))
      setTimeout(() => onBack(), 1000)
    } catch {
      setState((s) => ({
        ...s,
        error: 'Failed to save. Please try again.',
      }))
    } finally {
      setSaving(false)
    }
  }

  const handleReject = () => {
    if (confirm('Reject all extracted values and return?')) {
      onBack()
    }
  }

  const groupedByReport = state.extractedFields.reduce(
    (acc, field) => {
      const report = field.report_number || 'Unknown Report'
      if (!acc[report]) acc[report] = []
      acc[report].push(field)
      return acc
    },
    {} as Record<string, DocumentExtraction[]>,
  )

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <p>Loading extracted values...</p>
      </div>
    )
  }

  const belowThresholdCount = state.extractedFields.filter(
    (f) => f.confidence_score < CONFIDENCE_THRESHOLD,
  ).length

  return (
    <div className="p-6">
      <div className="mb-6">
        <button
          onClick={onBack}
          className="text-blue-600 hover:text-blue-800 mb-4"
        >
          ← Back
        </button>
        <h2 className="text-2xl font-bold mb-2">Review COA Extraction</h2>
        <p className="text-gray-600">
          {state.extractedFields.length} fields extracted from {Object.keys(groupedByReport).length} report(s)
        </p>
      </div>

      {state.error && (
        <div className="bg-red-50 border border-red-200 rounded p-4 mb-6">
          <p className="text-red-700">{state.error}</p>
        </div>
      )}

      {belowThresholdCount > 0 && (
        <div className="bg-yellow-50 border border-yellow-200 rounded p-4 mb-6">
          <p className="text-yellow-800">
            <strong>{belowThresholdCount} field(s) below 0.7 confidence.</strong> You must review these before accepting.
          </p>
        </div>
      )}

      {state.saved && (
        <div className="bg-green-50 border border-green-200 rounded p-4 mb-6">
          <p className="text-green-700">✓ Extraction saved successfully.</p>
        </div>
      )}

      <div className="space-y-8">
        {Object.entries(groupedByReport).map(([reportNumber, fields]) => (
          <div key={reportNumber} className="border rounded-lg p-6">
            <h3 className="text-lg font-semibold mb-4">
              {reportNumber}
            </h3>

            <div className="space-y-4">
              {fields.map((field) => {
                const belowThreshold = field.confidence_score < CONFIDENCE_THRESHOLD
                return (
                  <div key={field.id} className={`p-4 rounded border ${
                    belowThreshold ? 'border-yellow-300 bg-yellow-50' : 'border-gray-200'
                  }`}>
                    <div className="flex justify-between items-start mb-2">
                      <label className="font-medium text-gray-900">
                        {field.field_name}
                      </label>
                      <span className={`text-sm px-2 py-1 rounded ${
                        field.confidence_score >= CONFIDENCE_THRESHOLD
                          ? 'bg-green-100 text-green-800'
                          : 'bg-yellow-100 text-yellow-800'
                      }`}>
                        {(field.confidence_score * 100).toFixed(0)}%
                      </span>
                    </div>

                    <textarea
                      value={state.selectedValues[field.field_name] || ''}
                      onChange={(e) =>
                        setState((s) => ({
                          ...s,
                          selectedValues: {
                            ...s.selectedValues,
                            [field.field_name]: e.target.value,
                          },
                        }))
                      }
                      className="w-full p-2 border rounded font-mono text-sm"
                      rows={2}
                      disabled={saving}
                    />

                    {belowThreshold && (
                      <p className="text-sm text-yellow-700 mt-2">
                        ⚠ Below confidence threshold. Review carefully.
                      </p>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="flex gap-4 mt-8">
        <button
          onClick={handleAccept}
          disabled={saving || belowThresholdCount > 0}
          className={`px-6 py-2 rounded font-medium ${
            belowThresholdCount > 0
              ? 'bg-gray-300 text-gray-600 cursor-not-allowed'
              : 'bg-green-600 text-white hover:bg-green-700'
          } ${saving ? 'opacity-50' : ''}`}
        >
          {saving ? 'Saving...' : 'Accept Extraction'}
        </button>

        <button
          onClick={handleReject}
          disabled={saving}
          className="px-6 py-2 rounded font-medium bg-gray-200 text-gray-800 hover:bg-gray-300"
        >
          Reject
        </button>
      </div>
    </div>
  )
}
