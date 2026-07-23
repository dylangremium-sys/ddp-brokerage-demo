/**
 * Evidence-request storage constants and client-side upload validation.
 *
 * Contract of record: v1.5 §7.1 (bucket), §7.2 (canonical path), §7.3 (allowed
 * formats and sizes), §7.4 (upload sequence), §7.10 (bucket ceiling).
 *
 * EVERY predicate here MIRRORS a database function in
 * `24_EVIDENCE_REQUEST_RESOLUTION_HARDENING.sql`:
 *   isEvidenceMimeAllowed        -> public.evidence_mime_allowed
 *   evidenceMaxSizeBytes         -> public.evidence_max_size_bytes
 *   isEvidenceFilenameAllowed    -> public.evidence_filename_extension_allowed
 *
 * The database is authoritative (§17.13: "MIME, size, or path checks are
 * client-only" is a stop condition). These exist so a farmer sees a clear
 * refusal before a 100 MB upload, not so the server can trust the client. A
 * client that skipped every check here would still be refused by
 * `reserve_evidence_attachment` and `finalize_evidence_attachment`.
 */

import type { EvidenceRequestCategory } from '../domain/evidenceRequests'

/** Contract §7.1. Private bucket; no public URL is ever permitted. */
export const EVIDENCE_REQUEST_BUCKET = 'evidence-request-files'

/**
 * Contract §7.10 [v1.4]. The absolute platform ceiling on ONE object, enforced
 * by Supabase Storage before it accepts bytes. Defense in depth only — the
 * per-category limits below are authoritative and stricter.
 */
export const EVIDENCE_BUCKET_FILE_SIZE_LIMIT_BYTES = 104_857_600

const MB = 1024 * 1024

/** Contract §7.3. */
export const EVIDENCE_MAX_SIZE_DEFAULT_BYTES = 20 * MB
export const EVIDENCE_MAX_SIZE_VIDEO_BYTES = 100 * MB

const PDF_ONLY = ['application/pdf'] as const
const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const
const VIDEO_MIMES = ['video/mp4'] as const
const DEFAULT_MIMES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] as const

/** Contract §7.3: the declared MIME selects permitted extensions, never the reverse. */
const EXTENSIONS_BY_MIME: Record<string, readonly string[]> = {
  'application/pdf': ['pdf'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'image/webp': ['webp'],
  'video/mp4': ['mp4'],
}

export function allowedMimeTypesForCategory(
  category: EvidenceRequestCategory,
): readonly string[] {
  switch (category) {
    case 'coa':
      return PDF_ONLY
    case 'inventory_photo':
      return IMAGE_MIMES
    case 'inventory_video':
      return VIDEO_MIMES
    default:
      return DEFAULT_MIMES
  }
}

export function isEvidenceMimeAllowed(
  category: EvidenceRequestCategory,
  mime: string | null | undefined,
): boolean {
  if (!mime) return false
  return allowedMimeTypesForCategory(category).includes(mime)
}

/**
 * Contract §7.3. Only `inventory_video` + `video/mp4` earns the 100 MB limit;
 * everything else is 20 MB. Mirrors `evidence_max_size_bytes` exactly, including
 * its behaviour for a category/MIME pair that is not actually allowed — the MIME
 * allow-list is what rejects those, not the size function.
 */
export function evidenceMaxSizeBytes(
  category: EvidenceRequestCategory,
  mime: string | null | undefined,
): number {
  return category === 'inventory_video' && mime === 'video/mp4'
    ? EVIDENCE_MAX_SIZE_VIDEO_BYTES
    : EVIDENCE_MAX_SIZE_DEFAULT_BYTES
}

/**
 * Contract §7.3, mirroring `evidence_filename_extension_allowed`. Conjunctive:
 * the category must permit the MIME AND the filename's FINAL extension must be
 * one that MIME permits.
 *
 * Only the last suffix counts, so `report.pdf.exe` is rejected for a PDF while
 * `report.exe.pdf` is accepted — what a consumer dispatches on is the final
 * extension. A value containing a path separator is rejected outright rather
 * than trimmed, so a traversal attempt is never silently reinterpreted.
 */
export function isEvidenceFilenameAllowed(
  category: EvidenceRequestCategory,
  mime: string | null | undefined,
  filename: string | null | undefined,
): boolean {
  if (!filename) return false
  if (filename.trim() === '') return false
  if (/[/\\]/.test(filename)) return false
  if (!/\.[A-Za-z0-9]+$/.test(filename)) return false
  if (!isEvidenceMimeAllowed(category, mime)) return false
  const extension = filename.replace(/^.*\./, '').toLowerCase()
  return (EXTENSIONS_BY_MIME[mime as string] ?? []).includes(extension)
}

export type EvidenceUploadRejection =
  | { ok: true }
  | { ok: false; code: 'FILE_TYPE_NOT_ALLOWED' | 'FILE_TOO_LARGE'; message: string }

/**
 * The single client-side pre-flight for one candidate file. Returns the same
 * error codes the database raises, so the UI renders one message set whether the
 * refusal came from here or from the RPC.
 */
export function validateEvidenceUploadCandidate(input: {
  category: EvidenceRequestCategory
  filename: string
  mimeType: string
  sizeBytes: number
}): EvidenceUploadRejection {
  const { category, filename, mimeType, sizeBytes } = input

  if (!isEvidenceMimeAllowed(category, mimeType)) {
    return {
      ok: false,
      code: 'FILE_TYPE_NOT_ALLOWED',
      message: `This request category accepts ${allowedMimeTypesForCategory(category).join(', ')}.`,
    }
  }
  if (!isEvidenceFilenameAllowed(category, mimeType, filename)) {
    return {
      ok: false,
      code: 'FILE_TYPE_NOT_ALLOWED',
      message: 'The file name extension does not match the file type.',
    }
  }
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return { ok: false, code: 'FILE_TOO_LARGE', message: 'The file is empty.' }
  }
  const max = evidenceMaxSizeBytes(category, mimeType)
  if (sizeBytes > max) {
    return {
      ok: false,
      code: 'FILE_TOO_LARGE',
      message: `Maximum size for this category is ${Math.floor(max / MB)} MB.`,
    }
  }
  return { ok: true }
}

/**
 * Contract §7.2. Built by `reserve_evidence_attachment` server-side; reproduced
 * here ONLY so tests and the UI can assert the reservation matches what they
 * expect. The client never chooses a path — it uploads to the path the RPC
 * returned. Sanitization mirrors the migration's `regexp_replace`.
 */
export function sanitizeEvidenceFilename(filename: string): string {
  const sanitized = (filename || 'file').replace(/[^A-Za-z0-9._-]/g, '_')
  return sanitized.length === 0 ? 'file' : sanitized
}

export function evidenceObjectPath(input: {
  farmId: string
  requestId: string
  responseId: string
  attachmentId: string
  filename: string
}): string {
  const { farmId, requestId, responseId, attachmentId, filename } = input
  return `${farmId}/${requestId}/${responseId}/${attachmentId}/${sanitizeEvidenceFilename(filename)}`
}

/**
 * Contract §7.4 step 5: the client computes SHA-256 with Web Crypto over the
 * exact bytes it uploaded, and the finalization RPC records it. This is an
 * integrity digest of what was uploaded — it is NOT a malware scan, and the
 * application must not claim scanning (§7.3, §2.2).
 */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}
