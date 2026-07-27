// ─── Server-side PDF text extraction (Gate P0 — issue #77) ──────────────────
//
// The ONLY module that turns PDF bytes into text. It runs server-side (Vercel
// Function / Node) and never in the browser: the COA is private project
// evidence, so its bytes are read, parsed and discarded on the server, and only
// the extracted fields ever travel to a client.
//
// Responsibilities are deliberately narrow:
//   * fingerprint the exact bytes received (SHA-256)
//   * refuse anything that is not a PDF, is empty, or is larger than the cap
//   * produce per-page text so that every downstream field can cite its page
//
// It performs NO interpretation of the content — that is coaTnrAdapter.ts.
// Splitting them keeps the adapter pure and unit-testable without a PDF engine.

// Hashing uses Web Crypto rather than node:crypto so this module stays free of
// Node built-ins, matching the rest of src/ (tsconfig.app.json deliberately
// excludes @types/node so browser code cannot reach Node APIs). Web Crypto is
// available in both the Vercel Node runtime and the browser.
import { sha256Hex } from './sha256.js'

/** Hard ceiling on an accepted COA upload. Real TNR COAs are ~1.8 MB. */
export const MAX_COA_BYTES = 25 * 1024 * 1024

/** Every PDF begins with this signature. */
const PDF_MAGIC = '%PDF-'

export type PdfExtractionStatus = 'ok' | 'empty' | 'too_large' | 'not_a_pdf' | 'no_text_layer' | 'parse_failed'

export interface PdfExtractionResult {
  status: PdfExtractionStatus
  /** SHA-256 of the received bytes, present whenever any bytes were supplied. */
  documentFingerprint: string | null
  byteLength: number
  pageCount: number
  /** Per-page plain text, index 0 = page 1. Empty unless status is 'ok'. */
  pages: string[]
  /** Safe, human-readable explanation. Never contains document content. */
  message: string | null
}

/** Injected so the endpoint core can be tested without a real PDF engine. */
export type PdfTextExtractor = (bytes: Uint8Array) => Promise<{ totalPages: number; pages: string[] }>

export function fingerprintBytes(bytes: Uint8Array): Promise<string> {
  return sha256Hex(bytes)
}

function looksLikePdf(bytes: Uint8Array): boolean {
  if (bytes.length < PDF_MAGIC.length) return false
  const header = Array.from(bytes.slice(0, PDF_MAGIC.length))
    .map((b) => String.fromCharCode(b))
    .join('')
  return header === PDF_MAGIC
}

// The production extractor (backed by unpdf) is supplied by the Vercel Function
// in api/compliance/coa-extract.ts. Keeping the PDF engine out of this module
// means src/ never depends on it, and the unit tests drive a fake extractor.

/**
 * Extract per-page text from PDF bytes, failing closed on anything unexpected.
 *
 * A failure never throws: it returns a status the caller can persist and show,
 * because "this COA could not be read" is a legitimate, recordable outcome
 * rather than an error to swallow.
 */
export async function extractPdfPages(
  bytes: Uint8Array,
  extractor: PdfTextExtractor,
): Promise<PdfExtractionResult> {
  const byteLength = bytes.length

  if (byteLength === 0) {
    return {
      status: 'empty', documentFingerprint: null, byteLength: 0,
      pageCount: 0, pages: [], message: 'No document bytes were supplied.',
    }
  }

  const documentFingerprint = await fingerprintBytes(bytes)

  if (byteLength > MAX_COA_BYTES) {
    return {
      status: 'too_large', documentFingerprint, byteLength, pageCount: 0, pages: [],
      message: `Document is ${byteLength} bytes, above the ${MAX_COA_BYTES}-byte limit.`,
    }
  }

  if (!looksLikePdf(bytes)) {
    return {
      status: 'not_a_pdf', documentFingerprint, byteLength, pageCount: 0, pages: [],
      message: 'Supplied bytes are not a PDF (missing %PDF- signature).',
    }
  }

  let totalPages: number
  let pages: string[]
  try {
    const extracted = await extractor(bytes)
    totalPages = extracted.totalPages
    pages = extracted.pages
  } catch {
    // The thrown value is not inspected or logged: for a malformed PDF it can
    // embed fragments of the document, which is private evidence.
    return {
      status: 'parse_failed', documentFingerprint, byteLength, pageCount: 0, pages: [],
      message: 'The PDF could not be parsed.',
    }
  }

  const hasText = pages.some((page) => page.trim().length > 0)
  if (!hasText) {
    return {
      status: 'no_text_layer', documentFingerprint, byteLength, pageCount: totalPages, pages: [],
      message: 'The PDF has no text layer. Scanned or image-only COAs are not supported.',
    }
  }

  return {
    status: 'ok', documentFingerprint, byteLength,
    pageCount: totalPages, pages, message: null,
  }
}
