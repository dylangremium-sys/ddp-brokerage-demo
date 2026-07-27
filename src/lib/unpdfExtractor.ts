// ─── The production PDF text extractor ──────────────────────────────────────
//
// Binds the injected PdfTextExtractor contract to unpdf, a serverless-friendly
// pdf.js build that needs no worker, canvas or native module.
//
// It lives in its own module, and imports unpdf lazily, so that:
//   * serverCoaPdf.ts stays engine-free and unit-testable with a fake, and
//   * nothing pulls the PDF engine into a bundle unless it is actually called.
//
// Both the Vercel Function (api/compliance/coa-extract.ts) and the real-COA
// integration test use THIS adapter, so the code path proven locally is the one
// that runs in production.

import type { PdfTextExtractor } from './serverCoaPdf.js'

export const unpdfTextExtractor: PdfTextExtractor = async (bytes) => {
  const { extractText, getDocumentProxy } = await import('unpdf')
  const proxy = await getDocumentProxy(bytes)
  const { totalPages, text } = await extractText(proxy, { mergePages: false })
  return { totalPages, pages: Array.isArray(text) ? text : [text] }
}
