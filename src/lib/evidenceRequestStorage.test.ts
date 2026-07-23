import { describe, it, expect } from 'vitest'
import {
  EVIDENCE_BUCKET_FILE_SIZE_LIMIT_BYTES,
  EVIDENCE_MAX_SIZE_DEFAULT_BYTES,
  EVIDENCE_MAX_SIZE_VIDEO_BYTES,
  EVIDENCE_REQUEST_BUCKET,
  allowedMimeTypesForCategory,
  evidenceMaxSizeBytes,
  evidenceObjectPath,
  isEvidenceFilenameAllowed,
  isEvidenceMimeAllowed,
  sanitizeEvidenceFilename,
  validateEvidenceUploadCandidate,
} from './evidenceRequestStorage'
import { EVIDENCE_REQUEST_CATEGORIES } from '../domain/evidenceRequests'

/**
 * Contract conformance for the upload/storage boundary (v1.5 §7).
 *
 * These assertions are the CLIENT half of a rule the database also enforces.
 * They must never be read as the boundary itself (§17.13 makes client-only
 * MIME/size/path checks a stop condition) — the point is that the two halves
 * agree, so the client never promises something the server will refuse or, far
 * worse, permits something the server would have caught.
 */


/**
 * Source text is read with Vite's `?raw` glob rather than node:fs — the repo
 * convention (see operationsDeskRouting.test.ts), and the reason `src` compiles
 * without node type definitions.
 */
function raw(glob: Record<string, string>): string {
  return Object.values(glob)[0] ?? ''
}

const MIGRATION = raw(import.meta.glob('../../24_EVIDENCE_REQUEST_RESOLUTION_HARDENING.sql', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)
const STORAGE = raw(import.meta.glob('../../24_EVIDENCE_REQUEST_RESOLUTION_STORAGE.sql', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)

describe('bucket configuration (§7.1, §7.10)', () => {
  it('uses the canonical bucket name', () => {
    expect(EVIDENCE_REQUEST_BUCKET).toBe('evidence-request-files')
    expect(STORAGE).toContain("'evidence-request-files'")
  })

  it('declares the 100 MiB platform ceiling that the migration installs', () => {
    expect(EVIDENCE_BUCKET_FILE_SIZE_LIMIT_BYTES).toBe(104_857_600)
    expect(STORAGE).toContain('104857600')
  })

  it('is created private — no public URL is permitted (§7.1, §19.14)', () => {
    expect(STORAGE).toMatch(/public\s*=\s*false/)
  })
})

describe('MIME allow-list mirrors evidence_mime_allowed (§7.3)', () => {
  it('coa accepts PDF only', () => {
    expect(allowedMimeTypesForCategory('coa')).toEqual(['application/pdf'])
    expect(isEvidenceMimeAllowed('coa', 'image/jpeg')).toBe(false)
    expect(isEvidenceMimeAllowed('coa', 'application/pdf')).toBe(true)
  })

  it('inventory_photo accepts the three image types only', () => {
    expect(allowedMimeTypesForCategory('inventory_photo')).toEqual([
      'image/jpeg',
      'image/png',
      'image/webp',
    ])
    expect(isEvidenceMimeAllowed('inventory_photo', 'application/pdf')).toBe(false)
  })

  it('mp4 is accepted ONLY for inventory_video', () => {
    expect(isEvidenceMimeAllowed('inventory_video', 'video/mp4')).toBe(true)
    for (const category of EVIDENCE_REQUEST_CATEGORIES) {
      if (category === 'inventory_video') continue
      expect(isEvidenceMimeAllowed(category, 'video/mp4')).toBe(false)
    }
  })

  it.each(['image/svg+xml', 'text/html', 'application/javascript', 'application/zip',
    'application/x-msdownload', 'application/vnd.ms-excel.sheet.macroEnabled.12',
    'application/octet-stream'])(
    'rejects %s for every category (§7.3 disallowed formats)',
    mime => {
      for (const category of EVIDENCE_REQUEST_CATEGORIES) {
        expect(isEvidenceMimeAllowed(category, mime)).toBe(false)
      }
    },
  )

  it('rejects a missing MIME rather than defaulting to permitted', () => {
    expect(isEvidenceMimeAllowed('other', null)).toBe(false)
    expect(isEvidenceMimeAllowed('other', undefined)).toBe(false)
    expect(isEvidenceMimeAllowed('other', '')).toBe(false)
  })
})

describe('size limits mirror evidence_max_size_bytes (§7.3)', () => {
  it('grants 100 MB only to inventory_video with video/mp4', () => {
    expect(evidenceMaxSizeBytes('inventory_video', 'video/mp4')).toBe(EVIDENCE_MAX_SIZE_VIDEO_BYTES)
    expect(EVIDENCE_MAX_SIZE_VIDEO_BYTES).toBe(104_857_600)
  })

  it('applies 20 MB everywhere else', () => {
    expect(evidenceMaxSizeBytes('coa', 'application/pdf')).toBe(EVIDENCE_MAX_SIZE_DEFAULT_BYTES)
    expect(evidenceMaxSizeBytes('inventory_photo', 'image/png')).toBe(20_971_520)
    // A PDF stays at 20 MB even in the video category — the pair, not the
    // category alone, earns the larger limit.
    expect(evidenceMaxSizeBytes('inventory_video', 'application/pdf')).toBe(20_971_520)
  })

  it('matches the byte constants in the migration', () => {
    expect(MIGRATION).toContain('104857600')
    expect(MIGRATION).toContain('20971520')
  })

  it('never exceeds the bucket ceiling (§7.10.4)', () => {
    for (const category of EVIDENCE_REQUEST_CATEGORIES) {
      for (const mime of allowedMimeTypesForCategory(category)) {
        expect(evidenceMaxSizeBytes(category, mime)).toBeLessThanOrEqual(
          EVIDENCE_BUCKET_FILE_SIZE_LIMIT_BYTES,
        )
      }
    }
  })
})

describe('filename extension allow-list (§7.3)', () => {
  it('accepts a matching extension', () => {
    expect(isEvidenceFilenameAllowed('coa', 'application/pdf', 'report.pdf')).toBe(true)
    expect(isEvidenceFilenameAllowed('inventory_photo', 'image/jpeg', 'photo.JPG')).toBe(true)
    expect(isEvidenceFilenameAllowed('inventory_photo', 'image/jpeg', 'photo.jpeg')).toBe(true)
  })

  it('rejects a MIME/extension mismatch', () => {
    expect(isEvidenceFilenameAllowed('coa', 'application/pdf', 'report.png')).toBe(false)
    expect(isEvidenceFilenameAllowed('inventory_photo', 'image/png', 'photo.jpg')).toBe(false)
  })

  it('judges only the FINAL suffix', () => {
    // What a consumer dispatches on is the last extension.
    expect(isEvidenceFilenameAllowed('coa', 'application/pdf', 'payload.pdf.exe')).toBe(false)
    expect(isEvidenceFilenameAllowed('coa', 'application/pdf', 'payload.exe.pdf')).toBe(true)
  })

  it('rejects a path rather than trimming it — no traversal reinterpretation', () => {
    expect(isEvidenceFilenameAllowed('coa', 'application/pdf', '../../etc/passwd.pdf')).toBe(false)
    expect(isEvidenceFilenameAllowed('coa', 'application/pdf', 'dir/report.pdf')).toBe(false)
    expect(isEvidenceFilenameAllowed('coa', 'application/pdf', 'dir\\report.pdf')).toBe(false)
  })

  it('rejects a missing, empty or trailing-dot extension', () => {
    expect(isEvidenceFilenameAllowed('coa', 'application/pdf', 'report')).toBe(false)
    expect(isEvidenceFilenameAllowed('coa', 'application/pdf', 'report.')).toBe(false)
    expect(isEvidenceFilenameAllowed('coa', 'application/pdf', '')).toBe(false)
    expect(isEvidenceFilenameAllowed('coa', 'application/pdf', '   ')).toBe(false)
  })

  it('is conjunctive — a disallowed MIME fails even with a plausible extension', () => {
    expect(isEvidenceFilenameAllowed('coa', 'image/png', 'photo.png')).toBe(false)
  })
})

describe('validateEvidenceUploadCandidate returns contract error codes (§9.3)', () => {
  it('accepts a legitimate COA PDF', () => {
    expect(
      validateEvidenceUploadCandidate({
        category: 'coa',
        filename: 'coa.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1_000_000,
      }),
    ).toEqual({ ok: true })
  })

  it('rejects SVG with FILE_TYPE_NOT_ALLOWED', () => {
    const result = validateEvidenceUploadCandidate({
      category: 'other',
      filename: 'logo.svg',
      mimeType: 'image/svg+xml',
      sizeBytes: 500,
    })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('FILE_TYPE_NOT_ALLOWED')
  })

  it('rejects an executable disguised by its declared MIME', () => {
    const result = validateEvidenceUploadCandidate({
      category: 'other',
      filename: 'payload.exe',
      mimeType: 'application/pdf',
      sizeBytes: 500,
    })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('FILE_TYPE_NOT_ALLOWED')
  })

  it('rejects an oversized PDF with FILE_TOO_LARGE', () => {
    const result = validateEvidenceUploadCandidate({
      category: 'coa',
      filename: 'huge.pdf',
      mimeType: 'application/pdf',
      sizeBytes: EVIDENCE_MAX_SIZE_DEFAULT_BYTES + 1,
    })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('FILE_TOO_LARGE')
  })

  it('rejects an oversized MP4 even though its category allows 100 MB', () => {
    const result = validateEvidenceUploadCandidate({
      category: 'inventory_video',
      filename: 'clip.mp4',
      mimeType: 'video/mp4',
      sizeBytes: EVIDENCE_MAX_SIZE_VIDEO_BYTES + 1,
    })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('FILE_TOO_LARGE')
  })

  it('accepts an MP4 exactly at the limit', () => {
    expect(
      validateEvidenceUploadCandidate({
        category: 'inventory_video',
        filename: 'clip.mp4',
        mimeType: 'video/mp4',
        sizeBytes: EVIDENCE_MAX_SIZE_VIDEO_BYTES,
      }),
    ).toEqual({ ok: true })
  })

  it('rejects an empty file', () => {
    const result = validateEvidenceUploadCandidate({
      category: 'coa',
      filename: 'empty.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 0,
    })
    expect(result.ok).toBe(false)
  })
})

describe('canonical path construction (§7.2)', () => {
  it('builds farm/request/response/attachment/filename', () => {
    expect(
      evidenceObjectPath({
        farmId: 'farm-1',
        requestId: 'req-1',
        responseId: 'resp-1',
        attachmentId: 'att-1',
        filename: 'report.pdf',
      }),
    ).toBe('farm-1/req-1/resp-1/att-1/report.pdf')
  })

  it('sanitizes the path filename while the original is stored separately', () => {
    expect(sanitizeEvidenceFilename('my report (final).pdf')).toBe('my_report__final_.pdf')
    expect(sanitizeEvidenceFilename('../escape.pdf')).toBe('.._escape.pdf')
  })

  it('never produces an empty path segment', () => {
    expect(sanitizeEvidenceFilename('')).toBe('file')
    expect(sanitizeEvidenceFilename('???')).toBe('___')
  })

  it('matches the migration path template', () => {
    expect(MIGRATION).toContain(
      "req.farm_id || '/' || p_request_id || '/' || p_response_id || '/' || new_id || '/' || sanitized",
    )
  })
})
