import { describe, expect, it } from 'vitest'
import { validatePhotoFile, ACCEPTED_PHOTO_MIME_TYPES, MAX_PHOTO_BYTES } from './db'

// These tests cover the validation gate, which is the part that runs BEFORE any
// network call and is therefore the part a unit test can hold to account without
// standing up a Supabase client. The upload/record functions are integration
// surface (they need storage + PostgREST) and are exercised by the disposable-PG
// and staging paths, not here.
//
// WHY THIS FILE EXISTS AT ALL: farmer photos were silently discarded on save for
// the whole life of the product — attached as base64 `data:` URLs, filtered out by
// createInventoryBatch, never uploaded anywhere, no warning shown. The regression
// that matters is not "upload broke", it is "a file was accepted and then
// quietly went nowhere". Validation is where that is now refused out loud.

function fakeFile(name: string, type: string, size: number): File {
  // Constructing a real File with a given size would mean allocating that many
  // bytes (10 MB+ per case). Size is the only property under test, so it is
  // overridden directly — File.size is a getter with no setter, hence
  // defineProperty rather than assignment.
  const file = new File(['x'], name, { type })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

describe('validatePhotoFile — accepted types', () => {
  it.each([...ACCEPTED_PHOTO_MIME_TYPES])('accepts %s', (mime) => {
    expect(validatePhotoFile(fakeFile('photo', mime, 1024))).toBeNull()
  })

  it('accepts HEIC, the iPhone default', () => {
    // Called out explicitly: dropping HEIC would reject the most common phone
    // photo on the platform most farmers use, and it would look like a bug in
    // their phone rather than a policy in our code.
    expect(validatePhotoFile(fakeFile('IMG_0001.HEIC', 'image/heic', 2_000_000))).toBeNull()
  })

  it('accepts a file exactly at the size limit', () => {
    // Boundary is inclusive: the check is `> MAX`, so MAX itself must pass. An
    // off-by-one here would reject a file the bucket would have accepted.
    expect(validatePhotoFile(fakeFile('photo.jpg', 'image/jpeg', MAX_PHOTO_BYTES))).toBeNull()
  })
})

describe('validatePhotoFile — refusals', () => {
  it('refuses SVG even though it is an image', () => {
    // The input carries accept="image/*", which admits SVG. SVG can carry script
    // and would be served from our own origin, so the allow-list exists
    // specifically to exclude it. A `startsWith('image/')` test would let it
    // through — this test is the reason the allow-list is not that.
    expect(validatePhotoFile(fakeFile('evil.svg', 'image/svg+xml', 1024))).toBe('type')
  })

  it('refuses a PDF', () => {
    expect(validatePhotoFile(fakeFile('coa.pdf', 'application/pdf', 1024))).toBe('type')
  })

  it('refuses a file with no MIME type', () => {
    // Browsers report '' for types they cannot determine. Fail closed: an unknown
    // type is not an image until proven otherwise.
    expect(validatePhotoFile(fakeFile('mystery', '', 1024))).toBe('type')
  })

  it('refuses a file one byte over the limit', () => {
    expect(validatePhotoFile(fakeFile('big.jpg', 'image/jpeg', MAX_PHOTO_BYTES + 1))).toBe('size')
  })

  it('refuses an empty file before checking its type', () => {
    // A zero-byte file uploads "successfully" and yields an unopenable object —
    // the worst outcome, because the record then claims evidence exists. Checked
    // first so the reported reason is the true one.
    expect(validatePhotoFile(fakeFile('empty.jpg', 'image/jpeg', 0))).toBe('empty')
  })

  it('reports empty rather than type for a zero-byte non-image', () => {
    expect(validatePhotoFile(fakeFile('empty.pdf', 'application/pdf', 0))).toBe('empty')
  })
})

describe('photo limits are pinned to the bucket configuration', () => {
  it('caps at 10 MiB, matching migration 37s file_size_limit', () => {
    // If these drift apart the failure is confusing rather than loud: the app
    // accepts a file the bucket then rejects, and the farmer sees a storage
    // error instead of a translated message. Pinned deliberately.
    expect(MAX_PHOTO_BYTES).toBe(10 * 1024 * 1024)
  })

  it('does not accept image/* wholesale', () => {
    expect(ACCEPTED_PHOTO_MIME_TYPES).not.toContain('image/svg+xml')
    expect(ACCEPTED_PHOTO_MIME_TYPES).not.toContain('image/gif')
  })
})
