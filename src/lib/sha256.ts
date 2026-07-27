// ─── SHA-256 over Web Crypto ────────────────────────────────────────────────
//
// One hashing helper, used for both the COA document fingerprint and the
// retrieved source-version fingerprint.
//
// Web Crypto rather than node:crypto because everything under src/ is kept free
// of Node built-ins — tsconfig.app.json excludes @types/node on purpose, so
// browser code cannot reach Node APIs. crypto.subtle is present in the Vercel
// Node runtime and in browsers alike, which keeps these modules isomorphic and
// unit-testable without a Node-typed config.
//
// Async by necessity: crypto.subtle.digest returns a promise.

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copy into a plain ArrayBuffer — a Uint8Array view over a larger buffer
  // (as produced by Buffer or a subarray) would otherwise hash the wrong range.
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)

  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
