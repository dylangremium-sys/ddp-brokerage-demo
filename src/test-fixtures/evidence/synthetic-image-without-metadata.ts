import type { EvidenceRecord } from '../../lib/evidenceConflictDetection'
import type { EvidenceAnalysisInput } from '../../lib/evidenceAiProvider'
import type {
  EvidenceExtractionDraft,
  EvidenceAiProviderOutput,
} from '../../lib/evidenceAiTypes'

// ─── SYNTHETIC FIXTURE — image with no metadata ─────────────────────────────
//
// Entirely fictional. A submitted image that carries NO embedded metadata
// (no capture time, geotag, or device). Extraction must remain honest about
// this: values it cannot read are proposed as null, and it must not invent
// provenance it does not have.

export const syntheticImageRecord: EvidenceRecord = {
  id: 'ev-image-nometa-001',
  evidenceType: 'image',
  ownerType: 'supplier',
  // No dates / checksum captured — the image had no metadata to extract them from.
}

export const syntheticImageWithoutMetadataInput: EvidenceAnalysisInput = {
  evidenceId: 'ev-image-nometa-001',
  declaredType: 'image',
  content: 'IMAGE (SYNTHETIC / FICTIONAL): a photograph of packaged product. No embedded metadata is present in the file.',
  // metadata intentionally omitted — this is the whole point of the fixture.
}

// A well-formed extraction draft honestly reporting an unreadable capture time
// as null, while still pointing at where it looked (provenance is required even
// for a null value only when the value is non-null; here the null value carries
// a source reference anyway to document the absence).
export function syntheticImageExtractionOutput(
  generatedAt = '2026-02-01T00:00:00.000Z',
): EvidenceAiProviderOutput<EvidenceExtractionDraft> {
  return {
    value: {
      extractedValues: [
        {
          fieldKey: 'capture_timestamp',
          value: null,
          confidence: 0.1,
          sourceReferences: [{ fieldLabel: 'exif', excerpt: 'no metadata present' }],
        },
        {
          fieldKey: 'visible_label_text',
          value: 'BATCH-SYN-0001',
          confidence: 0.55,
          sourceReferences: [{ section: 'front-of-pack', excerpt: 'BATCH-SYN-0001' }],
        },
      ],
      possibleRelationships: [
        { relatesToEvidenceId: 'ev-coa-complete-001', natureOfRelationship: 'the visible batch label may match this CoA; a reviewer should confirm' },
      ],
    },
    confidence: 0.4,
    provenance: {
      actorType: 'ai_assistant',
      promptVersion: { id: 'evidence-extract-v0', description: 'synthetic test prompt' },
      modelInfo: { provider: 'mock-provider', model: 'mock-model' },
      generatedAt,
      requiresHumanReview: true,
    },
  }
}
